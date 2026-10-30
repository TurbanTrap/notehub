import {
  useEditor,
  EditorContent,
  ReactNodeViewRenderer,
  type Editor as TipTapEditor,
} from "@tiptap/react";
import { Extension, type Attribute } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import ImageView from "./ImageView";
import SwatchMenu from "./SwatchMenu";
import { detectOs, modLabel } from "../lib/platform";
import { FONTS, HIGHLIGHTS, TEXT_COLORS, canonicalColor, fontLabel } from "../lib/textStyles";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { LANGUAGES, lowlight } from "../lib/highlight";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Page } from "../lib/api";
import { htmlToMarkdown, markdownToHtml, parentDir } from "../lib/markdown";
import { WikiLink } from "./WikiLink";
import Outline, { type OutlineItem } from "./Outline";
import LinkDialog from "./LinkDialog";
import PaneDivider from "./PaneDivider";
import {
  OUTLINE,
  readOutlineShown,
  readOutlineWidth,
  writeOutlineShown,
  writeOutlineWidth,
} from "../lib/panes";
import TagBar from "./TagBar";
import Backlinks from "./Backlinks";
import type { LinkRef } from "../lib/api";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

interface Props {
  pagePath: string;
  page: Page;
  /**
   * Changes when the open page's text has to be pushed in again without the page
   * itself changing — reloaded after a sync, or restored from history.
   */
  reloadToken: number;
  status: SaveStatus;
  onBodyChange: (markdown: string) => void;
  onTitleCommit: (title: string) => void;
  onOpenHistory: () => void;
  /** Follow a [[wiki link]]; returns false when no page of that title exists. */
  onOpenWikiLink: (title: string) => boolean;
  /** Whether a [[wiki link]] points at a page that exists, for styling. */
  resolveWikiLink: (title: string) => boolean;
  onError: (message: string) => void;
  backlinks: LinkRef[];
  onOpenPage: (path: string) => void;
  onTagsChange: (tags: string[]) => void;
  onSearchTag: (tag: string) => void;
}

/**
 * Carries back out, when the page is saved, everything the plain `![](…)` form has
 * nowhere to put: the vault-relative path, the size, and the side the text runs down.
 */
const VaultImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-rel": {
        default: null,
        parseHTML: (element) => element.getAttribute("data-rel"),
        renderHTML: (attributes) =>
          attributes["data-rel"] ? { "data-rel": attributes["data-rel"] as string } : {},
      },
      width: pixelAttribute("width"),
      height: pixelAttribute("height"),
      align: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("align");
          return value === "left" || value === "right" ? value : null;
        },
        renderHTML: (attributes) =>
          attributes.align ? { align: attributes.align as string } : {},
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      // The element that sits in the flow of the page is this outer wrapper, not the
      // one the component renders inside it, so the side the text runs down has to be
      // carried out to it. Floating only the inner element changes nothing: the outer
      // block still takes a whole line to itself and the text stays underneath.
      attrs: ({ node }) => ({ "data-align": (node.attrs.align as string) ?? "none" }),
    });
  },
});

/**
 * A size in whole pixels, written as the plain HTML attribute of the same name.
 *
 * The value comes from a file that can be edited by hand, so anything that is not a
 * positive whole number is treated as no size at all rather than passed along.
 */
function pixelAttribute(name: "width" | "height"): Attribute {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = Number.parseInt(element.getAttribute(name) ?? "", 10);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes[name] ? { [name]: String(attributes[name]) } : {},
  };
}

/**
 * The highlighter.
 *
 * The stock mark writes `color: inherit` onto the element itself, and an inline style
 * beats the stylesheet — which in the dark theme means near-white text on a pale
 * yellow, unreadable. Dropping it lets the stylesheet pin the ink dark wherever there
 * is a highlight, in both themes.
 *
 * The colour is checked going in as well as coming out. A page is a file anyone can
 * edit, so what it holds is read rather than trusted, and a colour that is not a
 * plain hex never reaches a style attribute.
 */
const Marker = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          canonicalColor(element.getAttribute("data-color")) ??
          canonicalColor(element.style.backgroundColor),
        renderHTML: (attributes) => {
          const color = canonicalColor(attributes.color as string | null);
          return color ? { "data-color": color, style: `background-color: ${color}` } : {};
        },
      },
    };
  },
});

/**
 * Enter ends the paragraph; Shift+Enter breaks the line inside it.
 *
 * The bindings go in at a priority above the lists and the code block, so that
 * whatever else a future extension brings with it, these two keys keep behaving the
 * way they do in Word and Docs — in an empty paragraph exactly as after a word.
 * `setHardBreak` reports false when it cannot apply, inside a code block where a
 * plain newline is what is wanted, and returning false there lets the usual handling
 * take over.
 *
 * The heading is the one place it does something else. A Markdown heading is a single
 * line by definition — `## Title` ends at the newline — so a break inside one cannot
 * be written to the file, and the page would come back split in two after the next
 * reload. Ending the heading is what the file would do anyway; doing it here means it
 * happens where it can be seen, rather than quietly overnight.
 */
const LineBreaks = Extension.create({
  name: "lineBreaks",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () =>
        this.editor.isActive("heading")
          ? this.editor.chain().splitBlock().setParagraph().run()
          : this.editor.commands.setHardBreak(),
    };
  },
});

/**
 * Everything the page editor understands, in one place so that anything driving an
 * editor — the page itself, a test — is working with the same set rather than a
 * copy of it that can drift.
 */
export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4] },
    // Clicking a link must not navigate the window away from the app.
    link: { openOnClick: false },
    // Replaced below by the highlighting version; leaving both in would register
    // the same node twice.
    codeBlock: false,
  }),
  CodeBlockLowlight.configure({
    lowlight,
    // Matches what marked writes and what turndown reads, so the language on a
    // fence survives a round trip through the file.
    languageClassPrefix: "language-",
    defaultLanguage: null,
  }),
  VaultImage.configure({ inline: false }),
  // Colour and font both hang off TextStyle, which is the <span> they share.
  TextStyle,
  Color,
  FontFamily,
  Marker,
  WikiLink,
  LineBreaks,
];

export default function Editor({
  pagePath,
  page,
  reloadToken,
  status,
  onBodyChange,
  onTitleCommit,
  onOpenHistory,
  onOpenWikiLink,
  resolveWikiLink,
  onError,
  backlinks,
  onOpenPage,
  onTagsChange,
  onSearchTag,
}: Props) {
  const [title, setTitle] = useState(page.title);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // Off until asked for: the outline and backlinks are worth having, but they take
  // space from the page every time it is opened, which is not what most writing wants.
  const [outlineShown, setOutlineShown] = useState(readOutlineShown);
  const [outlineWidth, setOutlineWidth] = useState(readOutlineWidth);
  const [docVersion, setDocVersion] = useState(0);
  /** True while a file is being dragged over the page, to show where it will land. */
  const [dropping, setDropping] = useState(false);
  // Only the setter is wanted: this exists to re-render on every caret move.
  const [, bumpCaret] = useState(0);

  // True while we are pushing a freshly loaded page into the editor. Without it,
  // loading a page would look like the person typing and immediately save the new
  // page's content over whatever was there.
  const loading = useRef(false);
  // The editor's own handlers are registered once, when it is created, so anything
  // they call has to be reached through a ref. A captured callback would still be
  // holding the page that was open at mount — which made following a link to a page
  // look like a no-op, because the navigation thought it was already there.
  const pagePathRef = useRef(pagePath);
  pagePathRef.current = pagePath;
  const openWikiLinkRef = useRef(onOpenWikiLink);
  openWikiLinkRef.current = onOpenWikiLink;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const readOutline = useCallback((editor: TipTapEditor) => {
    const items: OutlineItem[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        items.push({ level: node.attrs.level as number, text: node.textContent, pos });
      }
    });
    setOutline(items);
  }, []);

  const editor = useEditor({
    extensions: editorExtensions,
    content: markdownToHtml(page.body, { pageDir: parentDir(pagePath) }),
    onCreate: ({ editor }) => readOutline(editor),
    onUpdate: ({ editor }) => {
      readOutline(editor);
      setDocVersion((v) => v + 1);
      if (loading.current) return;
      onBodyChange(htmlToMarkdown(editor.getHTML()));
    },
    onSelectionUpdate: ({ editor }) => {
      // The toolbar reads the caret's surroundings as it renders, so moving the caret
      // has to cause a render. Keying that off the active heading alone missed every
      // move inside one section, which left Bold and Italic showing the wrong state
      // and kept the code block's language menu from ever appearing.
      bumpCaret((n) => n + 1);

      // Highlight the heading the caret currently sits under.
      const caret = editor.state.selection.from;
      let current: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading" && pos <= caret) current = pos;
      });
      setActiveHeading(current);
    },
    editorProps: {
      attributes: { class: "prose", spellcheck: "true" },
      // Paste only. A file dragged in from Finder or Explorer never reaches these:
      // the window layer takes the drop before the page sees it, which is why that
      // arrives through the webview's own drag-drop event further down.
      handlePaste: (_view, event) => insertPastedFiles(event.clipboardData?.files),
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;

        const anchor = target?.closest("a");
        if (anchor) {
          const href = anchor.getAttribute("href");
          if (href) {
            event.preventDefault();
            api.openExternal(href).catch((e) => onErrorRef.current(String(e)));
            return true;
          }
        }

        const wiki = target?.closest("[data-wikilink]");
        if (wiki) {
          event.preventDefault();
          const name = wiki.getAttribute("data-wikilink") ?? "";
          if (!openWikiLinkRef.current(name)) {
            onErrorRef.current(`No page called “${name}” yet.`);
          }
          return true;
        }

        return false;
      },
    },
  });

  /**
   * Copy pasted files into the vault and insert them.
   *
   * Returns true when it took the files, which tells the editor not to also paste
   * them as its own placeholder.
   */
  function insertPastedFiles(list: FileList | null | undefined): boolean {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return false;
    void storeFiles(files);
    return true;
  }

  /** Put an image that is now in the vault into the page at the caret. */
  const insertAsset = useCallback((rel: string, alt: string) => {
    const absolute = `${parentDir(pagePathRef.current)}/${rel}`;
    editorRef.current
      ?.chain()
      .focus()
      .insertContent({
        type: "image",
        attrs: { src: convertFileSrc(absolute), "data-rel": rel, alt },
      })
      .run();
  }, []);

  const storeFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const name = file.name || `pasted-${Date.now()}.${extensionFor(file.type)}`;
          const rel = await api.saveAsset(pagePathRef.current, name, bytesToBase64(bytes));
          insertAsset(rel, name);
        } catch (e) {
          onErrorRef.current(String(e));
        }
      }
    },
    [insertAsset],
  );

  /** Files dragged in from Finder or Explorer, which arrive as paths. */
  const storePaths = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        try {
          const rel = await api.addAssetFromPath(pagePathRef.current, path);
          insertAsset(rel, rel.split("/").pop() ?? "");
        } catch (e) {
          onErrorRef.current(String(e));
        }
      }
    },
    [insertAsset],
  );
  const storePathsRef = useRef(storePaths);
  storePathsRef.current = storePaths;

  // storeFiles runs from handlers bound at editor creation, when `editor` is still null.
  const editorRef = useRef<TipTapEditor | null>(null);
  editorRef.current = editor;

  // Swap in a different page. Keyed on the path and the reload token, never on the
  // body: keying on the body would reset the cursor to the top on every autosave,
  // while the token lets the page above say "this really is new text" for the two
  // cases where the path stays the same — a version arriving from another machine,
  // and a restore from history.
  useEffect(() => {
    if (!editor) return;
    loading.current = true;
    editor.commands.setContent(markdownToHtml(page.body, { pageDir: parentDir(pagePath) }), {
      emitUpdate: false,
    });
    loading.current = false;
    readOutline(editor);
    setTitle(page.title);
    setActiveHeading(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pagePath, reloadToken]);

  /*
   * Files dragged in from the desktop.
   *
   * The window takes a file drop before the page ever sees it, so the usual HTML
   * drag events never fire and the webview reports the drop itself instead. What it
   * reports is paths, not file contents, which is why the copy happens in Rust.
   *
   * The event covers the whole window, including the sidebar and the panels, so the
   * drop point is checked against the editor column before anything is written —
   * dropping a screenshot on the notebook list should do nothing, not quietly file
   * it into whichever page happens to be open.
   */
  useEffect(() => {
    let stop: UnlistenFn | undefined;
    let cancelled = false;

    const overEditor = (position: { x: number; y: number }) => {
      const scale = window.devicePixelRatio || 1;
      const element = document.elementFromPoint(position.x / scale, position.y / scale);
      return !!element && !!scrollRef.current?.contains(element);
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          setDropping(overEditor(payload.position));
          return;
        }
        if (payload.type === "drop") {
          const wanted = overEditor(payload.position);
          setDropping(false);
          if (wanted && payload.paths.length) void storePathsRef.current(payload.paths);
          return;
        }
        setDropping(false);
      })
      .then((unlisten) => {
        // Unmounted before the listener was registered: stop it straight away.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Not running inside the app window — nothing to listen to, and dropping
        // a file is not something the page can offer.
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Mark links whose page does not exist. Done over the rendered DOM rather than as a
  // node attribute, because whether a link resolves depends on the rest of the vault,
  // which is not the page's own content and must not end up saved into it.
  useEffect(() => {
    const root = editor?.view.dom;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("[data-wikilink]").forEach((el) => {
      const name = el.getAttribute("data-wikilink") ?? "";
      el.classList.toggle("wikilink-missing", !resolveWikiLink(name));
    });
  }, [editor, docVersion, pagePath, resolveWikiLink]);

  const commitTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(page.title);
      return;
    }
    if (next !== page.title) onTitleCommit(next);
  };

  const jumpTo = (pos: number) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="editor">
      <header className="editor-head">
        <input
          className="title-input"
          value={title}
          placeholder="Untitled page"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
              editor?.commands.focus("start");
            }
            if (e.key === "Escape") setTitle(page.title);
          }}
        />
        <span className={`status status-${status}`}>{statusLabel(status)}</span>
        <button
          className={`link-btn${outlineShown ? " link-btn-on" : ""}`}
          aria-pressed={outlineShown}
          title="Headings on this page, and the pages that link to it"
          onClick={() => {
            const next = !outlineShown;
            setOutlineShown(next);
            writeOutlineShown(next);
          }}
        >
          Outline
        </button>
        <button
          className="link-btn"
          title="Earlier versions of this page, kept on this machine"
          onClick={onOpenHistory}
        >
          History
        </button>
      </header>

      <TagBar tags={page.tags} onChange={onTagsChange} onSearchTag={onSearchTag} />

      {editor && (
        <Toolbar
          editor={editor}
          onLink={() => setLinkOpen(true)}
          onPickImage={() => fileInput.current?.click()}
        />
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void storeFiles(files);
          // Allow picking the same file twice in a row.
          e.target.value = "";
        }}
      />

      <div className="editor-body">
        <div
          ref={scrollRef}
          className={`editor-scroll ${dropping ? "editor-dropping" : ""}`}
          onClick={(e) => {
            // Only the margin around the text, so clicks on links are left alone.
            if (e.target === e.currentTarget) editor?.commands.focus();
          }}
        >
          <EditorContent editor={editor} />
          {dropping && <div className="drop-hint">Drop to add the image here</div>}
        </div>

        {outlineShown && (
          <>
            <PaneDivider
              side="right"
              width={outlineWidth}
              range={OUTLINE}
              label="Outline panel width"
              onWidth={setOutlineWidth}
              onSettled={writeOutlineWidth}
            />
            <div className="side-panel" style={{ width: outlineWidth }}>
              <Outline items={outline} activePos={activeHeading} onJump={jumpTo} />
              <Backlinks links={backlinks} onOpen={onOpenPage} />
            </div>
          </>
        )}
      </div>

      {linkOpen && editor && (
        <LinkDialog
          initialUrl={(editor.getAttributes("link").href as string) ?? ""}
          onApply={(url) => {
            editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            setLinkOpen(false);
          }}
          onRemove={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            setLinkOpen(false);
          }}
          onCancel={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}

function statusLabel(status: SaveStatus) {
  switch (status) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "unsaved":
      return "Unsaved changes";
    case "error":
      return "Not saved";
  }
}

function extensionFor(mime: string): string {
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  return known[mime] ?? "png";
}

/** Base64 in chunks: a large screenshot overflows the argument list in one go. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface ToolbarItem {
  label: string;
  /** Class that makes the label look like what it does — a bold B, an italic I. */
  style?: string;
  title: string;
  /** A second line in the tooltip, for anything the title cannot say in two words. */
  hint?: string;
  /** The keyboard shortcut, already written for this platform. */
  keys?: string;
  active: boolean;
  run: () => void;
}

export function Toolbar({
  editor,
  onLink,
  onPickImage,
}: {
  editor: TipTapEditor;
  onLink: () => void;
  onPickImage: () => void;
}) {
  const mod = modLabel(detectOs(navigator.userAgent));
  // One colour menu open at a time: two palettes side by side is a muddle.
  const [openMenu, setOpenMenu] = useState<"color" | "highlight" | null>(null);
  /** What was highlighted when the font menu opened — see its onMouseDown. */
  const chosen = useRef<{ from: number; to: number } | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  const heading = (level: 1 | 2 | 3) => ({
    label: `H${level}`,
    title: `Heading ${level}`,
    keys: `${mod}⌥${level}`,
    active: editor.isActive("heading", { level }),
    run: () => editor.chain().focus().toggleHeading({ level }).run(),
  });

  const groups: ToolbarItem[][] = [
    [heading(1), heading(2), heading(3)],
    [
      {
        label: "B",
        style: "tb-bold",
        title: "Bold",
        keys: `${mod}B`,
        active: editor.isActive("bold"),
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        label: "I",
        style: "tb-italic",
        title: "Italic",
        keys: `${mod}I`,
        active: editor.isActive("italic"),
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        label: "U",
        style: "tb-underline",
        title: "Underline",
        keys: `${mod}U`,
        active: editor.isActive("underline"),
        run: () => editor.chain().focus().toggleUnderline().run(),
      },
      {
        label: "S",
        style: "tb-strike",
        title: "Strikethrough",
        keys: `${mod}⇧X`,
        active: editor.isActive("strike"),
        run: () => editor.chain().focus().toggleStrike().run(),
      },
    ],
    [
      {
        label: "•",
        title: "Bulleted list",
        keys: `${mod}⇧8`,
        active: editor.isActive("bulletList"),
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        label: "1.",
        title: "Numbered list",
        keys: `${mod}⇧7`,
        active: editor.isActive("orderedList"),
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        label: "❝",
        title: "Quote",
        keys: `${mod}⇧B`,
        active: editor.isActive("blockquote"),
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
    ],
    [
      {
        label: "`",
        style: "tb-mono",
        title: "Inline code",
        keys: `${mod}E`,
        active: editor.isActive("code"),
        run: () => editor.chain().focus().toggleCode().run(),
      },
      {
        label: "{ }",
        style: "tb-mono",
        title: "Code block",
        hint: "Keeps disassembly and hex dumps intact",
        keys: `${mod}⌥C`,
        active: editor.isActive("codeBlock"),
        run: () => editor.chain().focus().toggleCodeBlock().run(),
      },
      {
        label: "—",
        title: "Divider",
        active: false,
        run: () => editor.chain().focus().setHorizontalRule().run(),
      },
    ],
    [
      {
        label: "🔗",
        title: "Link",
        keys: `${mod}K`,
        active: editor.isActive("link"),
        run: onLink,
      },
      {
        label: "🖼",
        title: "Insert image",
        hint: "You can also paste one, or drag it in from a folder",
        active: false,
        run: onPickImage,
      },
      {
        label: "[[ ]]",
        style: "tb-mono",
        title: "Link to another page",
        hint: "By its title, so the link survives a rename",
        active: editor.isActive("wikiLink"),
        run: () =>
          editor.chain().focus().insertContent({ type: "wikiLink", attrs: { target: "Page" } }).run(),
      },
    ],
  ];

  const currentFont = fontLabel(editor.getAttributes("textStyle").fontFamily as string | null);
  const currentColor = canonicalColor(editor.getAttributes("textStyle").color as string | null);
  const currentMark = canonicalColor(editor.getAttributes("highlight").color as string | null);

  return (
    <div className="toolbar" role="toolbar">
      <div className="toolbar-group">
        <select
          className="tb-font"
          aria-label="Font"
          title="Font for the selected text"
          value={currentFont}
          onMouseDown={(e) => {
            e.stopPropagation();
            // Opening a native menu takes focus out of the editor and collapses the
            // selection on the way, so the highlighted words have to be remembered
            // here, while they still exist. Without this, choosing a font for three
            // words reaches the editor as a bare caret.
            const { from, to } = editor.state.selection;
            chosen.current = { from, to };
          }}
          onChange={(e) => {
            const choice = FONTS.find((f) => f.label === e.target.value);
            const saved = chosen.current ?? editor.state.selection;
            const { from, to } = saved;
            // `focus()` puts the caret back where it was before the menu took it.
            const chain = editor.chain().focus();
            const apply = () =>
              choice ? chain.setFontFamily(choice.stack) : chain.unsetFontFamily();

            // Something was highlighted: exactly those letters change, whether that
            // is one character, a word, or several paragraphs.
            if (from !== to) {
              chain.setTextSelection({ from, to });
              apply();
              chain.run();
              return;
            }

            // Nothing was highlighted. A font would otherwise only reach text typed
            // next, so choosing one for a line already written would appear to do
            // nothing. Take the whole line instead, then put the caret back so typing
            // carries on from the same place.
            const $caret = editor.state.doc.resolve(from);
            chain.setTextSelection({ from: $caret.start(), to: $caret.end() });
            apply();
            chain.setTextSelection(from).run();
          }}
        >
          <option value="">Default font</option>
          {FONTS.map((font) => (
            <option key={font.label} value={font.label} style={{ fontFamily: font.stack }}>
              {font.label}
            </option>
          ))}
        </select>
      </div>

      {groups.map((group, i) => (
        <Fragment key={i}>
          <div className="toolbar-group">
            {group.map((item) => (
              <button
                key={item.title}
                className={`tb-btn ${item.style ?? ""} ${item.active ? "tb-active" : ""}`}
                // Not `title`: the native tooltip takes a second or more to appear and
                // is easy to miss entirely. `data-tip` drives one drawn by the
                // stylesheet, which shows at once and can carry the shortcut too.
                data-tip={item.title}
                data-keys={item.keys ?? ""}
                data-hint={item.hint ?? ""}
                aria-label={item.title}
                aria-keyshortcuts={item.keys}
                aria-pressed={item.active}
                // The editor loses focus on mousedown otherwise, and the command then
                // applies to no selection.
                onMouseDown={(e) => e.preventDefault()}
                onClick={item.run}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Right after bold and italic, where Word and Docs both keep them. */}
          {i === 1 && (
            <div className="toolbar-group">
              <SwatchMenu
                label="A"
                title="Text colour"
                swatches={TEXT_COLORS}
                current={currentColor}
                open={openMenu === "color"}
                onToggle={() => setOpenMenu(openMenu === "color" ? null : "color")}
                onClose={closeMenu}
                onPick={(value) => editor.chain().focus().setColor(value).run()}
                onClear={() => editor.chain().focus().unsetColor().run()}
                clearLabel="No colour"
              />
              <SwatchMenu
                label="▮"
                title="Highlighter"
                hint="Colours the page behind the text"
                swatches={HIGHLIGHTS}
                current={currentMark}
                open={openMenu === "highlight"}
                onToggle={() => setOpenMenu(openMenu === "highlight" ? null : "highlight")}
                onClose={closeMenu}
                onPick={(value) => editor.chain().focus().setHighlight({ color: value }).run()}
                onClear={() => editor.chain().focus().unsetHighlight().run()}
                clearLabel="No highlight"
              />
            </div>
          )}
        </Fragment>
      ))}

      {/* Only while the caret is in a code block: a language menu on a paragraph
          would be a control that does nothing. */}
      {editor.isActive("codeBlock") && (
        <div className="toolbar-group">
          <select
            className="tb-select"
            aria-label="Code language"
            title="How to colour this block"
            value={(editor.getAttributes("codeBlock").language as string) || "plaintext"}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              editor
                .chain()
                .focus()
                .updateAttributes("codeBlock", {
                  // Plain text is the absence of a language, not a language called
                  // "plaintext" — writing that into the fence would be noise in the file.
                  language: e.target.value === "plaintext" ? null : e.target.value,
                })
                .run()
            }
          >
            {LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
