import { useState } from "react";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  onSearchTag: (tag: string) => void;
}

export default function TagBar({ tags, onChange, onSearchTag }: Props) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const add = () => {
    const value = draft.trim().replace(/^#+/, "").trim();
    setDraft("");
    if (!value) {
      setAdding(false);
      return;
    }
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      setAdding(false);
      return;
    }
    onChange([...tags, value]);
    // Stay open: tags are usually added two or three at a time.
  };

  return (
    <div className="tagbar">
      {tags.map((tag) => (
        <span key={tag} className="chip">
          <button
            className="chip-label"
            title={`Find pages tagged ${tag}`}
            onClick={() => onSearchTag(tag)}
          >
            {tag}
          </button>
          <button
            className="chip-x"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            ✕
          </button>
        </span>
      ))}

      {adding ? (
        <input
          className="tag-input"
          value={draft}
          placeholder="tag name"
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button className="chip chip-add" onClick={() => setAdding(true)}>
          ＋ tag
        </button>
      )}
    </div>
  );
}
