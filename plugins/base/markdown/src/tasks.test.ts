import { describe, expect, it } from "vitest";

import type { MarkdownTaskState } from "../../_shared/points.js";

import { buildProcessor } from "./processor.js";
import { buildTaskRegistry, markerAt, resolveMarkerOffset, scanTasks, toggleMarker } from "./tasks.js";

const TODO: MarkdownTaskState = { marker: " ", label: "To do", icon: "☐", order: 0, done: false };
const DONE: MarkdownTaskState = { marker: "x", label: "Done", icon: "☑", order: 10, done: true };
const PARTIAL: MarkdownTaskState = { marker: "/", label: "In progress", icon: "◐", order: 5 };
const DROPPED: MarkdownTaskState = { marker: "-", label: "Dropped", icon: "⊘", order: 20, done: true };

const BUILTINS = buildTaskRegistry([TODO, DONE]);
const processor = buildProcessor([]);
const scan = (text: string, registry = BUILTINS) => scanTasks(processor.parse(text), text, registry);

describe("buildTaskRegistry", () => {
  it("orders states by `order`, then by marker", () => {
    const registry = buildTaskRegistry([DONE, DROPPED, TODO, PARTIAL]);
    expect(registry.states.map((state) => state.marker)).toEqual([" ", "/", "x", "-"]);
  });

  it("defaults a missing order to 100, after the built-ins", () => {
    const registry = buildTaskRegistry([DONE, { marker: "?", label: "Unclear", icon: "?" }, TODO]);
    expect(registry.states.map((state) => state.marker)).toEqual([" ", "x", "?"]);
  });

  it("resolves off and on from the registry, not from hard-coded markers", () => {
    expect(BUILTINS.off?.marker).toBe(" ");
    expect(BUILTINS.on?.marker).toBe("x");
    // A workspace that replaced the built-ins entirely still gets a sensible toggle:
    // off = the first state that is not `done`, on = the first that is.
    const replaced = buildTaskRegistry([
      { marker: "o", label: "Open", icon: "o", order: 0 },
      { marker: "v", label: "Closed", icon: "v", order: 1, done: true },
    ]);
    expect(replaced.off?.marker).toBe("o");
    expect(replaced.on?.marker).toBe("v");
  });

  it("de-duplicates by marker, first contribution winning", () => {
    const registry = buildTaskRegistry([TODO, { ...TODO, label: "Impostor" }]);
    expect(registry.states).toHaveLength(1);
    expect(registry.byMarker.get(" ")?.label).toBe("To do");
  });

  it("is empty-safe: nothing registered means nothing is a task", () => {
    const registry = buildTaskRegistry([]);
    expect(registry.states).toEqual([]);
    expect(registry.off).toBeUndefined();
    expect(toggleMarker(" ", registry)).toBeNull();
  });
});

describe("toggleMarker — the shipped left-click rule (SPEC §6.6)", () => {
  const registry = buildTaskRegistry([TODO, PARTIAL, DONE, DROPPED]);

  it("takes any non-off state to off", () => {
    expect(toggleMarker("x", registry)).toBe(" ");
    expect(toggleMarker("/", registry)).toBe(" ");
    expect(toggleMarker("-", registry)).toBe(" ");
  });

  it("takes off to on", () => {
    expect(toggleMarker(" ", registry)).toBe("x");
  });
});

describe("markerAt", () => {
  it.each([
    ["- [ ] milk", " "],
    ["* [x] bread", "x"],
    ["+ [/] partial", "/"],
    ["1. [ ] first", " "],
    ["2) [>] second", ">"],
    ["  - [?] indented", "?"],
    ["-\t[ ]\tvery tabbed", " "],
  ])("finds the marker in %j", (line: string, marker: string) => {
    const found = markerAt(line, 0);
    expect(found?.marker).toBe(marker);
    expect(line[found?.offset ?? -1]).toBe(marker);
  });

  it("requires a space or tab after the checkbox, exactly as GFM does", () => {
    // `- [ ]` at end of line and `- [x]done` are not task items to any GFM renderer, so
    // they are not task items here either — a divergence would render one thing in this
    // app and another on GitHub.
    expect(markerAt("- [ ]", 0)).toBeNull();
    expect(markerAt("- [x]done", 0)).toBeNull();
  });

  it("refuses non-list lines and multi-character brackets", () => {
    expect(markerAt("[ ] not a list item", 0)).toBeNull();
    expect(markerAt("-[ ] no space after the bullet", 0)).toBeNull();
    expect(markerAt("- [ab] two characters", 0)).toBeNull();
    expect(markerAt("- plain", 0)).toBeNull();
  });
});

describe("scanTasks — the parser accepts any registered marker", () => {
  const TEXT = ["- [ ] milk", "- [x] bread", "- [X] shouty", "- [/] partial", "- plain"].join("\n");

  it("locates every marker in document order, registered or not", () => {
    const { locations } = scan(TEXT);
    expect(locations.map((location) => location.marker)).toEqual([" ", "x", "X", "/"]);
    // Offsets point at the character between the brackets.
    for (const location of locations) expect(TEXT[location.offset]).toBe(location.marker);
  });

  it("marks only the markers a contribution claims as registered", () => {
    expect(scan(TEXT).locations.map((location) => location.registered)).toEqual([true, true, false, false]);
    // Install a plugin that adds `[/]` and the same text parses it as a task.
    const withPartial = buildTaskRegistry([TODO, DONE, PARTIAL]);
    expect(scan(TEXT, withPartial).locations.map((location) => location.registered)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it("records which markers remark-gfm already consumed", () => {
    // GFM eats its own three — including `[X]`, which nothing registers — and leaves
    // everything else as literal text in the paragraph. The renderer needs to know which,
    // to decide whether to strip or to re-insert `[m] `.
    expect(scan(TEXT).locations.map((location) => location.consumedByGfm)).toEqual([true, true, true, false]);
  });

  it("keys ordinals by node identity so the renderer and the click path agree", () => {
    const tree = processor.parse(TEXT);
    const { ordinals, locations } = scanTasks(tree, TEXT, BUILTINS);
    expect(ordinals.size).toBe(locations.length);
    expect([...ordinals.values()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("finds tasks in nested lists, in document order", () => {
    const text = ["- outer", "  - [x] nested", "- [ ] after"].join("\n");
    expect(scan(text).locations.map((location) => location.marker)).toEqual(["x", " "]);
  });
});

describe("resolveMarkerOffset — a click never writes to a guessed position", () => {
  const BODY = ["- [ ] milk", "- [ ] bread"].join("\n");
  const rescanIn = (text: string) => () => scan(text);
  /** The second task ("bread") as the renderer captured it. */
  const bread = () => {
    const location = scan(BODY).locations[1];
    if (!location) throw new Error("fixture has two tasks");
    return location;
  };

  it("finds the task where it is when nothing changed", () => {
    expect(resolveMarkerOffset(BODY, 0, bread(), 1, rescanIn(BODY))).toBe(bread().offset);
  });

  it("does not tick the wrong checkbox when the document shifted underneath", () => {
    // The regression this function exists for. `bread().offset` is 14, and in the shifted
    // text offset 14 is *milk's* checkbox — same marker, so a plain offset check passes and
    // the user's click lands on the wrong line. Identity is marker + line text, so it does
    // not.
    const shifted = `# Heading\n\n${BODY}`;
    const resolved = resolveMarkerOffset(shifted, 0, bread(), 1, rescanIn(shifted));
    expect(resolved).not.toBeNull();
    expect(shifted.slice((resolved ?? 0) - 1)).toBe("[ ] bread");
  });

  it("relocates when the ordinal itself shifted", () => {
    const grown = ["- [ ] eggs", ...BODY.split("\n")].join("\n");
    const resolved = resolveMarkerOffset(grown, 0, bread(), 1, rescanIn(grown));
    expect(resolved).not.toBeNull();
    expect(grown.slice((resolved ?? 0) - 1)).toBe("[ ] bread");
  });

  it("honours the body base offset", () => {
    const document = `---\ntitle: x\n---\n${BODY}`;
    const base = document.indexOf(BODY);
    const resolved = resolveMarkerOffset(document, base, bread(), 1, rescanIn(BODY));
    expect(document.slice((resolved ?? 0) - 1)).toBe("[ ] bread");
  });

  it("returns null rather than writing when the task is gone", () => {
    const shrunk = "- [ ] milk";
    expect(resolveMarkerOffset(shrunk, 0, bread(), 1, rescanIn(shrunk))).toBeNull();
  });

  it("returns null when someone else already changed that task's state", () => {
    // Writing " " here would silently undo their edit.
    const changed = ["- [ ] milk", "- [x] bread"].join("\n");
    expect(resolveMarkerOffset(changed, 0, bread(), 1, rescanIn(changed))).toBeNull();
  });

  it("may pick either of two identical tasks, and that is the documented limit", () => {
    const twins = ["- [ ] milk", "- [ ] milk"].join("\n");
    const second = scan(twins).locations[1];
    if (!second) throw new Error("fixture has two tasks");
    expect(resolveMarkerOffset(twins, 0, second, 1, rescanIn(twins))).toBe(second.offset);

    // Ordinal shifted, and marker + label cannot tell the two "milk" lines apart. Whichever
    // it lands on, it lands on *a* checkbox reading "milk" in the state the user saw — so
    // the write is always to a task indistinguishable from the one they clicked.
    const shifted = `- [ ] eggs\n${twins}`;
    const resolved = resolveMarkerOffset(shifted, 0, second, 1, rescanIn(shifted));
    expect(resolved).not.toBeNull();
    expect(shifted.slice((resolved ?? 0) - 1, (resolved ?? 0) + 7)).toBe("[ ] milk");
  });

  it("refuses when the ordinal is out of range and nothing matches", () => {
    expect(resolveMarkerOffset(BODY, 0, { ...bread(), label: "gone" }, 9, rescanIn(BODY))).toBeNull();
  });
});
