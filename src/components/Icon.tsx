/**
 * The three sidebar icons, drawn rather than typed.
 *
 * They were emoji until a notebook could carry a colour. An emoji ignores
 * `color`, so a coloured notebook could not tint its own icon, and the stock
 * glyphs read as cartoonish against a dark sidebar. These take `currentColor`,
 * which is what lets one rule in the stylesheet colour a whole notebook.
 */
import type { NodeKind } from "../lib/api";

export default function Icon({ kind }: { kind: NodeKind }) {
  if (kind === "notebook") return <Notebook />;
  if (kind === "section") return <Section />;
  return <PageIcon />;
}

/** A bound notebook, seen edge-on: cover, spine, and a tab sticking out. */
function Notebook() {
  return (
    <Svg>
      <path
        d="M4 2.2h7.1a1.2 1.2 0 0 1 1.2 1.2v9.2a1.2 1.2 0 0 1-1.2 1.2H4z"
        fill="currentColor"
        opacity="0.22"
      />
      <path
        d="M4 2.2h7.1a1.2 1.2 0 0 1 1.2 1.2v9.2a1.2 1.2 0 0 1-1.2 1.2H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path d="M4 2.2v11.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.3 6.2h1.5M12.3 9.8h1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </Svg>
  );
}

/** A divider tab, the thing a section is in a ring binder. */
function Section() {
  return (
    <Svg>
      <path
        d="M2.3 4.4a1.1 1.1 0 0 1 1.1-1.1h2.6l1.3 1.5h5a1.1 1.1 0 0 1 1.1 1.1v5.7a1.1 1.1 0 0 1-1.1 1.1H3.4a1.1 1.1 0 0 1-1.1-1.1z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M2.3 4.4a1.1 1.1 0 0 1 1.1-1.1h2.6l1.3 1.5h5a1.1 1.1 0 0 1 1.1 1.1v5.7a1.1 1.1 0 0 1-1.1 1.1H3.4a1.1 1.1 0 0 1-1.1-1.1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A sheet with a folded corner and a few lines of writing. */
function PageIcon() {
  return (
    <Svg>
      <path
        d="M4 2.4h4.6L12 5.8v7.8H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M8.5 2.4v3.4H12" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path
        d="M6 8.6h4M6 10.8h4"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.7"
      />
    </Svg>
  );
}

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
