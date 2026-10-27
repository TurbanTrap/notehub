import type { LinkRef } from "../lib/api";

interface Props {
  links: LinkRef[];
  onOpen: (path: string) => void;
}

/**
 * The pages that link here with `[[this page's title]]`.
 *
 * The half of a link you cannot see from the page itself — notes on one binary spread
 * across many pages, and this is what gathers them back up.
 */
export default function Backlinks({ links, onOpen }: Props) {
  return (
    <div className="backlinks">
      <div className="outline-head">
        Linked from {links.length > 0 && <span className="count">{links.length}</span>}
      </div>
      {links.length === 0 ? (
        <p className="outline-empty">No other page links here yet.</p>
      ) : (
        <nav>
          {links.map((link) => (
            <button
              key={link.path}
              className="outline-item backlink"
              onClick={() => onOpen(link.path)}
              title={link.title}
            >
              {link.title}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
