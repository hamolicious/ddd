/**
 * The folder mirror's engine: one pass reads the folder, the index and the notes, and
 * brings the three into line. It never runs twice at once, and it is written against
 * {@link SyncDeps} rather than the kernel so the tests can drive it with fakes.
 *
 * ## State, kept in the folder
 *
 * `.life-manager/index.json` maps each note id to its file and to the content hashes both
 * sides had when they last agreed; `.life-manager/base/<id>.md` is that agreed text, the
 * base of a three-way merge. Keeping them in the folder is what makes a reinstall, or a
 * second device pointed at a synced copy, pick up where it left off instead of importing
 * everything as new notes.
 *
 * ## One pass
 *
 * 1. **Disk → app.** A file whose size or mtime moved is read and hashed; a changed one
 *    edits its note (a line diff, so the CRDT merges it with anything typed meanwhile),
 *    or merges three-way when the note changed too. A missing file whose bytes turn up
 *    elsewhere is a move or a rename; one that is gone sends its note to Trash. A new
 *    file becomes a note (or an attachment), filed in the note that owns its directory.
 * 2. **App → disk.** Every note is placed by `mapping.ts`; a changed note is written, a
 *    renamed or refiled one is moved, a deleted one's file is removed.
 *
 * Whatever step 1 just did to a note is **pinned** for a few seconds: the app's copy of
 * a title, a parent or the text lags an edit by a debounce, and without the pin step 2
 * would read the old value back and undo the user's change on disk.
 */

import { applyEdits, merge3 } from "./merge.js";
import {
  NOTE_EXT,
  basename,
  depth,
  dirname,
  isIgnored,
  joinPath,
  layout,
  nameMatchesTitle,
  splitExt,
  type Placement,
} from "./mapping.js";

import type { FolderCapability, FolderEntry, TextEdit } from "@kernel";

export const STATE_DIR = ".life-manager";
const INDEX_PATH = `${STATE_DIR}/index.json`;
const basePath = (id: string): string => `${STATE_DIR}/base/${id}${NOTE_EXT}`;

/** How long a note the disk just changed is left where the disk put it. */
const PIN_MS = 5_000;

/** A pass that would trash more than this share of the mirror asks first. */
const MASS_DELETE_SHARE = 0.5;
const MASS_DELETE_MIN = 5;

export interface SyncNote {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  /** `""` at the root. */
  readonly parent: string;
  /** Set on an attachment's wrapper note: the attachment id. */
  readonly attachment?: string;
}

export interface SyncDeps {
  readonly folder: FolderCapability;
  /**
   * Who the folder belongs to — the signed-in account, which also pins the server (ids
   * are never shared between servers). A folder another account wrote is refused rather
   * than merged into this workspace.
   */
  readonly owner: string;
  notes(): Promise<readonly SyncNote[]>;
  /**
   * Turn the note from `from` into `to`, as line edits the CRDT can merge. If the note is
   * no longer `from` (typed into since), the change is merged into what it is now.
   * Resolves with the note's text afterwards.
   */
  updateNote(id: string, from: string, to: string): Promise<string>;
  /** The edits that set `title` in the note's frontmatter. */
  titleEdits(text: string, title: string): readonly TextEdit[];
  resolveTitle(text: string): string;
  createNote(text: string): Promise<string>;
  trashNote(id: string): Promise<void>;
  /** Put the note under `parent` (`""` root). */
  fileNote(id: string, parent: string): Promise<void>;
  /** `undefined` when the upload cannot happen now (offline); tried again next pass. */
  upload(bytes: Uint8Array, name: string): Promise<{ id: string; attachment: string; revision: number } | undefined>;
  download(attachment: string): Promise<{ bytes: Uint8Array; revision: number } | undefined>;
  /** `"conflict"` when the server's revision moved on; `undefined` when offline. */
  replace(
    attachment: string,
    bytes: Uint8Array,
    name: string,
    revision: number,
  ): Promise<{ revision: number } | "conflict" | undefined>;
  revision(attachment: string): Promise<number | undefined>;
  now(): number;
  sha(bytes: Uint8Array): Promise<string>;
}

interface Entry {
  id: string;
  kind: "note" | "file";
  path: string;
  /** The directory a note with children owns. */
  dir?: string;
  /** What is on disk, as last seen. */
  sha: string;
  size: number;
  mtimeMs: number;
  /** The note's text hash both sides last agreed on (notes only). */
  appSha?: string;
  attachment?: string;
  revision?: number;
}

interface IndexFile {
  version: 1;
  owner: string;
  entries: Entry[];
  /** Directories the mirror made, so it only ever removes its own. */
  dirs: string[];
}

export interface PassReport {
  readonly written: number;
  readonly imported: number;
  readonly conflicts: readonly string[];
  /** Files gone from disk that were left alone because there were too many. */
  readonly heldDeletes: number;
}

export class ForeignFolderError extends Error {
  constructor(readonly owner: string) {
    super("This folder is kept in step with another account or server. Choose an empty folder, or this account's own.");
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the server does to text on the way in (SPEC §3.1): no BOM, LF only. */
export function normalizeText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function conflictName(path: string, date: Date): string {
  const [stem, ext] = splitExt(basename(path));
  const day = date.toISOString().slice(0, 10);
  return joinPath(dirname(path), `${stem} (conflict ${day})${ext}`);
}

export class FolderSync {
  #index: IndexFile | undefined;
  readonly #pins = new Map<string, { until: number; place: Placement }>();
  #allowMassDelete = false;

  constructor(private readonly deps: SyncDeps) {}

  /** Forget the cached index, e.g. after the folder changed. */
  reset(): void {
    this.#index = undefined;
    this.#pins.clear();
    this.#allowMassDelete = false;
  }

  /** The user said the missing files really are gone: trash their notes on the next pass. */
  allowMassDelete(): void {
    this.#allowMassDelete = true;
  }

  /** The user said the missing files should come back: write them again from the notes. */
  async restoreMissing(): Promise<void> {
    const index = await this.#loadIndex();
    const present = new Set((await this.deps.folder.list()).map((entry) => entry.path));
    index.entries = index.entries.filter((entry) => present.has(entry.path));
    await this.#saveIndex(index);
  }

  async #loadIndex(): Promise<IndexFile> {
    if (this.#index) return this.#index;
    let index: IndexFile | undefined;
    try {
      const { bytes } = await this.deps.folder.read(INDEX_PATH);
      const parsed = JSON.parse(decoder.decode(bytes)) as Partial<IndexFile>;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        index = {
          version: 1,
          owner: typeof parsed.owner === "string" ? parsed.owner : this.deps.owner,
          entries: parsed.entries,
          dirs: Array.isArray(parsed.dirs) ? parsed.dirs : [],
        };
      }
    } catch {
      // No index yet: a new folder, or one this plugin never wrote to.
    }
    index ??= { version: 1, owner: this.deps.owner, entries: [], dirs: [] };
    if (index.owner !== this.deps.owner) throw new ForeignFolderError(index.owner);
    this.#index = index;
    return index;
  }

  async #saveIndex(index: IndexFile): Promise<void> {
    await this.deps.folder.write(INDEX_PATH, encoder.encode(`${JSON.stringify(index, null, 1)}\n`));
  }

  async #readBase(id: string): Promise<string | undefined> {
    try {
      return decoder.decode((await this.deps.folder.read(basePath(id))).bytes);
    } catch {
      return undefined;
    }
  }

  async #writeBase(id: string, text: string): Promise<void> {
    await this.deps.folder.write(basePath(id), encoder.encode(text));
  }

  async #dropBase(id: string): Promise<void> {
    await this.deps.folder.remove(basePath(id)).catch(() => undefined);
  }

  #pin(id: string, place: Placement): void {
    this.#pins.set(id, { until: this.deps.now() + PIN_MS, place });
  }

  #pinned(id: string): boolean {
    const pin = this.#pins.get(id);
    if (!pin) return false;
    if (pin.until > this.deps.now()) return true;
    this.#pins.delete(id);
    return false;
  }

  async #textSha(text: string): Promise<string> {
    return this.deps.sha(encoder.encode(text));
  }

  /** One pass. `full` also asks the server whether any attachment was replaced. */
  async run(full = false): Promise<PassReport> {
    const { deps } = this;
    const folder = deps.folder;
    const index = await this.#loadIndex();
    let dirty = false;
    let written = 0;
    let imported = 0;
    const conflicts: string[] = [];

    const listing = await folder.list();
    const files = new Map<string, FolderEntry>();
    for (const entry of listing) {
      if (entry.kind === "file" && !isIgnored(entry.path)) files.set(entry.path, entry);
    }
    const onDisk = (path: string): boolean => files.has(path);
    const noteWrite = async (path: string, bytes: Uint8Array): Promise<Pick<Entry, "sha" | "size" | "mtimeMs">> => {
      const { mtimeMs } = await folder.write(path, bytes);
      files.set(path, { path, kind: "file", size: bytes.byteLength, mtimeMs });
      written += 1;
      return { sha: await deps.sha(bytes), size: bytes.byteLength, mtimeMs };
    };

    let notes = await deps.notes();
    let byId = new Map(notes.map((note) => [note.id, note]));
    const byEntryId = new Map(index.entries.map((entry) => [entry.id, entry]));
    const dirOwner = new Map<string, string>([["", ""]]);
    for (const entry of index.entries) if (entry.dir !== undefined) dirOwner.set(entry.dir, entry.id);

    const removeEntry = async (entry: Entry): Promise<void> => {
      index.entries = index.entries.filter((e) => e !== entry);
      byEntryId.delete(entry.id);
      if (entry.dir !== undefined && dirOwner.get(entry.dir) === entry.id) dirOwner.delete(entry.dir);
      await this.#dropBase(entry.id);
      dirty = true;
    };

    // ------------------------------------------------------------------ disk → app

    const claimed = new Set<string>();
    const missing: Entry[] = [];
    const changed: { entry: Entry; bytes: Uint8Array; sha: string; stat: FolderEntry }[] = [];
    for (const entry of index.entries) {
      const stat = files.get(entry.path);
      if (!stat) {
        missing.push(entry);
        continue;
      }
      claimed.add(entry.path);
      if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) continue;
      const { bytes } = await folder.read(entry.path);
      const sha = await deps.sha(bytes);
      if (sha === entry.sha) {
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
        dirty = true;
      } else {
        changed.push({ entry, bytes, sha, stat });
      }
    }

    const untracked: { path: string; bytes: Uint8Array; sha: string; stat: FolderEntry }[] = [];
    for (const [path, stat] of files) {
      if (claimed.has(path)) continue;
      const { bytes } = await folder.read(path);
      untracked.push({ path, bytes, sha: await deps.sha(bytes), stat });
    }

    // Moves: a missing file whose bytes turned up somewhere new. Folder notes first, and
    // shallow before deep, so a directory's owner has moved before its children look for it.
    const byDepth = <T extends { path: string }>(list: T[], folderFirst: (item: T) => boolean): T[] =>
      list.sort((a, b) => depth(a.path) - depth(b.path) || Number(folderFirst(b)) - Number(folderFirst(a)));
    const moves: { entry: Entry; to: (typeof untracked)[number] }[] = [];
    const gone: Entry[] = [];
    for (const entry of byDepth(missing, (e) => e.dir !== undefined)) {
      const isNote = entry.kind === "note";
      const candidates = untracked.filter(
        (file) => file.sha === entry.sha && file.path.endsWith(NOTE_EXT) === isNote,
      );
      const to =
        candidates.find((file) => basename(file.path) === basename(entry.path)) ??
        candidates.find((file) => dirname(file.path) === dirname(entry.path)) ??
        candidates[0];
      if (to) {
        moves.push({ entry, to });
        untracked.splice(untracked.indexOf(to), 1);
      } else {
        gone.push(entry);
      }
    }

    /** The note that owns `dir`, creating folder notes for directories the app has never seen. */
    const ensureDir = async (dir: string): Promise<string> => {
      const known = dirOwner.get(dir);
      if (known !== undefined) return known;
      const parent = await ensureDir(dirname(dir));
      const name = basename(dir);
      const text = applyEdits("", deps.titleEdits("", name));
      const id = await deps.createNote(text);
      await deps.fileNote(id, parent);
      const path = joinPath(dir, `${name}${NOTE_EXT}`);
      const bytes = encoder.encode(text);
      const entry: Entry = { id, kind: "note", path, dir, ...(await noteWrite(path, bytes)), appSha: await this.#textSha(text) };
      index.entries.push(entry);
      byEntryId.set(id, entry);
      dirOwner.set(dir, id);
      await this.#writeBase(id, text);
      this.#pin(id, { path, dir });
      dirty = true;
      imported += 1;
      return id;
    };

    for (const { entry, to } of moves) {
      const note = byId.get(entry.id);
      if (!note) {
        await removeEntry(entry);
        untracked.push(to);
        continue;
      }
      const oldPath = entry.path;
      let parentDir = dirname(to.path);
      let name = entry.kind === "note" ? splitExt(basename(to.path))[0] : basename(to.path);
      if (entry.dir !== undefined) {
        if (basename(to.path) === basename(oldPath) && dirname(to.path) !== entry.dir) {
          // `Old/Old.md` → `New/Old.md`: the directory was renamed or moved, not the file.
          if (dirOwner.get(entry.dir) === entry.id) dirOwner.delete(entry.dir);
          entry.dir = dirname(to.path);
          dirOwner.set(entry.dir, entry.id);
          parentDir = dirname(entry.dir);
          name = basename(entry.dir);
        } else if (dirname(to.path) === entry.dir) {
          // Renamed in place inside its own directory: still the directory's note.
          parentDir = dirname(entry.dir);
        } else {
          if (dirOwner.get(entry.dir) === entry.id) dirOwner.delete(entry.dir);
          delete entry.dir;
        }
      }
      const parent = await ensureDir(parentDir);
      if (note.parent !== parent) await deps.fileNote(entry.id, parent);
      if (!nameMatchesTitle(name, note.title) && !(entry.dir !== undefined && nameMatchesTitle(basename(entry.dir), note.title))) {
        await deps.updateNote(entry.id, note.content, applyEdits(note.content, deps.titleEdits(note.content, name)));
      }
      entry.path = to.path;
      entry.size = to.stat.size;
      entry.mtimeMs = to.stat.mtimeMs;
      claimed.add(to.path);
      this.#pin(entry.id, { path: entry.path, ...(entry.dir !== undefined ? { dir: entry.dir } : {}) });
      dirty = true;
    }

    for (const { entry, bytes, sha, stat } of changed) {
      const note = byId.get(entry.id);
      if (!note) {
        // Edited on disk after the note went to Trash: it comes back as a new note.
        await removeEntry(entry);
        untracked.push({ path: entry.path, bytes, sha, stat });
        continue;
      }
      if (entry.kind === "file") {
        const result = await deps.replace(entry.attachment ?? "", bytes, basename(entry.path), entry.revision ?? 0);
        if (result === undefined) continue; // offline: the stale stat keeps it "changed"
        if (result === "conflict") {
          const copy = conflictName(entry.path, new Date(deps.now()));
          await noteWrite(copy, bytes);
          conflicts.push(copy);
          const fresh = await deps.download(entry.attachment ?? "");
          if (fresh) {
            Object.assign(entry, await noteWrite(entry.path, fresh.bytes), { revision: fresh.revision });
          }
        } else {
          Object.assign(entry, { sha, size: stat.size, mtimeMs: stat.mtimeMs, revision: result.revision });
        }
        dirty = true;
        continue;
      }

      const text = normalizeText(decoder.decode(bytes));
      const current = note.content;
      let final: string;
      if ((await this.#textSha(current)) === entry.appSha || current === text) {
        final = text;
      } else {
        const base = (await this.#readBase(entry.id)) ?? current;
        const merged = merge3(base, current, text);
        if (merged.clean) {
          final = merged.text;
        } else {
          final = current;
          const copy = conflictName(entry.path, new Date(deps.now()));
          await noteWrite(copy, bytes);
          conflicts.push(copy);
        }
      }
      if (final !== current) final = await deps.updateNote(entry.id, current, final);
      if (final !== text) {
        Object.assign(entry, await noteWrite(entry.path, encoder.encode(final)));
      } else {
        Object.assign(entry, { sha, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      entry.appSha = await this.#textSha(final);
      await this.#writeBase(entry.id, final);
      this.#pin(entry.id, { path: entry.path, ...(entry.dir !== undefined ? { dir: entry.dir } : {}) });
      dirty = true;
    }

    let heldDeletes = 0;
    const massDelete =
      gone.length >= MASS_DELETE_MIN && gone.length > index.entries.length * MASS_DELETE_SHARE && !this.#allowMassDelete;
    for (const entry of gone) {
      const note = byId.get(entry.id);
      if (massDelete) {
        heldDeletes += 1;
        continue;
      }
      if (note && entry.kind === "note" && (await this.#textSha(note.content)) !== entry.appSha) {
        // Deleted on disk, edited in the app: the edit wins and the file comes back below.
        await removeEntry(entry);
        continue;
      }
      if (note) await deps.trashNote(entry.id);
      await removeEntry(entry);
    }
    if (!massDelete) this.#allowMassDelete = false;

    // New files: folder notes (`Dir/Dir.md`) before what they hold.
    for (const file of byDepth(untracked, (f) => splitExt(basename(f.path))[0] === basename(dirname(f.path)))) {
      const isNote = file.path.endsWith(NOTE_EXT);
      const dir = dirname(file.path);
      const ownsDir =
        isNote && dir !== "" && splitExt(basename(file.path))[0] === basename(dir) && !dirOwner.has(dir);
      const parent = await ensureDir(ownsDir ? dirname(dir) : dir);
      if (isNote) {
        const name = splitExt(basename(file.path))[0];
        let text = normalizeText(decoder.decode(file.bytes));
        if (!nameMatchesTitle(name, deps.resolveTitle(text))) text = applyEdits(text, deps.titleEdits(text, name));
        const id = await deps.createNote(text);
        await deps.fileNote(id, parent);
        const entry: Entry = {
          id,
          kind: "note",
          path: file.path,
          ...(ownsDir ? { dir } : {}),
          sha: file.sha,
          size: file.stat.size,
          mtimeMs: file.stat.mtimeMs,
          appSha: await this.#textSha(text),
        };
        index.entries.push(entry);
        byEntryId.set(id, entry);
        if (ownsDir) dirOwner.set(dir, id);
        await this.#writeBase(id, text);
        this.#pin(id, { path: file.path, ...(ownsDir ? { dir } : {}) });
      } else {
        const uploaded = await deps.upload(file.bytes, basename(file.path));
        if (!uploaded) continue;
        await deps.fileNote(uploaded.id, parent);
        const entry: Entry = {
          id: uploaded.id,
          kind: "file",
          path: file.path,
          sha: file.sha,
          size: file.stat.size,
          mtimeMs: file.stat.mtimeMs,
          attachment: uploaded.attachment,
          revision: uploaded.revision,
        };
        index.entries.push(entry);
        byEntryId.set(uploaded.id, entry);
        this.#pin(uploaded.id, { path: file.path });
      }
      claimed.add(file.path);
      imported += 1;
      dirty = true;
    }

    // ------------------------------------------------------------------ app → disk

    notes = await deps.notes();
    byId = new Map(notes.map((note) => [note.id, note]));
    const pins = new Map<string, Placement>();
    for (const id of [...this.#pins.keys()]) if (this.#pinned(id)) pins.set(id, this.#pins.get(id)!.place);
    const places = layout(
      notes.map((note) => ({
        id: note.id,
        title: note.title,
        parent: note.parent,
        ...(note.attachment !== undefined ? { fileName: note.title } : {}),
      })),
      pins,
    );

    // Moves before writes, shallow first, so a directory exists before what goes in it.
    const ordered = [...places].sort(([, a], [, b]) => depth(a.path) - depth(b.path));
    for (const [id, place] of ordered) {
      const entry = byEntryId.get(id);
      if (!entry || pins.has(id)) continue;
      const wantDir = place.dir;
      if (entry.path !== place.path && onDisk(entry.path) && !onDisk(place.path)) {
        await folder.move(entry.path, place.path);
        const stat = files.get(entry.path)!;
        files.delete(entry.path);
        files.set(place.path, { ...stat, path: place.path });
        entry.path = place.path;
        dirty = true;
      }
      if (entry.dir !== wantDir) {
        if (entry.dir !== undefined && dirOwner.get(entry.dir) === id) dirOwner.delete(entry.dir);
        if (wantDir !== undefined) {
          entry.dir = wantDir;
          dirOwner.set(wantDir, id);
        } else {
          delete entry.dir;
        }
        dirty = true;
      }
    }

    for (const [id, place] of ordered) {
      const note = byId.get(id)!;
      const entry = byEntryId.get(id);
      if (pins.has(id) && entry) continue;
      if (note.attachment !== undefined) {
        const stale = entry && full ? (await deps.revision(note.attachment)) !== entry.revision : false;
        if (entry && onDisk(entry.path) && !stale) continue;
        if (entry && !onDisk(entry.path) && heldDeletes > 0) continue;
        if (!entry && onDisk(place.path)) continue; // taken by a file of the user's; next pass
        const fetched = await deps.download(note.attachment);
        if (!fetched) continue;
        const path = entry?.path ?? place.path;
        const stat = await noteWrite(path, fetched.bytes);
        if (entry) {
          Object.assign(entry, stat, { revision: fetched.revision });
        } else {
          const created: Entry = { id, kind: "file", path, ...stat, attachment: note.attachment, revision: fetched.revision };
          index.entries.push(created);
          byEntryId.set(id, created);
        }
        dirty = true;
        continue;
      }

      const appSha = await this.#textSha(note.content);
      if (entry) {
        if (entry.appSha === appSha && onDisk(entry.path)) continue;
        if (!onDisk(entry.path) && heldDeletes > 0) continue;
        Object.assign(entry, await noteWrite(entry.path, encoder.encode(note.content)), { appSha });
        await this.#writeBase(id, note.content);
        dirty = true;
        continue;
      }
      if (onDisk(place.path)) continue; // a file of the user's is there; it is imported first
      const stat = await noteWrite(place.path, encoder.encode(note.content));
      const created: Entry = {
        id,
        kind: "note",
        path: place.path,
        ...(place.dir !== undefined ? { dir: place.dir } : {}),
        ...stat,
        appSha,
      };
      index.entries.push(created);
      byEntryId.set(id, created);
      if (place.dir !== undefined) dirOwner.set(place.dir, id);
      await this.#writeBase(id, note.content);
      dirty = true;
    }

    // Notes deleted in the app (or no longer mirrored): their files go.
    for (const entry of [...index.entries]) {
      if (byId.has(entry.id) || this.#pinned(entry.id)) continue;
      if (onDisk(entry.path)) {
        await folder.remove(entry.path);
        files.delete(entry.path);
      }
      await removeEntry(entry);
    }

    // Directories this mirror made and no longer needs, deepest first, if they are empty.
    const wanted = new Set<string>();
    for (const place of places.values()) {
      for (let dir = dirname(place.path); dir !== ""; dir = dirname(dir)) wanted.add(dir);
    }
    const used = new Set<string>();
    for (const path of files.keys()) for (let dir = dirname(path); dir !== ""; dir = dirname(dir)) used.add(dir);
    const previous = index.dirs;
    for (const dir of [...previous].sort((a, b) => depth(b) - depth(a))) {
      if (wanted.has(dir) || used.has(dir)) continue;
      await folder.remove(dir).catch(() => undefined);
    }
    const dirs = [...wanted].sort();
    if (dirs.join("\n") !== previous.join("\n")) {
      index.dirs = dirs;
      dirty = true;
    }

    if (dirty) await this.#saveIndex(index);
    return { written, imported, conflicts, heldDeletes };
  }
}
