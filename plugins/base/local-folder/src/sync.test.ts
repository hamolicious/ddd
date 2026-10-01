import { describe, expect, it } from "vitest";

import type { FolderCapability, FolderEntry, TextEdit } from "@kernel";

import { applyEdits, merge3, textEdits } from "./merge.js";
import { FolderSync, ForeignFolderError, type SyncDeps, type SyncNote } from "./sync.js";

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
      .filter(([, row]) => !row.trashed)
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

  // RENAME-HOP: a folder a pre-rename build mirrored keeps its state under `.life-manager/`.
  describe("legacy state (.life-manager/)", () => {
    /** Mirror once, then put the state where a pre-rename build kept it. */
    async function legacyFolder() {
      const t = setup();
      t.notes.add("01A", "# Home\n");
      t.notes.add("01B", "# Groceries\n\n- milk\n", "01A");
      await t.sync.run();
      for (const [path, file] of [...t.folder.files]) {
        if (!path.startsWith(".ddd/")) continue;
        t.folder.files.delete(path);
        t.folder.files.set(`.life-manager/${path.slice(".ddd/".length)}`, file);
      }
      t.folder.put(".life-manager/tmp/stray", "x");
      t.sync.reset();
      return t;
    }
    const stateFiles = (folder: MemoryFolder): string[] => [...folder.files.keys()].filter((p) => p.startsWith(".")).sort();

    it("moves the index and the bases to .ddd/ and carries on as if nothing happened", async () => {
      const { folder, sync } = await legacyFolder();
      expect(await sync.run()).toMatchObject({ written: 0, imported: 0 });
      expect(stateFiles(folder)).toEqual([".ddd/base/01A.md", ".ddd/base/01B.md", ".ddd/index.json", ".life-manager/tmp/stray"]);
      expect(folder.userPaths()).toEqual(["Home/Groceries.md", "Home/Home.md"]);
    });

    it("finishes a move cut short: bases already moved are skipped, the index goes last", async () => {
      const { folder, sync } = await legacyFolder();
      await folder.move(".life-manager/base/01A.md", ".ddd/base/01A.md");
      expect(await sync.run()).toMatchObject({ written: 0, imported: 0 });
      expect(stateFiles(folder)).toEqual([".ddd/base/01A.md", ".ddd/base/01B.md", ".ddd/index.json", ".life-manager/tmp/stray"]);
    });

    it("leaves the old state alone once .ddd/ has an index", async () => {
      const { folder, sync } = await legacyFolder();
      folder.put(".ddd/index.json", JSON.stringify({ version: 1, owner: "user-1", entries: [], dirs: [] }));
      await sync.run();
      expect(folder.text(".life-manager/index.json")).toBeDefined();
    });
  });
});
