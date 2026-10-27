import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./lib/api";
import type { Page, TreeNode } from "./lib/api";
import Editor, { type SaveStatus } from "./components/Editor";
import Sidebar from "./components/Sidebar";
import ConfirmDialog from "./components/ConfirmDialog";
import "./App.css";

const AUTOSAVE_DELAY_MS = 700;

export default function App() {
  const [booting, setBooting] = useState(true);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [activePath, setActivePath] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<Page | null>(null);

  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);

  // The edit waiting to be written, and the timer that will write it. Held in refs so
  // that flushing from an event handler always sees the latest value.
  const pending = useRef<{ path: string; body: string } | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const job = pending.current;
    if (!job) return;
    pending.current = null;

    setStatus("saving");
    try {
      await api.savePage(job.path, job.body);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }, []);

  const queueSave = useCallback(
    (path: string, body: string) => {
      pending.current = { path, body };
      setStatus("unsaved");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  // Don't lose the last few hundred milliseconds of typing when the window is closed
  // or hidden.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flush]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  const loadVault = useCallback(async (path: string) => {
    try {
      const nodes = await api.openVault(path);
      setVaultPath(path);
      setTree(nodes);
      // Open each notebook and its first level so the window is never a blank slate.
      const open = new Set<string>();
      for (const nb of nodes) {
        open.add(nb.path);
        for (const child of nb.children) open.add(child.path);
      }
      setExpanded(open);

      const first = findFirstPage(nodes);
      if (first) {
        const page = await api.readPage(first.path);
        setActivePath(first.path);
        setActivePage(page);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const last = await api.lastVault();
        if (last) await loadVault(last);
      } catch (e) {
        // Without this the failure is an unhandled rejection and the welcome screen
        // appears with no hint as to why the last vault did not reopen.
        setError(String(e));
      } finally {
        setBooting(false);
      }
    })();
  }, [loadVault]);

  const refreshTree = useCallback(async () => {
    if (!vaultPath) return;
    try {
      setTree(await api.readTree(vaultPath));
    } catch (e) {
      setError(String(e));
    }
  }, [vaultPath]);

  const chooseVault = async () => {
    const picked = await api.pickVault();
    if (picked) await loadVault(picked);
  };

  const selectPage = useCallback(
    async (path: string) => {
      if (path === activePath) return;
      // Write the current page before the editor's content is replaced, or the pending
      // edit would be saved against whichever page is open when the timer fires.
      await flush();
      try {
        const page = await api.readPage(path);
        setActivePath(path);
        setActivePage(page);
        setStatus("saved");

        // Open the folders leading to it, so arriving by a link does not leave the
        // sidebar pointing somewhere else.
        setExpanded((prev) => {
          const next = new Set(prev);
          const openAncestors = (nodes: TreeNode[]) => {
            for (const node of nodes) {
              if (node.kind !== "page" && path.startsWith(node.path)) {
                next.add(node.path);
                openAncestors(node.children);
              }
            }
          };
          openAncestors(tree);
          return next;
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [activePath, flush, tree],
  );

  /**
   * Page titles to paths, for `[[wiki links]]`.
   *
   * Matched case-insensitively, since nobody types a link with the capitalisation
   * they used in the title. Where two pages share a title the first found wins; the
   * link is ambiguous either way, and silently following one is better than failing.
   */
  const pageIndex = useMemo(() => {
    const index = new Map<string, string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "page") {
          const key = node.title.trim().toLowerCase();
          if (!index.has(key)) index.set(key, node.path);
        } else {
          walk(node.children);
        }
      }
    };
    walk(tree);
    return index;
  }, [tree]);

  const resolveWikiLink = useCallback(
    (title: string) => pageIndex.has(title.trim().toLowerCase()),
    [pageIndex],
  );

  const openWikiLink = useCallback(
    (title: string) => {
      const path = pageIndex.get(title.trim().toLowerCase());
      if (!path) return false;
      void selectPage(path);
      return true;
    },
    [pageIndex, selectPage],
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const addNotebook = async () => {
    if (!vaultPath) return;
    try {
      const node = await api.createNotebook(vaultPath, "New Notebook");
      await refreshTree();
      setExpanded((prev) => new Set(prev).add(node.path));
    } catch (e) {
      setError(String(e));
    }
  };

  const addSection = async (parentPath: string) => {
    try {
      const node = await api.createSection(parentPath, "New Section");
      await refreshTree();
      setExpanded((prev) => new Set(prev).add(parentPath).add(node.path));
    } catch (e) {
      setError(String(e));
    }
  };

  const addPage = async (parentPath: string) => {
    try {
      const node = await api.createPage(parentPath, "Untitled Page");
      await refreshTree();
      setExpanded((prev) => new Set(prev).add(parentPath));
      await selectPage(node.path);
    } catch (e) {
      setError(String(e));
    }
  };

  const rename = async (node: TreeNode, title: string) => {
    try {
      // A rename moves the file, so an unsaved edit has to land first.
      if (pending.current?.path === node.path) await flush();

      const updated = await api.renameItem(node.path, title);
      await refreshTree();

      if (activePath === node.path) {
        setActivePath(updated.path);
        setActivePage(await api.readPage(updated.path));
      }
      if (expanded.has(node.path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(node.path);
          next.add(updated.path);
          return next;
        });
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const confirmDelete = async () => {
    const node = pendingDelete;
    setPendingDelete(null);
    if (!node || !vaultPath) return;

    try {
      // Drop any queued write for a page that is about to go away.
      if (pending.current && isAtOrUnder(pending.current.path, node.path)) {
        pending.current = null;
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }

      await api.deleteItem(vaultPath, node.path);
      await refreshTree();

      if (activePath && isAtOrUnder(activePath, node.path)) {
        setActivePath(null);
        setActivePage(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (booting) {
    return <div className="boot">Opening NoteHub…</div>;
  }

  if (!vaultPath) {
    return (
      <div className="welcome">
        <h1>NoteHub</h1>
        <p>
          Choose a folder for your notes. Everything is saved there as plain Markdown
          files you can read, back up and sync yourself.
        </p>
        <p className="welcome-hint">
          Putting it inside iCloud Drive, Dropbox or Syncthing is what gets the same
          notes onto your other machine.
        </p>
        <button className="btn btn-primary" onClick={chooseVault}>
          Choose folder
        </button>
        {error && <p className="welcome-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">NoteHub</span>
          <button className="icon-btn" title="New notebook" onClick={addNotebook}>
            ＋
          </button>
        </div>

        <Sidebar
          tree={tree}
          activePath={activePath}
          expanded={expanded}
          onToggle={toggle}
          onSelectPage={(p) => void selectPage(p)}
          onAddSection={(p) => void addSection(p)}
          onAddPage={(p) => void addPage(p)}
          onRename={(node, title) => void rename(node, title)}
          onDelete={setPendingDelete}
        />

        <div className="sidebar-foot">
          <button
            className="link-btn"
            title={vaultPath}
            onClick={() => void api.revealVault(vaultPath)}
          >
            Show notes folder
          </button>
          <button className="link-btn" onClick={chooseVault}>
            Switch folder
          </button>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="banner">
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {activePage && activePath ? (
          <Editor
            pagePath={activePath}
            page={activePage}
            status={status}
            onBodyChange={(body) => queueSave(activePath, body)}
            onTitleCommit={(title) =>
              void rename({ kind: "page", title: activePage.title, path: activePath, children: [] }, title)
            }
            onOpenWikiLink={openWikiLink}
            resolveWikiLink={resolveWikiLink}
            onError={setError}
          />
        ) : (
          <div className="empty">
            <p>No page open.</p>
            <p className="empty-hint">Pick a page on the left, or press ＋ on a section.</p>
          </div>
        )}
      </main>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.title}”?`}
          message={
            pendingDelete.kind === "page"
              ? "It moves to the vault's trash folder, so you can still get it back from Finder."
              : "This and everything inside it moves to the vault's trash folder, so you can still get it back from Finder."
          }
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function findFirstPage(nodes: TreeNode[]): TreeNode | null {
  for (const node of nodes) {
    if (node.kind === "page") return node;
    const found = findFirstPage(node.children);
    if (found) return found;
  }
  return null;
}

/** Whether `path` is the item at `root`, or something inside it. */
function isAtOrUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const sep = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
  return path.startsWith(root + sep) || path.startsWith(root + "\\");
}
