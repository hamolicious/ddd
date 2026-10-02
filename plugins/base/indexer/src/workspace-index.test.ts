import { describe, expect, it } from "vitest";

import { row } from "./rows.test-util.js";
import { WorkspaceIndex } from "./workspace-index.js";

const A = row("A", "# A\n[to b](doc://B) [to gone](doc://Z) [to trash](doc://T)\n- [ ] one", {
  title: "A",
  tags: ["x", "y", "x"],
  status: "open",
});
const B = row("B", "# B\nnothing out", { title: "B", status: "done", project: { phase: 2 } });
const C = row(
  "C",
  "![](doc://B)",
  { title: "C", parent: "doc://A", status: "open" },
  { plugins: { folders: { children: ["A", "GONE"] } } },
);
const T = row("T", "[to a](doc://A)", { title: "T" }, { deleted: true });
const S = row("S", "settings", { machine: true, theme: "dark" });
const LONE = row("L", "alone", { title: "Lone" });

function build() {
  const index = new WorkspaceIndex();
  index.sync([A, B, C, T, S, LONE]);
  return index;
}

describe("WorkspaceIndex — documents", () => {
  it("lists live human documents by title, with the titles above them", () => {
    expect(build().documents()).toEqual([
      { id: "A", title: "A", folder: "C", machine: false },
      { id: "B", title: "B", folder: "", machine: false },
      { id: "C", title: "C", folder: "", machine: false },
      { id: "L", title: "Lone", folder: "", machine: false },
    ]);
  });

  it("adds machine-owned documents when asked", () => {
    expect(build().documents({ includeMachine: true }).map((d) => d.id)).toEqual(["A", "B", "C", "L", "S"]);
  });
});

describe("WorkspaceIndex — connections", () => {
  it("answers outgoing with each target's state", () => {
    expect(build().connections("A").outgoing).toEqual([
      { id: "B", kind: "link", count: 1, state: "live" },
      { id: "Z", kind: "link", count: 1, state: "missing" },
      { id: "T", kind: "link", count: 1, state: "trashed" },
    ]);
  });

  it("answers incoming from live documents only, by title", () => {
    const index = build();
    expect(index.connections("B").incoming).toEqual([
      { id: "A", kind: "link", count: 1 },
      { id: "C", kind: "embed", count: 1 },
    ]);
    expect(index.connections("A").incoming).toEqual([{ id: "C", kind: "frontmatter", key: "parent", count: 1 }]);
  });

  it("follows an edit: a removed link leaves the target's backlinks", () => {
    const index = build();
    const before = index.version;
    expect(index.sync([{ ...A, content: "# A\nno links", updated_at: "2026-09-02T00:00:00Z" }, B, C, T, S, LONE])).toBe(true);
    expect(index.version).toBe(before + 1);
    expect(index.connections("B").incoming.map((c) => c.id)).toEqual(["C"]);
  });

  it("does nothing when nothing moved", () => {
    const index = build();
    expect(index.sync([A, B, C, T, S, LONE])).toBe(false);
  });

  it("drops a document that left the projection", () => {
    const index = build();
    index.sync([A, C, T, S, LONE]);
    expect(index.connections("A").outgoing[0]).toMatchObject({ id: "B", state: "missing" });
  });
});

describe("WorkspaceIndex — frontmatter", () => {
  it("indexes every field of every live document, machine-owned and nested included", () => {
    const fields = build().fmFields();
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    expect(Object.keys(byKey).sort()).toEqual(
      ["machine", "parent", "project", "project.phase", "status", "tags", "theme", "title"].sort(),
    );
    expect(byKey.status).toEqual({ key: "status", count: 3, machineOnly: false, kinds: { string: 3 } });
    expect(byKey.theme?.machineOnly).toBe(true);
    expect(byKey.project?.kinds).toEqual({ map: 1 });
    expect(byKey["project.phase"]?.kinds).toEqual({ number: 1 });
    expect(fields[0]?.key).toBe("title");
  });

  it("counts values per document, list items separately", () => {
    const index = build();
    expect(index.fmValues("status")).toEqual([
      { value: "open", count: 2 },
      { value: "done", count: 1 },
    ]);
    expect(index.fmValues("tags")).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 1 },
    ]);
    expect(index.fmValues("project.phase")).toEqual([{ value: 2, count: 1 }]);
    expect(index.fmValues("nope")).toEqual([]);
  });

  it("leaves one document out when asked: the one being edited", () => {
    const index = build();
    expect(index.fmValues("status", { exclude: "C" })).toEqual([
      { value: "done", count: 1 },
      { value: "open", count: 1 },
    ]);
    expect(index.fmValues("status", { exclude: "B" })).toEqual([{ value: "open", count: 2 }]);
    const fields = index.fmFields({ exclude: "B" });
    expect(fields.find((field) => field.key === "status")).toMatchObject({ count: 2, kinds: { string: 2 } });
    expect(fields.some((field) => field.key.startsWith("project"))).toBe(false);
    expect(index.fmFields().find((field) => field.key === "status")?.count).toBe(3);
  });
});

describe("WorkspaceIndex — stats", () => {
  it("counts the human workspace by default", () => {
    expect(build().stats()).toEqual({
      documents: { live: 5, trashed: 1, machine: 1 },
      words: 12,
      characters: expect.any(Number),
      tasks: { open: 1, done: 0, other: 0 },
      connections: { total: 5, broken: 1, toTrash: 1 },
      orphans: 1,
      attachments: 0,
      folders: 1,
      fmParseErrors: 0,
      lastUpdated: "2026-09-01T00:00:00Z",
    });
  });

  it("includes machine-owned documents when asked", () => {
    const stats = build().stats({ includeMachine: true });
    expect(stats.orphans).toBe(2);
    expect(stats.words).toBe(13);
  });
});
