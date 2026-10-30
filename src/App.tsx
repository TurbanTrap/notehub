import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./lib/api";
import type { LinkRef, Page, SearchHit, TreeNode } from "./lib/api";
import Editor, { type SaveStatus } from "./components/Editor";
import Sidebar from "./components/Sidebar";
import SearchResults from "./components/SearchResults";
import QuickSwitcher from "./components/QuickSwitcher";
import ConfirmDialog from "./components/ConfirmDialog";
import HistoryDialog from "./components/HistoryDialog";
import PaneDivider from "./components/PaneDivider";
import { SIDEBAR, readSidebarWidth, writeSidebarWidth } from "./lib/panes";
import { THEMES, applyTheme, readTheme, type Theme } from "./lib/theme";
import { detectOs, fileManager, modLabel } from "./lib/platform";
import "./App.css";

// Fixed for the life of the window, so there is nothing to keep in state.
const OS = detectOs(navigator.userAgent);
const mod = modLabel(OS);
const manager = fileManager(OS);

const AUTOSAVE_DELAY_MS = 700;
const SEARCH_DELAY_MS = 150;
/** One letter matches most of the vault; waiting for two keeps the list meaningful. */
const MIN_QUERY = 2;
/**
 * How long to let folder changes settle before acting on them.
 *
 * A sync client pulling one note in touches the file several times, and pulling a
 * folder in touches dozens. Waiting means one tree rebuild instead of thirty.
 */
const WATCH_SETTLE_MS = 300;

/** Something worth telling the person that is not an error. */
interface Notice {
  text: string;
  /** A page to offer to open — their own text, after a clash was set aside. */
  openPath?: string;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [activePath, setActivePath] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<Page | null>(null);
  /**
   * Bumped whenever the open page's text has to be pushed into the editor again
   * without the page itself changing — a reload after a sync, or a restored version.
   * The editor only swaps its content when the path changes, which is what stops
   * every autosave from throwing the cursor back to the top.
   */
  const [reloadToken, setReloadToken] = useState(0);

  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // Read straight out of storage. main.tsx has already put it on the document
  // before the first paint; this is only what the buttons read and write.
  const [theme, setTheme] = useState<Theme>(readTheme);
  /** Colour names the vault will accept, asked for once at startup. */
  const [palette, setPalette] = useState<string[]>([]);

  // Written back only when a drag ends, not on every pointer move: the pane follows
  // the cursor from state, and storage only needs the number it came to rest on.
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [backlinkList, setBacklinkList] = useState<LinkRef[]>([]);

  // The edit waiting to be written, and the timer that will write it. Held in refs so
  // that flushing from an event handler always sees the latest value. The vault goes
  // in with it, so flushing never has to reach for state that may have moved on.
  //
  // `hash` is the fingerprint of the file as it was last known to be on disk. The save
  // compares it with what is actually there, and that is what catches the other
  // machine's copy arriving while this page is open.
  const pending = useRef<{ vault: string; path: string; body: string; hash: string | null } | null>(
    null,
  );
  const timer = useRef<number | null>(null);

  // Read in callbacks that are registered once and must not close over stale state.
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;
  // The open page's fingerprint. A ref rather than state because nothing renders it,
  // and because a save has to read the value that is current at the moment it runs,
  // not the one from the render that scheduled it.
  const hashRef = useRef<string | null>(null);

  /**
   * Point a save that is already queued at the file as it now is.
   *
   * Typing during a save leaves a job holding the fingerprint from before it. Sent as
   * it stands, that job would look like a clash with a write this app had just made
   * itself, and would produce a conflict page out of nothing.
   */
  const retargetQueuedSave = useCallback((path: string, hash: string) => {
    if (pending.current?.path === path) pending.current.hash = hash;
  }, []);

  const doFlush = useCallback(async (): Promise<api.SaveResult | null> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const job = pending.current;
    if (!job) return null;
    pending.current = null;

    setStatus("saving");
    try {
      const result = await api.savePage(job.vault, job.path, job.body, job.hash);
      setStatus("saved");

      // Each save moves the file on, so the fingerprint to compare against next time
      // is the one that just came back. Without this, the save after a save would look
      // like a clash with itself.
      if (job.path === activePathRef.current) hashRef.current = result.hash;
      retargetQueuedSave(job.path, result.hash);

      if (result.conflictPath) {
        setNotice({
          text:
            "This page had already changed in your notes folder — most likely your other " +
            "machine syncing. Nothing was overwritten: your text was saved as a page of its own.",
          openPath: result.conflictPath,
        });
      }
      return result;
    } catch (e) {
      setStatus("error");
      setError(String(e));
      return null;
    }
  }, [retargetQueuedSave]);

  // Saves run one at a time. Two overlapping ones would each send the fingerprint they
  // started with, and the second would look like a clash with the first — producing a
  // conflict page out of nothing but a fast typist.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const flush = useCallback((): Promise<api.SaveResult | null> => {
    const next = queue.current.then(doFlush, doFlush);
    queue.current = next;
    return next;
  }, [doFlush]);

  const queueSave = useCallback(
    (path: string, body: string) => {
      if (!vaultPath) return;
      pending.current = { vault: vaultPath, path, body, hash: hashRef.current };
      setStatus("unsaved");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush, vaultPath],
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // The colours the vault will store. Asked for rather than listed here, so the
  // swatches can never offer one `set_color` would refuse.
  useEffect(() => {
    api
      .colors()
      .then(setPalette)
      .catch(() => setPalette([]));
  }, []);

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
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush();
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  const loadVault = useCallback(async (path: string) => {
    try {
      const { tree: nodes, warnings } = await api.openVault(path);
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
        const read = await api.readPage(first.path);
        setActivePath(first.path);
        setActivePage(read.page);
        hashRef.current = read.hash;
      }
      setError(null);
      // Things that went wrong without stopping the notes from opening: images that
      // cannot be shown, or a folder that cannot be watched for incoming changes.
      setNotice(warnings.length > 0 ? { text: warnings.join(" ") } : null);

      // Catches notes that arrived from the other machine through a sync folder, which
      // change on disk without this app involved. Not awaited: a cold index on a large
      // vault should not hold up the first page appearing.
      api.reindex(path).catch(() => undefined);
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
      await api.reindex(vaultPath);
    } catch (e) {
      setError(String(e));
    }
  }, [vaultPath]);

  const refreshTreeRef = useRef(refreshTree);
  refreshTreeRef.current = refreshTree;

  /** Show what is on disk now, discarding nothing — callers flush first if needed. */
  const reloadActive = useCallback(async (message?: string) => {
    const path = activePathRef.current;
    if (!path) return;
    try {
      const read = await api.readPage(path);
      setActivePage(read.page);
      hashRef.current = read.hash;
      setReloadToken((n) => n + 1);
      setStatus("saved");
      if (message) setNotice({ text: message });
    } catch {
      // The file is gone: deleted on the other machine, or moved in Finder.
      setNotice({ text: "This page is no longer in your notes folder." });
      setActivePath(null);
      setActivePage(null);
      hashRef.current = null;
    }
  }, []);

  /**
   * The open page changed on disk without this app doing it.
   *
   * With nothing unsaved, the arriving text simply replaces what is shown. With an
   * unsaved edit, the save goes first: it is the thing that compares fingerprints, and
   * it puts this machine's text in a page of its own rather than over the one that
   * arrived. Only then is the arriving version shown.
   */
  const externalChange = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;

    if (pending.current?.path === path) {
      const result = await flush();
      if (result?.conflictPath) await refreshTreeRef.current();
      await reloadActive();
      return;
    }

    await reloadActive("This page was updated from your notes folder.");
  }, [flush, reloadActive]);

  const externalChangeRef = useRef(externalChange);
  externalChangeRef.current = externalChange;

  /**
   * Act on changes the folder watcher reports.
   *
   * Changes are collected and acted on once they stop arriving, because one incoming
   * note touches its file several times and an incoming folder touches dozens.
   */
  useEffect(() => {
    const vault = vaultPath;
    if (!vault) return;

    let unlisten: (() => void) | undefined;
    let settleTimer: number | null = null;
    let cancelled = false;
    const touched = new Set<string>();
    let structural = false;

    const settle = () => {
      settleTimer = null;
      const paths = [...touched];
      const wasStructural = structural;
      touched.clear();
      structural = false;

      // A rebuilt tree reindexes as part of its work; otherwise the index still needs
      // to hear about the changed page so search does not go stale.
      if (wasStructural) void refreshTreeRef.current();
      else void api.reindex(vault).catch(() => undefined);

      const active = activePathRef.current;
      if (active && paths.includes(active)) void externalChangeRef.current();
    };

    void api
      .onVaultChange((change) => {
        for (const path of change.paths) touched.add(path);
        if (change.structural) structural = true;
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = window.setTimeout(settle, WATCH_SETTLE_MS);
      })
      .then((stop) => {
        // The vault may already have been switched by the time the listener is ready.
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      unlisten?.();
    };
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
        const read = await api.readPage(path);
        setActivePath(path);
        setActivePage(read.page);
        hashRef.current = read.hash;
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

  /** Every page in the vault, flattened, for the quick switcher. */
  const flatPages = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "page") out.push(node);
        else walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  /**
   * Page titles to paths, for `[[wiki links]]`.
   *
   * Matched case-insensitively, since nobody types a link with the capitalisation
   * they used in the title. Where two pages share a title the first found wins; the
   * link is ambiguous either way, and silently following one is better than failing.
   */
  const pageIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const page of flatPages) {
      const key = page.title.trim().toLowerCase();
      if (!index.has(key)) index.set(key, page.path);
    }
    return index;
  }, [flatPages]);

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

  // Search, debounced so a fast typist does not queue a query per keystroke.
  useEffect(() => {
    const term = query.trim();
    if (!vaultPath || term.length < MIN_QUERY) {
      setHits([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api
        .search(vaultPath, term)
        .then((found) => {
          if (cancelled) return;
          setHits(found);
          setSearching(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(String(e));
          setSearching(false);
        });
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, vaultPath]);

  // Which pages link here. Recomputed when the page changes and when the vault does,
  // since a link is made on the other page, not this one.
  useEffect(() => {
    const title = activePage?.title;
    if (!vaultPath || !title) {
      setBacklinkList([]);
      return;
    }
    let cancelled = false;
    api
      .backlinks(vaultPath, title)
      .then((found) => {
        if (!cancelled) setBacklinkList(found);
      })
      .catch(() => {
        if (!cancelled) setBacklinkList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, activePage?.title, tree]);

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
        const read = await api.readPage(updated.path);
        setActivePath(updated.path);
        setActivePage(read.page);
        hashRef.current = read.hash;
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

  const recolor = async (node: TreeNode, color: string | null) => {
    if (!vaultPath) return;
    try {
      await api.setColor(vaultPath, node.path, color);
      await refreshTree();
    } catch (e) {
      setError(String(e));
    }
  };

  const changeTags = async (tags: string[]) => {
    if (!vaultPath || !activePath) return;
    try {
      // Tags live in the same file as the text, so an unsaved edit has to land first
      // or writing them would put the older body back.
      await flush();
      const read = await api.setTags(vaultPath, activePath, tags, hashRef.current);
      setActivePage(read.page);
      hashRef.current = read.hash;
    } catch (e) {
      setError(String(e));
      // The one error worth recovering from is "the file changed underneath you", and
      // the answer to it is to show what is actually there.
      await reloadActive();
    }
  };

  const importFolder = async () => {
    if (!vaultPath) return;
    const source = await api.pickImportFolder();
    if (!source) return;

    setImporting(true);
    try {
      const summary = await api.importFolder(vaultPath, source);
      await refreshTree();
      setExpanded((prev) => new Set(prev).add(summary.notebookPath));
      setNotice({ text: describeImport(summary) });
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  };

  const restoreVersion = async (stamp: string) => {
    if (!vaultPath || !activePath) return;
    try {
      await flush();
      const read = await api.restoreVersion(vaultPath, activePath, stamp);
      setActivePage(read.page);
      hashRef.current = read.hash;
      setReloadToken((n) => n + 1);
      setHistoryOpen(false);
      setNotice({
        text: "Earlier text restored. The version you were on was kept, so this can be undone from History.",
      });
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
        hashRef.current = null;
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

  const searchMode = query.trim().length >= MIN_QUERY;

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">NoteHub</span>
          <button className="icon-btn" title="New notebook" onClick={addNotebook}>
            ＋
          </button>
        </div>

        <div className="search-box">
          <input
            className="search-input"
            value={query}
            placeholder="Search notes…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              ✕
            </button>
          )}
        </div>

        {searchMode ? (
          <SearchResults
            query={query}
            hits={hits}
            busy={searching}
            activePath={activePath}
            onOpen={(p) => void selectPage(p)}
            onTag={(tag) => setQuery(tag)}
          />
        ) : (
          <Sidebar
            tree={tree}
            activePath={activePath}
            expanded={expanded}
            palette={palette}
            onToggle={toggle}
            onSelectPage={(p) => void selectPage(p)}
            onAddSection={(p) => void addSection(p)}
            onAddPage={(p) => void addPage(p)}
            onRename={(node, title) => void rename(node, title)}
            onRecolor={(node, color) => void recolor(node, color)}
            onDelete={setPendingDelete}
          />
        )}

        <div className="sidebar-foot">
          <button className="link-btn" onClick={() => setSwitcherOpen(true)}>
            Go to page… <kbd>{mod}K</kbd>
          </button>
          <button
            className="link-btn"
            title={vaultPath}
            onClick={() => void api.revealVault(vaultPath)}
          >
            Show notes folder
          </button>
          <button className="link-btn" disabled={importing} onClick={() => void importFolder()}>
            {importing ? "Importing…" : "Import a folder…"}
          </button>
          <button className="link-btn" onClick={chooseVault}>
            Switch folder
          </button>

          <div className="theme-row">
            <div className="theme-seg" role="group" aria-label="Theme">
              {THEMES.map((option) => (
                <button
                  key={option}
                  className={theme === option ? "theme-on" : ""}
                  aria-pressed={theme === option}
                  onClick={() => setTheme(option)}
                >
                  {option === "system" ? "Auto" : option === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <PaneDivider
          side="left"
          width={sidebarWidth}
          range={SIDEBAR}
          label="Notebooks panel width"
          onWidth={setSidebarWidth}
          onSettled={writeSidebarWidth}
        />
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

        {notice && (
          <div className="banner banner-notice">
            <span>{notice.text}</span>
            {notice.openPath && (
              <button
                className="btn btn-small"
                onClick={() => {
                  const path = notice.openPath;
                  setNotice(null);
                  if (path) void selectPage(path);
                }}
              >
                Open my version
              </button>
            )}
            <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {activePage && activePath ? (
          <Editor
            pagePath={activePath}
            page={activePage}
            reloadToken={reloadToken}
            status={status}
            onBodyChange={(body) => queueSave(activePath, body)}
            onOpenHistory={() => setHistoryOpen(true)}
            onTitleCommit={(title) =>
              void rename(
                { kind: "page", title: activePage.title, path: activePath, color: null, children: [] },
                title,
              )
            }
            onOpenWikiLink={openWikiLink}
            resolveWikiLink={resolveWikiLink}
            onError={setError}
            backlinks={backlinkList}
            onOpenPage={(p) => void selectPage(p)}
            onTagsChange={(tags) => void changeTags(tags)}
            onSearchTag={(tag) => setQuery(tag)}
          />
        ) : (
          <div className="empty">
            <p>No page open.</p>
            <p className="empty-hint">Pick a page on the left, or press ＋ on a section.</p>
          </div>
        )}
      </main>

      {switcherOpen && (
        <QuickSwitcher
          vaultPath={vaultPath}
          pages={flatPages}
          onOpen={(p) => void selectPage(p)}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {historyOpen && activePath && (
        <HistoryDialog
          vaultPath={vaultPath}
          pagePath={activePath}
          onRestore={(stamp) => void restoreVersion(stamp)}
          onClose={() => setHistoryOpen(false)}
          onError={setError}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.title}”?`}
          message={
            pendingDelete.kind === "page"
              ? `It moves to the vault's trash folder, so you can still get it back from ${manager}.`
              : `This and everything inside it moves to the vault's trash folder, so you can still get it back from ${manager}.`
          }
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/** What the import actually did, in a sentence. */
function describeImport(summary: api.ImportSummary): string {
  const parts = [`${count(summary.pages, "page")} into “${summary.notebookTitle}”`];
  if (summary.sections > 0) parts.push(count(summary.sections, "section"));
  if (summary.links > 0) parts.push(`${count(summary.links, "link")} turned into wiki links`);
  if (summary.images > 0) parts.push(`${count(summary.images, "image")} copied in`);

  let text = `Imported ${parts.join(", ")}.`;
  if (summary.skipped.length > 0) {
    text += ` Skipped ${summary.skipped.length}: ${summary.skipped.slice(0, 3).join("; ")}.`;
  }
  return text;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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
