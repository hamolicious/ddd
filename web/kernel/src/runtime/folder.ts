/**
 * `kernel.capabilities.folder` — one user-chosen directory on this device (kernel 2.2.0).
 *
 * Three implementations behind one interface:
 *
 * - **Shell** (`window.shell.folder`, `app/BRIDGE.md` §4.5): a real path the shell
 *   remembers and watches. Changes arrive as the `ddd-folder-changed` window event.
 * - **Browser** (File System Access API, Chromium only): a directory handle kept in
 *   IndexedDB. The grant does not survive a reload on its own, so the state comes back as
 *   `needs-permission` until a click calls `reconnect()`. Nothing reports outside edits
 *   unless the experimental `FileSystemObserver` exists; callers rescan instead.
 * - **Unavailable**: everything else, including Firefox, Safari and WebKitGTK.
 *
 * Paths are checked here as well as in the shell, so a plugin bug cannot reach outside
 * the directory in a browser either.
 */

import {
  CapabilityUnavailableError,
  type CapabilitySupport,
  type FolderCapability,
  type FolderEntry,
  type FolderStatus,
} from "@kernel";
import { FOLDER_CHANGED_EVENT, type ShellFolder } from "./shell-bridge.js";

/** An error carrying one of the bridge's codes (`app/BRIDGE.md` §2), whatever raised it. */
export function folderError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * The segments of a relative path, or a thrown `invalid` error. Empty segments from a
 * doubled or trailing slash are dropped; `.`, `..` and absolute paths are refused.
 */
export function pathSegments(path: string): string[] {
  if (typeof path !== "string" || path.length === 0) throw folderError("invalid", "empty path");
  if (path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path) || path.includes("\0")) {
    throw folderError("invalid", `not a relative path: ${path}`);
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw folderError("invalid", "empty path");
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw folderError("invalid", `path climbs out: ${path}`);
  }
  return segments;
}

function subscribeWindow(listener: (paths: readonly string[]) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<{ paths?: unknown }>).detail;
    const paths = Array.isArray(detail?.paths)
      ? detail.paths.filter((path): path is string => typeof path === "string")
      : [];
    listener(paths);
  };
  window.addEventListener(FOLDER_CHANGED_EVENT, handler);
  return () => window.removeEventListener(FOLDER_CHANGED_EVENT, handler);
}

/** Base64 without `Buffer`: the bridge is JSON-only. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The capability where nothing can serve it. Every call rejects; `status` says `none`. */
export class UnavailableFolder implements FolderCapability {
  readonly support: CapabilitySupport = "unavailable";
  readonly watches = false;

  #fail(): Promise<never> {
    return Promise.reject(
      new CapabilityUnavailableError("folder", "this platform cannot keep a folder (no shell, no File System Access API)"),
    );
  }

  status(): Promise<FolderStatus> {
    return Promise.resolve({ state: "none" });
  }
  choose(): Promise<FolderStatus> {
    return this.#fail();
  }
  reconnect(): Promise<FolderStatus> {
    return this.#fail();
  }
  forget(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<readonly FolderEntry[]> {
    return this.#fail();
  }
  read(): Promise<{ bytes: Uint8Array; mtimeMs: number }> {
    return this.#fail();
  }
  write(): Promise<{ mtimeMs: number }> {
    return this.#fail();
  }
  move(): Promise<void> {
    return this.#fail();
  }
  remove(): Promise<void> {
    return this.#fail();
  }
  onChange(): () => void {
    return () => undefined;
  }
}

/** The shell's folder. Every method is required: a half-implemented folder is none. */
export class ShellFolderCapability implements FolderCapability {
  readonly support: CapabilitySupport = "native";
  readonly watches = true;

  constructor(private readonly bridge: Required<ShellFolder>) {}

  static from(bridge: ShellFolder | undefined): ShellFolderCapability | undefined {
    if (bridge === undefined) return undefined;
    const methods = ["current", "choose", "forget", "list", "read", "write", "move", "remove"] as const;
    return methods.every((name) => typeof bridge[name] === "function")
      ? new ShellFolderCapability(bridge as Required<ShellFolder>)
      : undefined;
  }

  async status(): Promise<FolderStatus> {
    const current = await this.bridge.current.call(this.bridge);
    return current !== null && typeof current?.label === "string"
      ? { state: "ready", label: current.label }
      : { state: "none" };
  }

  async choose(): Promise<FolderStatus> {
    const chosen = await this.bridge.choose.call(this.bridge);
    return { state: "ready", label: chosen.label };
  }

  /** A shell never loses its grant; this is `status`. */
  reconnect(): Promise<FolderStatus> {
    return this.status();
  }

  async forget(): Promise<void> {
    await this.bridge.forget.call(this.bridge);
  }

  async list(): Promise<readonly FolderEntry[]> {
    const entries = await this.bridge.list.call(this.bridge);
    return Array.isArray(entries) ? entries : [];
  }

  async read(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number }> {
    pathSegments(path);
    const file = await this.bridge.read.call(this.bridge, { path });
    return { bytes: fromBase64(file.data), mtimeMs: file.mtimeMs };
  }

  async write(path: string, bytes: Uint8Array): Promise<{ mtimeMs: number }> {
    pathSegments(path);
    const written = await this.bridge.write.call(this.bridge, { path, data: toBase64(bytes) });
    return { mtimeMs: written.mtimeMs };
  }

  async move(from: string, to: string): Promise<void> {
    pathSegments(from);
    pathSegments(to);
    await this.bridge.move.call(this.bridge, { from, to });
  }

  async remove(path: string): Promise<void> {
    pathSegments(path);
    await this.bridge.remove.call(this.bridge, { path });
  }

  onChange(listener: (paths: readonly string[]) => void): () => void {
    return subscribeWindow(listener);
  }
}

// ---------------------------------------------------------------------------
// Browser: the File System Access API
// ---------------------------------------------------------------------------

/** The slice of the File System Access API used here; lib.dom does not type all of it. */
interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  entries(): AsyncIterableIterator<[string, DirectoryHandle | FileHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>;
  move?(parent: DirectoryHandle, name: string): Promise<void>;
}

type PickerWindow = { showDirectoryPicker?: (options?: { id?: string; mode?: "readwrite" }) => Promise<DirectoryHandle> };

const HANDLE_DB = "ddd:folder";
const HANDLE_STORE = "handles";
const HANDLE_KEY = "root";

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function handleStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const open = indexedDB.open(HANDLE_DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(HANDLE_STORE);
  const db = await idbRequest(open);
  return db.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE);
}

export class BrowserFolder implements FolderCapability {
  readonly support: CapabilitySupport = "fallback";
  readonly watches = false;
  #root: DirectoryHandle | undefined;
  #loaded = false;

  /** `undefined` when this browser has no directory picker. */
  static create(): BrowserFolder | undefined {
    if (typeof window === "undefined" || typeof indexedDB === "undefined") return undefined;
    if (typeof (window as PickerWindow).showDirectoryPicker !== "function") return undefined;
    // A cookie session is required too: the API does not exist in insecure contexts.
    if (!window.isSecureContext) return undefined;
    return new BrowserFolder();
  }

  async #handle(): Promise<DirectoryHandle | undefined> {
    if (this.#loaded) return this.#root;
    try {
      const store = await handleStore("readonly");
      this.#root = (await idbRequest(store.get(HANDLE_KEY))) as DirectoryHandle | undefined;
    } catch {
      this.#root = undefined;
    }
    this.#loaded = true;
    return this.#root;
  }

  async #ready(): Promise<DirectoryHandle> {
    const root = await this.#handle();
    if (root === undefined) throw folderError("unsupported", "no folder is chosen");
    if ((await root.queryPermission?.({ mode: "readwrite" })) !== "granted") {
      throw folderError("denied", "the browser needs permission for the folder again");
    }
    return root;
  }

  async status(): Promise<FolderStatus> {
    const root = await this.#handle();
    if (root === undefined) return { state: "none" };
    const permission = await root.queryPermission?.({ mode: "readwrite" });
    return { state: permission === "granted" ? "ready" : "needs-permission", label: root.name };
  }

  async choose(): Promise<FolderStatus> {
    let root: DirectoryHandle;
    try {
      root = await (window as PickerWindow).showDirectoryPicker!({ id: "ddd", mode: "readwrite" });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw folderError("cancelled", "no folder was chosen");
      throw error;
    }
    const store = await handleStore("readwrite");
    await idbRequest(store.put(root, HANDLE_KEY));
    this.#root = root;
    this.#loaded = true;
    return { state: "ready", label: root.name };
  }

  async reconnect(): Promise<FolderStatus> {
    const root = await this.#handle();
    if (root === undefined) return { state: "none" };
    const permission = await root.requestPermission?.({ mode: "readwrite" });
    return { state: permission === "granted" ? "ready" : "needs-permission", label: root.name };
  }

  async forget(): Promise<void> {
    const store = await handleStore("readwrite");
    await idbRequest(store.delete(HANDLE_KEY));
    this.#root = undefined;
    this.#loaded = true;
  }

  async list(): Promise<readonly FolderEntry[]> {
    const root = await this.#ready();
    const entries: FolderEntry[] = [];
    const walk = async (dir: DirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        if (handle.kind === "directory") {
          entries.push({ path, kind: "dir", size: 0, mtimeMs: 0 });
          await walk(handle, path);
        } else {
          // A `.crswap` is Chromium's in-flight write; it is not the user's file.
          if (name.endsWith(".crswap")) continue;
          const file = await handle.getFile();
          entries.push({ path, kind: "file", size: file.size, mtimeMs: file.lastModified });
        }
      }
    };
    await walk(root, "");
    return entries;
  }

  async #parent(path: string, create: boolean): Promise<[DirectoryHandle, string]> {
    const segments = pathSegments(path);
    let dir = await this.#ready();
    for (const segment of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return [dir, segments[segments.length - 1]!];
  }

  async read(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number }> {
    const [dir, name] = await this.#parent(path, false);
    const file = await (await dir.getFileHandle(name)).getFile();
    return { bytes: new Uint8Array(await file.arrayBuffer()), mtimeMs: file.lastModified };
  }

  async write(path: string, bytes: Uint8Array): Promise<{ mtimeMs: number }> {
    const [dir, name] = await this.#parent(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    // Chromium writes to a swap file and renames on `close()`: atomic from the outside.
    const writable = await handle.createWritable();
    await writable.write(bytes.slice().buffer as ArrayBuffer);
    await writable.close();
    return { mtimeMs: (await handle.getFile()).lastModified };
  }

  async move(from: string, to: string): Promise<void> {
    const [fromDir, fromName] = await this.#parent(from, false);
    const [toDir, toName] = await this.#parent(to, true);
    const handle = await fromDir.getFileHandle(fromName);
    if (typeof handle.move === "function") {
      await handle.move(toDir, toName);
      return;
    }
    const { bytes } = await this.read(from);
    await this.write(to, bytes);
    await fromDir.removeEntry(fromName);
  }

  async remove(path: string): Promise<void> {
    try {
      const [dir, name] = await this.#parent(path, false);
      await dir.removeEntry(name);
    } catch (error) {
      if ((error as { name?: string }).name === "NotFoundError") return;
      throw error;
    }
  }

  onChange(): () => void {
    return () => undefined;
  }
}
