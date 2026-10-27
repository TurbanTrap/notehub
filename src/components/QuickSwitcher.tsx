import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { SearchHit, TreeNode } from "../lib/api";
import Snippet from "./Snippet";

interface Props {
  vaultPath: string;
  pages: TreeNode[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

interface Row {
  path: string;
  title: string;
  snippet?: string;
}

const TITLE_LIMIT = 8;

/**
 * Cmd+K: jump to a page by name.
 *
 * Title matching runs locally against the page list so the list reacts on every
 * keystroke with no round trip; matches in page text come from the index a moment
 * later and are listed underneath.
 */
export default function QuickSwitcher({ vaultPath, pages, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [textHits, setTextHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const titleRows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const candidates = needle
      ? pages.filter((p) => p.title.toLowerCase().includes(needle))
      : pages;

    if (needle) {
      // A title that starts with what was typed is almost always the one wanted.
      candidates.sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.title.toLowerCase().startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.title.localeCompare(b.title);
      });
    }

    return candidates.slice(0, TITLE_LIMIT).map((p) => ({ path: p.path, title: p.title }));
  }, [pages, query]);

  const textRows = useMemo<Row[]>(() => {
    const already = new Set(titleRows.map((r) => r.path));
    return textHits
      .filter((hit) => !already.has(hit.path))
      .slice(0, 8)
      .map((hit) => ({ path: hit.path, title: hit.title, snippet: hit.snippet }));
  }, [textHits, titleRows]);

  const rows = useMemo(() => [...titleRows, ...textRows], [titleRows, textRows]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setTextHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .search(vaultPath, term, 12)
        .then((hits) => {
          if (!cancelled) setTextHits(hits);
        })
        .catch(() => {
          if (!cancelled) setTextHits([]);
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, vaultPath]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".qs-row-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    onOpen(row.path);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="switcher"
        role="dialog"
        aria-modal="true"
        aria-label="Go to page"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="switcher-input"
          value={query}
          placeholder="Go to page…"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, rows.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              choose(rows[cursor]);
            }
            if (e.key === "Escape") onClose();
          }}
        />

        <div className="switcher-list" ref={listRef}>
          {rows.length === 0 && <div className="switcher-empty">No page matches.</div>}

          {titleRows.length > 0 && <div className="switcher-group">Pages</div>}
          {titleRows.map((row, i) => (
            <button
              key={row.path}
              className={`qs-row ${cursor === i ? "qs-row-active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(row)}
            >
              <span className="qs-title">{row.title}</span>
            </button>
          ))}

          {textRows.length > 0 && <div className="switcher-group">In page text</div>}
          {textRows.map((row, i) => {
            const index = titleRows.length + i;
            return (
              <button
                key={row.path}
                className={`qs-row ${cursor === index ? "qs-row-active" : ""}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(row)}
              >
                <span className="qs-title">{row.title}</span>
                {row.snippet && <Snippet text={row.snippet} />}
              </button>
            );
          })}
        </div>

        <div className="switcher-foot">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
