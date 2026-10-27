import { useEditor, EditorContent, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Page } from "../lib/api";
import { htmlToMarkdown, markdownToHtml, parentDir } from "../lib/markdown";
import { WikiLink } from "./WikiLink";
import Outline, { type OutlineItem } from "./Outline";
import LinkDialog from "./LinkDialog";
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

/** Carries the vault-relative path back out when the page is saved. */
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
    };
  },
});

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
  const [docVersion, setDocVersion] = useState(0);

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
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        // Clicking a link must not navigate the window away from the app.
        link: { openOnClick: false },
      }),
      VaultImage.configure({ inline: false }),
      WikiLink,
    ],
    content: markdownToHtml(page.body, { pageDir: parentDir(pagePath) }),
    onCreate: ({ editor }) => readOutline(editor),
    onUpdate: ({ editor }) => {
      readOutline(editor);
      setDocVersion((v) => v + 1);
      if (loading.current) return;
      onBodyChange(htmlToMarkdown(editor.getHTML()));
    },
    onSelectionUpdate: ({ editor }) => {
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
      handlePaste: (_view, event) => insertDroppedFiles(event.clipboardData?.files),
      handleDrop: (_view, _pos, _slice, _moved) => {
        // Returning false lets ProseMirror handle text and in-document drags itself.
        return false;
      },
      handleDOMEvents: {
        drop: (_view, event) => {
          const handled = insertDroppedFiles((event as DragEvent).dataTransfer?.files);
          if (handled) event.preventDefault();
          return handled;
        },
        dragover: (_view, event) => {
          // Required for drop to fire at all.
          if ((event as DragEvent).dataTransfer?.types.includes("Files")) {
            event.preventDefault();
          }
          return false;
        },
      },
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
   * Copy pasted or dropped files into the vault and insert them.
   *
   * Returns true when it took the files, which tells the editor not to also paste
   * them as its own placeholder.
   */
  function insertDroppedFiles(list: FileList | null | undefined): boolean {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return false;
    void storeFiles(files);
    return true;
  }

  const storeFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const name = file.name || `pasted-${Date.now()}.${extensionFor(file.type)}`;
          const rel = await api.saveAsset(pagePathRef.current, name, bytesToBase64(bytes));
          const absolute = `${parentDir(pagePathRef.current)}/${rel}`;

          editorRef.current
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: convertFileSrc(absolute), "data-rel": rel, alt: name },
            })
            .run();
        } catch (e) {
          onErrorRef.current(String(e));
        }
      }
    },
    [],
  );

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
          className="editor-scroll"
          onClick={(e) => {
            // Only the margin around the text, so clicks on links are left alone.
            if (e.target === e.currentTarget) editor?.commands.focus();
          }}
        >
          <EditorContent editor={editor} />
        </div>

        <div className="side-panel">
          <Outline items={outline} activePos={activeHeading} onJump={jumpTo} />
          <Backlinks links={backlinks} onOpen={onOpenPage} />
        </div>
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

function Toolbar({
  editor,
  onLink,
  onPickImage,
}: {
  editor: TipTapEditor;
  onLink: () => void;
  onPickImage: () => void;
}) {
  const heading = (level: 1 | 2 | 3) => ({
    label: `H${level}`,
    title: `Heading ${level}`,
    active: editor.isActive("heading", { level }),
    run: () => editor.chain().focus().toggleHeading({ level }).run(),
  });

  const groups = [
    [heading(1), heading(2), heading(3)],
    [
      {
        label: "B",
        title: "Bold",
        active: editor.isActive("bold"),
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        label: "I",
        title: "Italic",
        active: editor.isActive("italic"),
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        label: "U",
        title: "Underline",
        active: editor.isActive("underline"),
        run: () => editor.chain().focus().toggleUnderline().run(),
      },
      {
        label: "S",
        title: "Strikethrough",
        active: editor.isActive("strike"),
        run: () => editor.chain().focus().toggleStrike().run(),
      },
    ],
    [
      {
        label: "•",
        title: "Bulleted list",
        active: editor.isActive("bulletList"),
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        label: "1.",
        title: "Numbered list",
        active: editor.isActive("orderedList"),
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        label: "❝",
        title: "Quote",
        active: editor.isActive("blockquote"),
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
    ],
    [
      {
        label: "`",
        title: "Inline code",
        active: editor.isActive("code"),
        run: () => editor.chain().focus().toggleCode().run(),
      },
      {
        label: "{ }",
        title: "Code block — keeps disassembly and hex dumps intact",
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
        active: editor.isActive("link"),
        run: onLink,
      },
      {
        label: "🖼",
        title: "Insert image — you can also paste or drag one in",
        active: false,
        run: onPickImage,
      },
      {
        label: "[[ ]]",
        title: "Link to another page by title",
        active: editor.isActive("wikiLink"),
        run: () =>
          editor.chain().focus().insertContent({ type: "wikiLink", attrs: { target: "Page" } }).run(),
      },
    ],
  ];

  return (
    <div className="toolbar" role="toolbar">
      {groups.map((group, i) => (
        <div className="toolbar-group" key={i}>
          {group.map((item) => (
            <button
              key={item.title}
              className={`tb-btn ${item.active ? "tb-active" : ""}`}
              title={item.title}
              aria-label={item.title}
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
      ))}
    </div>
  );
}
