import type { SearchHit } from "../lib/api";
import Snippet from "./Snippet";

interface Props {
  query: string;
  hits: SearchHit[];
  busy: boolean;
  activePath: string | null;
  onOpen: (path: string) => void;
  onTag: (tag: string) => void;
}

export default function SearchResults({ query, hits, busy, activePath, onOpen, onTag }: Props) {
  if (hits.length === 0) {
    return (
      <div className="results-empty">
        {busy ? "Searching…" : `Nothing matches “${query}”.`}
      </div>
    );
  }

  return (
    <div className="results">
      <div className="results-count">
        {hits.length} {hits.length === 1 ? "page" : "pages"}
      </div>
      {hits.map((hit) => (
        <button
          key={hit.path}
          className={`result ${activePath === hit.path ? "result-active" : ""}`}
          onClick={() => onOpen(hit.path)}
        >
          <span className="result-title">{hit.title}</span>
          <Snippet text={hit.snippet} />
          {hit.tags.length > 0 && (
            <span className="result-tags">
              {hit.tags.map((tag) => (
                <span
                  key={tag}
                  className="chip chip-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTag(tag);
                  }}
                >
                  {tag}
                </span>
              ))}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
