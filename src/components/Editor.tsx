import { useEditor, EditorContent, type Editor as TipTapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import type { Page } from "../lib/api";
import { htmlToMarkdown, markdownToHtml } from "../lib/markdown";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

interface Props {
  pagePath: string;
  page: Page;
  status: SaveStatus;
  onBodyChange: (markdown: string) => void;
  onTitleCommit: (title: string) => void;
}

export default function Editor({ pagePath, page, status, onBodyChange, onTitleCommit }: Props) {
  const [title, setTitle] = useState(page.title);

  // True while we are pushing a freshly loaded page into the editor. Without it,
  // loading a page would look like the person typing and immediately save the new
  // page's content over whatever was there.
  const loading = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        // Clicking a link must not navigate the window away from the app.
        link: { openOnClick: false },
      }),
    ],
    content: markdownToHtml(page.body),
    onUpdate: ({ editor }) => {
      if (loading.current) return;
      onBodyChange(htmlToMarkdown(editor.getHTML()));
    },
    editorProps: {
      attributes: { class: "prose", spellcheck: "true" },
    },
  });

  // Swap in a different page. Keyed on the path alone: keying on the body as well
  // would reset the cursor to the top on every autosave.
  useEffect(() => {
    if (!editor) return;
    loading.current = true;
    editor.commands.setContent(markdownToHtml(page.body), { emitUpdate: false });
    loading.current = false;
    setTitle(page.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pagePath]);

  const commitTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(page.title);
      return;
    }
    if (next !== page.title) onTitleCommit(next);
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
      </header>

      {editor && <Toolbar editor={editor} />}

      <div className="editor-scroll" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
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

function Toolbar({ editor }: { editor: TipTapEditor }) {
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
