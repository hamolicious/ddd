/**
 * Task scanning against fixture texts.
 *
 * Two properties are worth more than the rest of this file put together:
 *
 * 1. **The grammar matches `markdown`'s.** `plugins/base/markdown/src/tasks.ts::markerAt` is
 *    what decides whether a checkbox appears on screen; this scanner decides whether it is
 *    counted. A divergence is a number that is wrong by one and nothing that explains it, so
 *    the accepted *and* rejected cases below are deliberately the same shapes that file
 *    pins.
 * 2. **An unregistered marker is not a task** (SPEC §6.6, §11.7). It renders as literal text,
 *    so counting it would promise a checkbox that is not there — it is reported instead.
 */

import { describe, expect, it } from "vitest";

import {
  countTasks,
  groupTasks,
  normalizeFolder,
  scanTasks,
  TASK_TEXT_LIMIT,
  type TaskRow,
  type TaskStateLike,
} from "./tasks.js";

const TODO: TaskStateLike = { marker: " ", label: "To do", done: false, order: 0 };
const DONE: TaskStateLike = { marker: "x", label: "Done", done: true, order: 10 };
const PARTIAL: TaskStateLike = { marker: "/", label: "In progress", order: 5 };
const DROPPED: TaskStateLike = { marker: "-", label: "Dropped", done: true, order: 20 };

const REGISTERED = [TODO, DONE, PARTIAL, DROPPED];

const markers = (text: string, states: readonly TaskStateLike[] = REGISTERED): string[] =>
  scanTasks(text, states).map((task) => task.marker);

describe("scanTasks — the accepted shapes", () => {
  it("finds every bullet form GFM allows", () => {
    const text = ["- [ ] dash", "* [x] star", "+ [/] plus", "1. [ ] ordered dot", "2) [x] ordered paren"].join(
      "\n",
    );
    expect(markers(text)).toEqual([" ", "x", "/", " ", "x"]);
  });

  it("allows more than one space, and tabs, between the bullet and the checkbox", () => {
    const text = ["-   [ ] roomy", "-\t[x] tabbed", "\t- [ ] indented with a tab"].join("\n");
    expect(markers(text)).toEqual([" ", "x", " "]);
  });

  it("reports the line, the offset of the marker character and the indent", () => {
    const text = "# Heading\n\n- [ ] first\n  - [x] nested\n";
    const tasks = scanTasks(text, REGISTERED);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ line: 3, indent: 0, text: "first", done: false });
    expect(tasks[1]).toMatchObject({ line: 4, indent: 2, text: "nested", done: true });
    // The offset is into the whole text and points at the character between the brackets.
    expect(text[tasks[0]!.offset]).toBe(" ");
    expect(text[tasks[1]!.offset]).toBe("x");
  });

  it("takes `done` and the label from the registry, never from the character", () => {
    // `-` is registered here as a *completed* state, and `x` could have been registered as
    // open. Nothing in the scanner hard-codes either.
    const tasks = scanTasks("- [-] dropped\n- [/] halfway\n", REGISTERED);
    expect(tasks.map((task) => [task.marker, task.done, task.label])).toEqual([
      ["-", true, "Dropped"],
      ["/", false, "In progress"],
    ]);
  });

  it("strips a CRLF terminator from the task text", () => {
    const tasks = scanTasks("- [ ] milk\r\n- [x] bread\r\n", REGISTERED);
    expect(tasks.map((task) => task.text)).toEqual(["milk", "bread"]);
  });

  it("truncates a very long task and keeps an empty one", () => {
    const long = "x".repeat(TASK_TEXT_LIMIT + 50);
    const tasks = scanTasks(`- [ ] ${long}\n- [ ] \n`, REGISTERED);
    expect(tasks[0]!.text).toHaveLength(TASK_TEXT_LIMIT);
    expect(tasks[1]!.text).toBe("");
  });
});

describe("scanTasks — what is deliberately not a task", () => {
  it("needs a space or tab after the checkbox (GFM, and what `markdown` renders)", () => {
    // The exact case the module docs call out: `- [ ]` alone on a line draws no checkbox.
    expect(markers("- [ ]\n- [x]done\n")).toEqual([]);
  });

  it("needs a bullet, and a space after it", () => {
    expect(markers("[ ] no bullet\n-[x] no space\n")).toEqual([]);
  });

  it("needs exactly one character between the brackets", () => {
    expect(markers("- [] empty\n- [xx] two\n")).toEqual([]);
  });

  it("does not read a checkbox out of prose or a link", () => {
    expect(markers("See [1] for the details, and [x](https://example.test) for more.\n")).toEqual([]);
  });

  it("reports an unregistered marker but never counts it (SPEC §6.6)", () => {
    const tasks = scanTasks("- [?] unknown\n- [ ] known\n", REGISTERED);
    expect(tasks.map((task) => [task.marker, task.registered, task.done])).toEqual([
      ["?", false, false],
      [" ", true, false],
    ]);
    expect(tasks[0]!.label).toBeUndefined();
  });

  it("registers nothing at all when no state is registered", () => {
    // The markers are still *located* — the scanner's job is reporting, the registry's is
    // meaning — but none of them is a task, which is what `groupTasks` acts on.
    const tasks = scanTasks("- [ ] milk\n- [x] bread\n", []);
    expect(tasks.map((task) => task.registered)).toEqual([false, false]);
    expect(tasks.every((task) => !task.done)).toBe(true);
  });
});

describe("scanTasks — regions", () => {
  const text = [
    "---",
    "title: Groceries",
    "date: 2026-09-24",
    "---",
    "",
    "- [ ] milk",
    "",
    "%%% calendar",
    "items:",
    "- [x] a line of a plugin's YAML that happens to look like a task",
    "%%%",
    "",
  ].join("\n");

  it("skips the frontmatter block and the `%%%` sections when given the body region", () => {
    const bodyStart = text.indexOf("- [ ] milk");
    const bodyEnd = text.indexOf("%%% calendar");
    const tasks = scanTasks(text, REGISTERED, { start: bodyStart, end: bodyEnd });
    expect(tasks.map((task) => task.text)).toEqual(["milk"]);
    // Line numbers stay relative to the whole document, so a jump target is still correct.
    expect(tasks[0]!.line).toBe(6);
  });

  it("without a region, a machine section's YAML can look like a task — which is why the region is passed", () => {
    expect(scanTasks(text, REGISTERED)).toHaveLength(2);
  });

  it("clamps a region that runs past the end of the text", () => {
    expect(scanTasks("- [ ] milk\n", REGISTERED, { start: -5, end: 9_999 })).toHaveLength(1);
  });
});

describe("normalizeFolder", () => {
  it("normalizes `fm.path` the way `folders` does", () => {
    expect(normalizeFolder("home/lists")).toBe("home/lists");
    expect(normalizeFolder("/home//lists/")).toBe("home/lists");
    expect(normalizeFolder("home/../lists/./x")).toBe("home/lists/x");
    expect(normalizeFolder("Home")).toBe("Home");
  });

  it("treats anything that is not a string as no folder", () => {
    expect(normalizeFolder(undefined)).toBe("");
    expect(normalizeFolder(42)).toBe("");
    expect(normalizeFolder(["home"])).toBe("");
  });
});

describe("groupTasks", () => {
  const row = (id: string, title: string, content: string, path?: string): TaskRow => ({
    id,
    title,
    content,
    fm: path === undefined ? {} : { path },
  });

  const rows: readonly TaskRow[] = [
    row("1", "Groceries", "- [ ] milk\n- [x] bread\n", "home/lists"),
    row("2", "Admin", "- [ ] renew passport\n- [ ] call bank\n", "home"),
    row("3", "Loose ends", "- [/] halfway\n- [?] mystery\n"),
    row("4", "All done", "- [x] shipped\n", "home"),
    row("5", "No tasks", "Just prose.\n", "home"),
    row("6", "Unknown markers only", "- [?] nope\n", "home"),
  ];

  it("groups by folder, unfiled last, documents by title inside", () => {
    const groups = groupTasks(rows, REGISTERED);
    expect(groups.map((group) => group.folder)).toEqual(["home", "home/lists", ""]);
    expect(groups[0]!.documents.map((entry) => entry.title)).toEqual(["Admin"]);
    expect(groups[2]!.label).toBe("Not in a folder");
  });

  it("drops documents whose registered tasks are all done unless asked for them", () => {
    expect(
      groupTasks(rows, REGISTERED)
        .flatMap((group) => group.documents)
        .map((entry) => entry.title),
    ).not.toContain("All done");
    expect(
      groupTasks(rows, REGISTERED, { includeCompleted: true })
        .flatMap((group) => group.documents)
        .map((entry) => entry.title),
    ).toContain("All done");
  });

  it("drops a document whose only markers are unregistered, and one with no tasks", () => {
    const titles = groupTasks(rows, REGISTERED, { includeCompleted: true })
      .flatMap((group) => group.documents)
      .map((entry) => entry.title);
    expect(titles).not.toContain("Unknown markers only");
    expect(titles).not.toContain("No tasks");
  });

  it("keeps unregistered markers on the document they came from", () => {
    const loose = groupTasks(rows, REGISTERED)
      .flatMap((group) => group.documents)
      .find((entry) => entry.title === "Loose ends");
    expect(loose?.open.map((task) => task.marker)).toEqual(["/"]);
    expect(loose?.unrecognized.map((task) => task.marker)).toEqual(["?"]);
    expect(loose?.total).toBe(1);
  });

  it("counts done against the registry's `done`, per document and per folder", () => {
    const groups = groupTasks(rows, REGISTERED);
    const lists = groups.find((group) => group.folder === "home/lists");
    expect(lists?.documents[0]).toMatchObject({ doneCount: 1, total: 2 });
    expect(lists).toMatchObject({ openCount: 1, doneCount: 1 });
  });

  it("applies the region function per document", () => {
    const text = "- [ ] body task\n%%% calendar\nnote: - [x] not a task\n%%%\n";
    const groups = groupTasks([row("7", "Regioned", text, "home")], REGISTERED, {
      regionOf: (value) => ({ start: 0, end: value.indexOf("%%%") }),
    });
    expect(groups[0]!.documents[0]).toMatchObject({ total: 1 });
    expect(groups[0]!.documents[0]!.open.map((task) => task.text)).toEqual(["body task"]);
    expect(groups[0]!.openCount).toBe(1);
  });

  it("ignores a row with no content — the projection may not carry text for it", () => {
    expect(groupTasks([{ id: "8", title: "Unknown", fm: {} }], REGISTERED)).toEqual([]);
  });

  it("countTasks totals every folder", () => {
    const groups = groupTasks(rows, REGISTERED, { includeCompleted: true });
    expect(countTasks(groups)).toEqual({ open: 4, done: 2, documents: 4 });
  });
});
