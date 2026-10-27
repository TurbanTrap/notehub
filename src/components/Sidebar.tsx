import { useState } from "react";
import type { TreeNode } from "../lib/api";

interface Props {
  tree: TreeNode[];
  activePath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelectPage: (path: string) => void;
  onAddSection: (parentPath: string) => void;
  onAddPage: (parentPath: string) => void;
  onRename: (node: TreeNode, title: string) => void;
  onDelete: (node: TreeNode) => void;
}

export default function Sidebar(props: Props) {
  return (
    <nav className="tree" aria-label="Notebooks">
      {props.tree.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} {...props} />
      ))}
    </nav>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  expanded,
  onToggle,
  onSelectPage,
  onAddSection,
  onAddPage,
  onRename,
  onDelete,
  ...rest
}: Props & { node: TreeNode; depth: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const isPage = node.kind === "page";
  const isOpen = expanded.has(node.path);
  const isActive = activePath === node.path;

  const commitRename = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== node.title) onRename(node, next);
  };

  return (
    <div className="tree-branch">
      <div
        className={`row row-${node.kind} ${isActive ? "row-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isPage ? (
          <span className="twisty-spacer" />
        ) : (
          <button
            className="twisty"
            onClick={() => onToggle(node.path)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            aria-expanded={isOpen}
          >
            {isOpen ? "▾" : "▸"}
          </button>
        )}

        <span className="row-icon" aria-hidden="true">
          {node.kind === "notebook" ? "📕" : node.kind === "section" ? "📂" : "📄"}
        </span>

        {draft !== null ? (
          <input
            className="row-rename"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setDraft(null);
            }}
          />
        ) : (
          <button
            className="row-label"
            onClick={() => (isPage ? onSelectPage(node.path) : onToggle(node.path))}
            onDoubleClick={() => setDraft(node.title)}
            title={node.title}
          >
            {node.title}
          </button>
        )}

        <span className="row-actions">
          {!isPage && (
            <button
              className="icon-btn"
              title="New page in this section"
              onClick={() => onAddPage(node.path)}
            >
              ＋
            </button>
          )}
          <button
            className="icon-btn"
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
          >
            ⋯
          </button>
        </span>

        {menuOpen && (
          <>
            <div className="menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
            <div className="menu" role="menu">
              {!isPage && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onAddSection(node.path);
                  }}
                >
                  New {node.kind === "notebook" ? "section" : "subsection"}
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(node.title);
                }}
              >
                Rename
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(node);
                }}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>

      {!isPage && isOpen && (
        <div className="tree-children">
          {node.children.length === 0 && (
            <div className="row-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 + 20 }}>
              Empty
            </div>
          )}
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              onToggle={onToggle}
              onSelectPage={onSelectPage}
              onAddSection={onAddSection}
              onAddPage={onAddPage}
              onRename={onRename}
              onDelete={onDelete}
              {...rest}
            />
          ))}
        </div>
      )}
    </div>
  );
}
