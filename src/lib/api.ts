/** Typed wrappers over the Rust commands. Every path is an absolute path on disk. */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type NodeKind = "notebook" | "section" | "page";

export interface TreeNode {
  kind: NodeKind;
  title: string;
  path: string;
  children: TreeNode[];
}

export interface Page {
  id: string;
  title: string;
  created: string;
  updated: string;
  tags: string[];
  body: string;
}

export const pickVault = () => invoke<string | null>("pick_vault");

export const lastVault = () => invoke<string | null>("last_vault");

/** A vault that opened, plus anything that went wrong but did not stop it opening. */
export interface OpenResult {
  tree: TreeNode[];
  warnings: string[];
}

export const openVault = (path: string) => invoke<OpenResult>("open_vault", { path });

export const readTree = (vaultPath: string) => invoke<TreeNode[]>("read_tree", { vaultPath });

export const createNotebook = (vaultPath: string, title: string) =>
  invoke<TreeNode>("create_notebook", { vaultPath, title });

export const createSection = (parentPath: string, title: string) =>
  invoke<TreeNode>("create_section", { parentPath, title });

export const createPage = (parentPath: string, title: string) =>
  invoke<TreeNode>("create_page", { parentPath, title });

/**
 * A page together with the fingerprint of the bytes it was read from.
 *
 * Hand the fingerprint back when saving: that is how the save knows whether the file
 * has changed on disk since, which it will have done if a sync client dropped the
 * other machine's copy on top of it.
 */
export interface PageRead {
  page: Page;
  hash: string;
}

export interface SaveResult {
  page: Page;
  hash: string;
  /** Set when the file had already changed; the text went here, and the page on disk
   *  was left exactly as it was found. */
  conflictPath: string | null;
}

export const readPage = (path: string) => invoke<PageRead>("read_page", { path });

export const savePage = (
  vaultPath: string,
  path: string,
  body: string,
  baseHash: string | null,
) => invoke<SaveResult>("save_page", { vaultPath, path, body, baseHash });

export const renameItem = (path: string, newTitle: string) =>
  invoke<TreeNode>("rename_item", { path, newTitle });

export const deleteItem = (vaultPath: string, path: string) =>
  invoke<void>("delete_item", { vaultPath, path });

export const revealVault = (path: string) => invoke<void>("reveal_vault", { path });

/** Store a pasted or dropped file beside the page; returns its vault-relative path. */
export const saveAsset = (pagePath: string, filename: string, dataBase64: string) =>
  invoke<string>("save_asset", { pagePath, filename, dataBase64 });

export const openExternal = (url: string) => invoke<void>("open_external", { url });

export interface SearchHit {
  path: string;
  title: string;
  /** Matched words are wrapped in \u0001 and \u0002, not HTML. */
  snippet: string;
  tags: string[];
}

export interface LinkRef {
  path: string;
  title: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export const reindex = (vaultPath: string) => invoke<number>("reindex", { vaultPath });

export const search = (vaultPath: string, query: string, limit?: number) =>
  invoke<SearchHit[]>("search", { vaultPath, query, limit });

export const backlinks = (vaultPath: string, title: string) =>
  invoke<LinkRef[]>("backlinks", { vaultPath, title });

export const allTags = (vaultPath: string) => invoke<TagCount[]>("all_tags", { vaultPath });

export const pagesWithTag = (vaultPath: string, tag: string) =>
  invoke<LinkRef[]>("pages_with_tag", { vaultPath, tag });

export const setTags = (
  vaultPath: string,
  path: string,
  tags: string[],
  baseHash: string | null,
) => invoke<PageRead>("set_tags", { vaultPath, path, tags, baseHash });

/** One kept copy of a page's earlier text. */
export interface Version {
  /** Handle used to read or restore it. */
  stamp: string;
  /** When it was taken, as RFC 3339. */
  saved: string;
  bytes: number;
}

export const pageVersions = (vaultPath: string, path: string) =>
  invoke<Version[]>("page_versions", { vaultPath, path });

export const readVersion = (vaultPath: string, path: string, stamp: string) =>
  invoke<string>("read_version", { vaultPath, path, stamp });

export const restoreVersion = (vaultPath: string, path: string, stamp: string) =>
  invoke<PageRead>("restore_version", { vaultPath, path, stamp });

/** Something in the vault changed without this app doing it. */
export interface VaultChange {
  /** Page files that changed, as absolute paths. */
  paths: string[];
  /** Whether anything appeared, vanished or was renamed, so the sidebar is stale. */
  structural: boolean;
}

export const onVaultChange = (handler: (change: VaultChange) => void): Promise<UnlistenFn> =>
  listen<VaultChange>("vault-changed", (event) => handler(event.payload));
