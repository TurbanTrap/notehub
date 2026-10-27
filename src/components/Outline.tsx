export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

interface Props {
  items: OutlineItem[];
  activePos: number | null;
  onJump: (pos: number) => void;
}

/**
 * The page's headings, as a table of contents. A long study note is mostly navigated
 * rather than read start to finish, which is the gap this fills.
 */
export default function Outline({ items, activePos, onJump }: Props) {
  if (items.length === 0) {
    return (
      <aside className="outline">
        <div className="outline-head">Outline</div>
        <p className="outline-empty">
          Headings you add with H1, H2 or H3 show up here.
        </p>
      </aside>
    );
  }

  // Indent relative to the shallowest heading used, so a note written entirely in H2
  // and H3 is not pushed off to the right for no reason.
  const base = Math.min(...items.map((i) => i.level));

  return (
    <aside className="outline">
      <div className="outline-head">Outline</div>
      <nav>
        {items.map((item) => (
          <button
            key={item.pos}
            className={`outline-item ${activePos === item.pos ? "outline-active" : ""}`}
            style={{ paddingLeft: 10 + (item.level - base) * 12 }}
            onClick={() => onJump(item.pos)}
            title={item.text}
          >
            {item.text || "Untitled heading"}
          </button>
        ))}
      </nav>
    </aside>
  );
}
