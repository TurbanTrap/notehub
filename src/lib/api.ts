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

export const savePage = (path: string, body: string) => invoke<Page>("save_page", { path, body });

export const renameItem = (path: string, newTitle: string) =>
  invoke<TreeNode>("rename_item", { path, newTitle });

export const deleteItem = (vaultPath: string, path: string) =>
  invoke<void>("delete_item", { vaultPath, path });

export const revealVault = (path: string) => invoke<void>("reveal_vault", { path });

/** Store a pasted or dropped file beside the page; returns its vault-relative path. */
export const saveAsset = (pagePath: string, filename: string, dataBase64: string) =>
  invoke<string>("save_asset", { pagePath, filename, dataBase64 });

export const openExternal = (url: string) => invoke<void>("open_external", { url });
