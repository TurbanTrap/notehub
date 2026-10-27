/** Typed wrappers over the Rust commands. Every path is an absolute path on disk. */
import { invoke } from "@tauri-apps/api/core";

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

export const openVault = (path: string) => invoke<TreeNode[]>("open_vault", { path });

export const readTree = (vaultPath: string) => invoke<TreeNode[]>("read_tree", { vaultPath });

export const createNotebook = (vaultPath: string, title: string) =>
  invoke<TreeNode>("create_notebook", { vaultPath, title });

export const createSection = (parentPath: string, title: string) =>
  invoke<TreeNode>("create_section", { parentPath, title });

export const createPage = (parentPath: string, title: string) =>
  invoke<TreeNode>("create_page", { parentPath, title });

export const readPage = (path: string) => invoke<Page>("read_page", { path });

export const savePage = (vaultPath: string, path: string, body: string) =>
  invoke<Page>("save_page", { vaultPath, path, body });

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

export const setTags = (vaultPath: string, path: string, tags: string[]) =>
  invoke<Page>("set_tags", { vaultPath, path, tags });
