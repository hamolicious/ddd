import { describe, expect, it } from "vitest";

import type { FolderCapability, FolderEntry, TextEdit } from "@kernel";

import { applyEdits, merge3, textEdits } from "./merge.js";
import { FolderSync, ForeignFolderError, replicaLoading, type SyncDeps, type SyncNote } from "./sync.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A folder in memory. Every write bumps a clock so mtimes differ like a real disk's. */
class MemoryFolder implements FolderCapability {
  readonly support = "native" as const;
  readonly watches = true;
  readonly files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  clock = 1;

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? dec.decode(file.bytes) : undefined;
  }
  put(path: string, text: string): void {
    this.files.set(path, { bytes: enc.encode(text), mtimeMs: (this.clock += 1) });
  }
  userPaths(): string[] {
    return [...this.files.keys()].filter((p) => !p.startsWith(".")).sort();
  }

  status() {
    return Promise.resolve({ state: "ready" as const, label: "mem" });
  }
  choose() {
    return this.status();
  }
  reconnect() {
    return this.status();
  }
  forget() {
    return Promise.resolve();
  }
  list(): Promise<readonly FolderEntry[]> {
    const out: FolderEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, file] of this.files) {
      out.push({ path, kind: "file", size: file.bytes.byteLength, mtimeMs: file.mtimeMs });
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const dir of dirs) out.push({ path: dir, kind: "dir", size: 0, mtimeMs: 0 });
    return Promise.resolve(out);
  }
  read(path: string) {
    const file = this.files.get(path);
    return file ? Promise.resolve({ bytes: file.bytes, mtimeMs: file.mtimeMs }) : Promise.reject(new Error(`ENOENT ${path}`));
  }
  write(path: string, bytes: Uint8Array) {
    const mtimeMs = (this.clock += 1);
    this.files.set(path, { bytes, mtimeMs });
    return Promise.resolve({ mtimeMs });
  }
  move(from: string, to: string) {
    const file = this.files.get(from);
    if (file) {
      this.files.delete(from);
      this.files.set(to, file);
    }
    return Promise.resolve();
  }
  remove(path: string) {
    this.files.delete(path);
    return Promise.resolve();
  }
  onChange() {
    return () => undefined;
  }
}

/** Notes in memory, with a title rule close enough to the core's for these tests. */
class Notes {
  readonly rows = new Map<string, { content: string; parent: string; trashed: boolean; attachment?: string }>();
  /** Notes the server has that this device's replica has not received yet. */
  readonly notArrived = new Set<string>();
  #next = 100;

  title(content: string): string {
    const fm = /^---\n(?:.*\n)*?title: (.*)\n(?:.*\n)*?---\n/.exec(content);
    if (fm) return fm[1]!;
    const heading = /^# (.*)$/m.exec(content);
    return heading ? heading[1]! : (content.split("\n").find((l) => l.trim()) ?? "Untitled");
  }
  add(id: string, content: string, parent = ""): void {
    this.rows.set(id, { content, parent, trashed: false });
  }
  live(): SyncNote[] {
    return [...this.rows]
      .filter(([id, row]) => !row.trashed && !this.notArrived.has(id))
      .map(([id, row]) => ({
        id,
        title: this.title(row.content),
        content: row.content,
        parent: row.parent,
        ...(row.attachment ? { attachment: row.attachment } : {}),
      }));
  }
  mint(): string {
    return `09${String((this.#next += 1)).padStart(4, "0")}`;
  }
}

function titleEdits(text: string, title: string): TextEdit[] {
  const fm = /^---\n([\s\S]*?)---\n/.exec(text);
  if (!fm) return [{ range: { start: 0, end: 0 }, text: `---\ntitle: ${title}\n---\n` }];
  const line = /^title: .*$/m.exec(fm[1]!);
  if (line) {
    const start = 4 + line.index;
    return [{ range: { start, end: start + line[0].length }, text: `title: ${title}` }];
  }
  return [{ range: { start: 4, end: 4 }, text: `title: ${title}\n` }];
}

function setup(owner = "user-1") {
  const folder = new MemoryFolder();
  const notes = new Notes();
  const attachments = new Map<string, { bytes: Uint8Array; revision: number }>();
  let now = 1_000_000;
  const deps: SyncDeps = {
    folder,
    owner,
    notes: () => Promise.resolve(notes.live()),
    known: (id) => Promise.resolve(notes.notArrived.has(id) ? "unknown" : "gone"),
    updateNote: (id, from, to) => {
      const row = notes.rows.get(id)!;
      if (row.content !== from) {
        const merged = merge3(from, row.content, to);
        to = merged.clean ? merged.text : to;
      }
      row.content = applyEdits(row.content, textEdits(row.content, to));
      return Promise.resolve(row.content);
    },
    titleEdits,
    resolveTitle: (text) => notes.title(text),
    createNote: (text) => {
      const id = notes.mint();
      notes.add(id, text);
      return Promise.resolve(id);
    },
    trashNote: (id) => {
      notes.rows.get(id)!.trashed = true;
      return Promise.resolve();
    },
    fileNote: (id, parent) => {
      notes.rows.get(id)!.parent = parent;
      return Promise.resolve();
    },
    upload: (bytes, name) => {
      const id = notes.mint();
      const attachment = `att-${id}`;
      attachments.set(attachment, { bytes, revision: 1 });
      notes.rows.set(id, { content: `---\ntitle: ${name}\nattachment: ${attachment}\n---\n`, parent: "", trashed: false, attachment });
      return Promise.resolve({ id, attachment, revision: 1 });
    },
    download: (attachment) => Promise.resolve(attachments.get(attachment)),
    replace: (attachment, bytes, _name, revision) => {
      const current = attachments.get(attachment)!;
      if (current.revision !== revision) return Promise.resolve("conflict" as const);
      attachments.set(attachment, { bytes, revision: revision + 1 });
      return Promise.resolve({ revision: revision + 1 });
    },
    revision: (attachment) => Promise.resolve(attachments.get(attachment)?.revision),
    now: () => now,
    sha: async (bytes) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
  };
  const sync = new FolderSync(deps);
  const later = (): void => {
    now += 60_000;
  };
  return { folder, notes, attachments, sync, later };
}

/**
 * Regression: the rename hop (2026-10-02) moved the desktop app to a new origin, whose
 * replica started empty and filled from the server. local-folder ran its first pass at
 * boot, while the replica was still filling, and read "not in the replica" as "deleted":
 * it removed the files of notes that had not arrived, and re-imported every changed or
 * moved file of such a note as a new note — a duplicate of every one of them, the newer
 * copy mirrored as `<title> (2).md`. A note this device has not received yet is unknown,
 * not gone: its entry and its file are left alone until it arrives.
 */
describe("FolderSync with a replica that has not caught up", () => {
  /** Mirror three notes, then boot a fresh app whose replica has only some of them. */
  async function freshBoot(...notArrived: string[]) {
    const t = setup();
    t.notes.add("01A", "# Alpha\n\none\n");
    t.notes.add("01B", "# Bravo\n\ntwo\n");
    t.notes.add("01C", "# Charlie\n\nthree\n");
    await t.sync.run();
    for (const id of notArrived) t.notes.notArrived.add(id);
    const fresh = new FolderSync((t.sync as unknown as { deps: SyncDeps }).deps);
    const catchUp = async () => {
      t.notes.notArrived.clear();
      return fresh.run();
    };
    const live = () => [...t.notes.rows].filter(([, row]) => !row.trashed).map(([id]) => id).sort();
    return { ...t, fresh, catchUp, live };
  }

  it("keeps the files of notes that have not arrived", async () => {
    const { folder, fresh, catchUp, live } = await freshBoot("01B", "01C");
    await fresh.run();
    expect(folder.userPaths()).toEqual(["Alpha.md", "Bravo.md", "Charlie.md"]);
    await catchUp();
    expect(folder.userPaths()).toEqual(["Alpha.md", "Bravo.md", "Charlie.md"]);
    expect(live()).toEqual(["01A", "01B", "01C"]);
  });

  it("does not re-import a changed file of a note that has not arrived; the edit reaches the note", async () => {
    const { folder, notes, fresh, catchUp, later, live } = await freshBoot("01B");
    later();
    folder.put("Bravo.md", "# Bravo\n\ntwo\nedited elsewhere\n");
    expect(await fresh.run()).toMatchObject({ imported: 0 });
    await catchUp();
    expect(live()).toEqual(["01A", "01B", "01C"]);
    expect(notes.rows.get("01B")!.content).toContain("edited elsewhere");
    expect(folder.userPaths()).toEqual(["Alpha.md", "Bravo.md", "Charlie.md"]);
  });

  it("does not re-import a moved file of a note that has not arrived", async () => {
    const { folder, fresh, catchUp, live } = await freshBoot("01B");
    await folder.move("Bravo.md", "Bravo renamed.md");
    expect(await fresh.run()).toMatchObject({ imported: 0 });
    await catchUp();
    expect(live()).toEqual(["01A", "01B", "01C"]);
  });

  it("does not import a held note's file that a folder sync deleted and put back", async () => {
    const { folder, fresh, catchUp, later, live } = await freshBoot("01B");
    const bravo = folder.text("Bravo.md")!;
    await folder.remove("Bravo.md");
    await fresh.run();
    later();
    folder.put("Bravo.md", bravo);
    expect(await fresh.run()).toMatchObject({ imported: 0 });
    await catchUp();
    expect(live()).toEqual(["01A", "01B", "01C"]);
    expect(folder.userPaths()).toEqual(["Alpha.md", "Bravo.md", "Charlie.md"]);
  });

  it("does nothing at all on a cold start with an empty replica", async () => {
    const { folder, fresh, catchUp, live } = await freshBoot("01A", "01B", "01C");
    const before = [...folder.files.entries()].map(([path, file]) => [path, file.mtimeMs]);
    expect(await fresh.run()).toMatchObject({ written: 0, imported: 0, heldDeletes: 0 });
    expect([...folder.files.entries()].map(([path, file]) => [path, file.mtimeMs])).toEqual(before);
    await catchUp();
    expect(live()).toEqual(["01A", "01B", "01C"]);
  });

  it("keeps a held note's file name from a note made meanwhile with the same title", async () => {
    const { folder, notes, fresh, catchUp } = await freshBoot("01B");
    notes.add("01D", "# Bravo\n\na different note\n");
    await fresh.run();
    expect(folder.text("Bravo.md")).toBe("# Bravo\n\ntwo\n");
    await catchUp();
    expect(folder.text("Bravo.md")).toBe("# Bravo\n\ntwo\n");
    expect(folder.text("Bravo (2).md")).toBe("# Bravo\n\na different note\n");
  });

  it("still sends a held note to Trash when its file was deleted on disk, once it arrives", async () => {
    const { folder, notes, fresh, catchUp } = await freshBoot("01B");
    await folder.remove("Bravo.md");
    await fresh.run();
    expect(notes.rows.get("01B")!.trashed).toBe(false);
    await catchUp();
    expect(notes.rows.get("01B")!.trashed).toBe(true);
  });

  it("waits out the replica's first fill", () => {
    expect(replicaLoading({ bootstrap: { rows: 10, total: 100, complete: false } })).toBe(true);
    expect(replicaLoading({ bootstrap: { rows: 100, total: 100, complete: true } })).toBe(false);
    expect(replicaLoading({})).toBe(false);
  });
});

describe("FolderSync", () => {
  it("writes every note on the first pass, folders as directories", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# Home\n");
    notes.add("01B", "# Groceries\n\n- milk\n", "01A");
    await sync.run();
    expect(folder.userPaths()).toEqual(["Home/Groceries.md", "Home/Home.md"]);
    expect(folder.text("Home/Groceries.md")).toBe("# Groceries\n\n- milk\n");
  });

  it("is quiet when nothing changed", async () => {
    const { notes, sync } = setup();
    notes.add("01A", "# Home\n");
    await sync.run();
    expect(await sync.run()).toMatchObject({ written: 0, imported: 0 });
  });

  it("carries an app edit to the file, and a file edit to the note", async () => {
    const { folder, notes, sync, later } = setup();
    notes.add("01A", "# Home\n\none\n");
    await sync.run();

    notes.rows.get("01A")!.content = "# Home\n\none\ntwo\n";
    await sync.run();
    expect(folder.text("Home.md")).toBe("# Home\n\none\ntwo\n");

    folder.put("Home.md", "# Home\n\nONE\ntwo\n");
    await sync.run();
    expect(notes.rows.get("01A")!.content).toBe("# Home\n\nONE\ntwo\n");
    later();
    expect(await sync.run()).toMatchObject({ written: 0 });
  });

  it("merges edits made on both sides to different lines", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# Home\n\none\ntwo\nthree\n");
    await sync.run();
    notes.rows.get("01A")!.content = "# Home\n\nONE\ntwo\nthree\n";
    folder.put("Home.md", "# Home\n\none\ntwo\nTHREE\n");
    await sync.run();
    expect(notes.rows.get("01A")!.content).toBe("# Home\n\nONE\ntwo\nTHREE\n");
    expect(folder.text("Home.md")).toBe("# Home\n\nONE\ntwo\nTHREE\n");
  });

  it("keeps both copies when both sides changed the same line", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# Home\n\none\n");
    await sync.run();
    notes.rows.get("01A")!.content = "# Home\n\napp\n";
    folder.put("Home.md", "# Home\n\ndisk\n");
    const report = await sync.run();
    expect(report.conflicts).toHaveLength(1);
    expect(notes.rows.get("01A")!.content).toBe("# Home\n\napp\n");
    expect(folder.text("Home.md")).toBe("# Home\n\napp\n");
    expect(folder.text(report.conflicts[0]!)).toBe("# Home\n\ndisk\n");
  });

  it("imports a new file, titled from its name, into the directory's folder note", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# Home\n");
    notes.add("01B", "# Child\n", "01A");
    await sync.run();
    folder.put("Home/Ideas.md", "some thoughts\n");
    await sync.run();
    const created = notes.live().find((n) => n.title === "Ideas");
    expect(created?.parent).toBe("01A");
    expect(created?.content).toBe("---\ntitle: Ideas\n---\nsome thoughts\n");
  });

  it("makes folder notes for new directories", async () => {
    const { folder, notes, sync, later } = setup();
    folder.put("Work/Plans/Q4.md", "# Q4\n");
    await sync.run();
    const work = notes.live().find((n) => n.title === "Work")!;
    const plans = notes.live().find((n) => n.title === "Plans")!;
    const q4 = notes.live().find((n) => n.title === "Q4")!;
    expect(plans.parent).toBe(work.id);
    expect(q4.parent).toBe(plans.id);
    later();
    await sync.run();
    expect(folder.userPaths()).toEqual(["Work/Plans/Plans.md", "Work/Plans/Q4.md", "Work/Work.md"]);
  });

  it("treats a rename on disk as a new title, and a move as refiling", async () => {
    const { folder, notes, sync, later } = setup();
    notes.add("01A", "# Home\n");
    notes.add("01B", "# Child\n", "01A");
    notes.add("01C", "# Loose\n");
    await sync.run();

    await folder.move("Loose.md", "Home/Renamed.md");
    await sync.run();
    const loose = notes.rows.get("01C")!;
    expect(loose.parent).toBe("01A");
    expect(notes.title(loose.content)).toBe("Renamed");
    later();
    // The new title is frontmatter in the note now, and the file gets it once.
    await sync.run();
    expect(folder.text("Home/Renamed.md")).toBe("---\ntitle: Renamed\n---\n# Loose\n");
    expect(await sync.run()).toMatchObject({ written: 0, imported: 0 });
    expect(folder.userPaths()).toEqual(["Home/Child.md", "Home/Home.md", "Home/Renamed.md"]);
  });

  it("treats a renamed directory as renaming its folder note, and keeps the children in it", async () => {
    const { folder, notes, sync, later } = setup();
    notes.add("01A", "# Home\n");
    notes.add("01B", "# Child\n", "01A");
    await sync.run();
    await folder.move("Home/Home.md", "House/Home.md");
    await folder.move("Home/Child.md", "House/Child.md");
    await sync.run();
    expect(notes.title(notes.rows.get("01A")!.content)).toBe("House");
    expect(notes.rows.get("01B")!.parent).toBe("01A");
    expect(notes.live()).toHaveLength(2);
    later();
    await sync.run();
    expect(folder.userPaths()).toEqual(["House/Child.md", "House/House.md"]);
  });

  it("moves the file when the note is renamed or refiled in the app", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# Home\n");
    notes.add("01B", "# Child\n", "01A");
    notes.add("01C", "# Loose\n");
    await sync.run();
    notes.rows.get("01C")!.content = "# Tidy\n";
    notes.rows.get("01C")!.parent = "01A";
    await sync.run();
    expect(folder.userPaths()).toEqual(["Home/Child.md", "Home/Home.md", "Home/Tidy.md"]);
  });

  it("sends a note to Trash when its file is deleted, and deletes the file when the note is", async () => {
    const { folder, notes, sync } = setup();
    notes.add("01A", "# One\n");
    notes.add("01B", "# Two\n");
    notes.add("01C", "# Three\n");
    await sync.run();
    await folder.remove("One.md");
    await sync.run();
    expect(notes.rows.get("01A")!.trashed).toBe(true);

    notes.rows.get("01B")!.trashed = true;
    await sync.run();
    expect(folder.userPaths()).toEqual(["Three.md"]);
  });

  it("holds a mass deletion until the user says so", async () => {
    const { folder, notes, sync } = setup();
    for (let i = 0; i < 8; i += 1) notes.add(`01${i}`, `# N${i}\n`);
    await sync.run();
    for (const path of folder.userPaths()) folder.files.delete(path);
    const report = await sync.run();
    expect(report.heldDeletes).toBe(8);
    expect(notes.live()).toHaveLength(8);

    await sync.restoreMissing();
    await sync.run();
    expect(folder.userPaths()).toHaveLength(8);
  });

  it("mirrors attachments as their bytes and uploads new files", async () => {
    const { folder, notes, attachments, sync, later } = setup();
    attachments.set("att-1", { bytes: new Uint8Array([1, 2, 3]), revision: 1 });
    notes.rows.set("01F", { content: "---\ntitle: photo.png\nattachment: att-1\n---\n", parent: "", trashed: false, attachment: "att-1" });
    await sync.run();
    expect([...folder.files.get("photo.png")!.bytes]).toEqual([1, 2, 3]);

    folder.files.set("photo.png", { bytes: new Uint8Array([9]), mtimeMs: (folder.clock += 1) });
    await sync.run();
    expect(attachments.get("att-1")).toEqual({ bytes: new Uint8Array([9]), revision: 2 });

    folder.files.set("doc.pdf", { bytes: new Uint8Array([7]), mtimeMs: (folder.clock += 1) });
    await sync.run();
    later();
    expect(notes.live().some((n) => n.title === "doc.pdf")).toBe(true);
    expect(await sync.run()).toMatchObject({ written: 0, imported: 0 });
  });

  it("refuses a folder another server wrote", async () => {
    const first = setup("user-1");
    first.notes.add("01A", "# Home\n");
    await first.sync.run();
    const second = setup("user-2");
    for (const [path, file] of first.folder.files) second.folder.files.set(path, file);
    await expect(second.sync.run()).rejects.toBeInstanceOf(ForeignFolderError);
  });
});
