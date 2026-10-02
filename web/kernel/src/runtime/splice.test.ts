import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import type { CoreBindings } from "../wasm/index.js";

import {
  applyEdits,
  frontmatterList,
  isValidKey,
  removeFrontmatterKey,
  removeSection,
  sectionList,
  setFrontmatterValue,
  spliceSection,
  toYamlInline,
  type ListActionInput,
  type SectionKeyEdit,
} from "./splice.js";
import type { FmValue, TextEdit } from "@kernel";

interface CorpusEdit {
  readonly key: string;
  readonly value: FmValue;
  readonly remove?: boolean;
}

type CorpusOp =
  | { readonly kind: "set_fm"; readonly key: string; readonly value: FmValue }
  | { readonly kind: "remove_fm"; readonly key: string }
  | { readonly kind: "splice_section"; readonly plugin: string; readonly edits: readonly CorpusEdit[] }
  | { readonly kind: "remove_section"; readonly plugin: string }
  | { readonly kind: "fm_list"; readonly key: string; readonly action: ListActionInput }
  | {
      readonly kind: "section_list";
      readonly plugin: string;
      readonly key: string;
      readonly action: ListActionInput;
    };

interface CorpusCase {
  readonly name: string;
  readonly text: string;
  readonly op: CorpusOp;
  readonly expect: string;
  readonly edits?: number;
  readonly replaced?: readonly string[];
  readonly popped?: FmValue;
  readonly list?: FmValue;
}

interface Corpus {
  readonly cases: readonly CorpusCase[];
  readonly rejected: readonly { readonly name: string; readonly text?: string; readonly op: CorpusOp }[];
}

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../backend/crates/core/corpus/splices.json", import.meta.url)),
    "utf8",
  ),
) as Corpus;

const sectionEdits = (edits: readonly CorpusEdit[]): SectionKeyEdit[] =>
  edits.map((edit) => (edit.remove === true ? { key: edit.key } : { key: edit.key, value: edit.value }));

function run(op: CorpusOp, text: string): TextEdit[] {
  return runWithPopped(op, text).edits;
}

function runWithPopped(op: CorpusOp, text: string): { edits: TextEdit[]; popped?: FmValue } {
  switch (op.kind) {
    case "fm_list":
      return frontmatterList(text, op.key, op.action);
    case "section_list":
      return sectionList(text, op.plugin, op.key, op.action);
    default:
      return { edits: runPlain(op, text) };
  }
}

function runPlain(op: CorpusOp, text: string): TextEdit[] {
  switch (op.kind) {
    case "fm_list":
    case "section_list":
      throw new Error("list ops go through runWithPopped");
    case "set_fm":
      return setFrontmatterValue(text, op.key, op.value);
    case "remove_fm":
      return removeFrontmatterKey(text, op.key);
    case "splice_section":
      return spliceSection(text, op.plugin, sectionEdits(op.edits));
    case "remove_section":
      return removeSection(text, op.plugin);
  }
}

describe("core::splice conformance corpus", () => {
  it("has cases", () => {
    expect(corpus.cases.length).toBeGreaterThan(20);
  });

  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const { edits, popped } = runWithPopped(testCase.op, testCase.text);
      if (testCase.popped !== undefined) expect(popped ?? null).toEqual(testCase.popped);
      if (testCase.edits !== undefined) expect(edits).toHaveLength(testCase.edits);
      if (testCase.replaced !== undefined) {
        expect(edits.map((edit) => testCase.text.slice(edit.range.start, edit.range.end))).toEqual(
          testCase.replaced,
        );
      }
      expect(applyEdits(testCase.text, edits)).toBe(testCase.expect);
    });
  }

  for (const rejected of corpus.rejected) {
    it(`rejects ${rejected.name}`, () => {
      expect(() => run(rejected.op, rejected.text ?? "")).toThrow();
    });
  }
});

describe("edits are disjoint and descending", () => {
  it("so a caller can apply them in order without re-offsetting", () => {
    const text = "---\na: 1\nb: 2\na: 3\n---\n";
    const edits = removeFrontmatterKey(text, "a");
    expect(edits.length).toBe(2);
    for (let i = 1; i < edits.length; i += 1) {
      const previous = edits[i - 1] as TextEdit;
      const current = edits[i] as TextEdit;
      expect(current.range.start).toBeLessThan(previous.range.start);
      expect(current.range.end).toBeLessThanOrEqual(previous.range.start);
    }
  });
});

describe("offsets are UTF-16 code units, not bytes", () => {
  it("so the spans are Y.Text indices (SPEC §3.2, OffsetKind::Utf16)", () => {
    const text = "---\ntitle: café 🙂\npath: home\n---\n\nbody\n";
    const edits = setFrontmatterValue(text, "path", "away");
    expect(edits).toHaveLength(1);
    const edit = edits[0] as TextEdit;
    expect(text.slice(edit.range.start, edit.range.end)).toBe("home");
    expect(applyEdits(text, edits)).toBe("---\ntitle: café 🙂\npath: away\n---\n\nbody\n");
  });

  it("keeps a surrogate pair intact when clamping a bad range", () => {
    const text = "🙂";
    expect(applyEdits(text, [{ range: { start: 1, end: 5 }, text: "x" }])).toBe("x");
  });
});

describe("value serialization", () => {
  it("writes the canonical single-line form", () => {
    expect(toYamlInline("plain")).toBe("plain");
    expect(toYamlInline("")).toBe('""');
    expect(toYamlInline("true")).toBe('"true"');
    expect(toYamlInline("2026-09-23")).toBe("2026-09-23");
    expect(toYamlInline("has: colon")).toBe('"has: colon"');
    expect(toYamlInline("- dash")).toBe('"- dash"');
    expect(toYamlInline(null)).toBe("null");
    expect(toYamlInline(true)).toBe("true");
    expect(toYamlInline(7)).toBe("7");
    expect(toYamlInline(7.5)).toBe("7.5");
    expect(toYamlInline(["a", 1, null])).toBe("[a, 1, null]");
    expect(toYamlInline({ b: 2, a: 1 })).toBe("{a: 1, b: 2}");
  });

  it("round-trips a written value through a re-read", () => {
    const text = applyEdits("", setFrontmatterValue("", "title", "1"));
    expect(text).toBe('---\ntitle: "1"\n---\n');
    const edits = setFrontmatterValue(text, "title", "1");
    expect(applyEdits(text, edits)).toBe(text);
  });
});

describe("keys", () => {
  it("accepts what the parser accepts and nothing else", () => {
    expect(isValidKey("a")).toBe(true);
    expect(isValidKey("source-uid_1")).toBe(true);
    expect(isValidKey("")).toBe(false);
    expect(isValidKey("a b")).toBe(false);
    expect(isValidKey("a.b")).toBe(false);
    expect(isValidKey("é")).toBe(false);
    expect(isValidKey("x".repeat(64))).toBe(true);
    expect(isValidKey("x".repeat(65))).toBe(false);
  });

  it("refuses a document over the byte cap", () => {
    expect(() => setFrontmatterValue("x".repeat(1024 * 1024 + 1), "a", 1)).toThrow();
    expect(() => setFrontmatterValue("é".repeat(600_000), "a", 1)).toThrow();
  });
});

describe("a plugin only ever writes its own section", () => {
  it("targets the last section with its id and leaves the others alone", () => {
    const text = "%%% a\nx: 1\n%%%\n%%% b\nx: 1\n%%%\n";
    const out = applyEdits(text, spliceSection(text, "b", [{ key: "x", value: 2 }]));
    expect(out).toBe("%%% a\nx: 1\n%%%\n%%% b\nx: 2\n%%%\n");
  });

  it("writes an explicit null and removes a key with no value", () => {
    const text = "%%% a\nk: 1\n%%%\n";
    expect(applyEdits(text, spliceSection(text, "a", [{ key: "k", value: null }]))).toBe(
      "%%% a\nk: null\n%%%\n",
    );
    expect(applyEdits(text, spliceSection(text, "a", [{ key: "k" }]))).toBe("%%% a\n%%%\n");
  });

  it("ignores an earlier run that is not the trailing one", () => {
    const text = "%%% a\nx: 1\n%%%\n\nbody\n";
    const out = applyEdits(text, spliceSection(text, "a", [{ key: "x", value: 2 }]));
    expect(out).toBe("%%% a\nx: 1\n%%%\n\nbody\n\n%%% a\nx: 2\n%%%\n");
  });
});

describe.skipIf(!coreArtifactExists())("spliced text as the Rust parser reads it", () => {
  let core: CoreBindings;
  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  const documents = [
    "",
    "body\n",
    "# Note\n\nbody text\n",
    "---\ntitle: A\n---\n\nbody\n",
    "---\ntitle: A\ndate: 2026-01-01\ntags: [x]\n---\n\nbody\n",
    "---\ntitle: A\n---\n\nbody\n\n%%% calendar\nsource-uid: abc\n%%%\n",
    "---\ntitle: A\n# comment\nempty:\n---\nbody",
    "body\n\n%%% a\nx: 1\n%%%\n%%% b\ny: 2\n%%%\n",
  ];

  const values: readonly FmValue[] = [
    "plain",
    "home/lists",
    "",
    "true",
    "2026-09-23",
    "a: colon, and [brackets]",
    "  padded  ",
    "line\nbreak",
    42,
    -1.5,
    true,
    null,
    ["a", "b"],
    { k: "v" },
  ];

  it("materializes every frontmatter value the way it was written", () => {
    for (const text of documents) {
      for (const value of values) {
        const out = applyEdits(text, setFrontmatterValue(text, "probe", value));
        const parsed = core.parseDocument(out);
        expect(parsed.fm["probe"], `${JSON.stringify(text)} := ${JSON.stringify(value)}`).toEqual(
          value,
        );
        expect(parsed.fm_parse_error, `${JSON.stringify(out)}`).toBe(
          core.parseDocument(text).fm_parse_error,
        );
      }
    }
  });

  it("keeps every other frontmatter key untouched", () => {
    const text = "---\ntitle: A\ndate: 2026-01-01\ntags: [x]\n---\n\nbody\n";
    const before = core.parseDocument(text).fm;
    const after = core.parseDocument(applyEdits(text, setFrontmatterValue(text, "date", "2026-02-02"))).fm;
    expect(after).toEqual({ ...before, date: "2026-02-02" });
  });

  it("removes a frontmatter key from the parser's view", () => {
    const text = "---\na: 1\nb: 2\na: 3\n---\n";
    const after = core.parseDocument(applyEdits(text, removeFrontmatterKey(text, "a"))).fm;
    expect(after).toEqual({ b: 2 });
  });

  it("reads every corpus list the way the case says", () => {
    for (const testCase of corpus.cases) {
      if (testCase.list === undefined) continue;
      const op = testCase.op as Extract<CorpusOp, { kind: "fm_list" | "section_list" }>;
      const parsed = core.parseDocument(testCase.expect);
      const actual = op.kind === "section_list" ? (parsed.plugins[op.plugin] as Record<string, FmValue>)[op.key] : parsed.fm[op.key];
      expect(actual, testCase.name).toEqual(testCase.list);
    }
  });

  it("merges concurrent list actions from two replicas", () => {
    const base = "# Folder\n\n%%% folders\nchildren:\n  - 01A\n  - 01B\n%%%\n";
    const children = (doc: Y.Doc): FmValue =>
      (core.parseDocument(doc.getText("t").toString()).plugins["folders"] as Record<string, FmValue>)["children"] as FmValue;
    const replay = (doc: Y.Doc, edits: readonly TextEdit[]): void => {
      const text = doc.getText("t");
      doc.transact(() => {
        for (const edit of edits) {
          text.delete(edit.range.start, edit.range.end - edit.range.start);
          text.insert(edit.range.start, edit.text);
        }
      });
    };
    const scenarios: readonly [ListActionInput, ListActionInput, readonly FmValue[]][] = [
      [{ action: "push", value: "01X" }, { action: "push", value: "01Y" }, ["01A", "01B", "01X", "01Y"]],
      [{ action: "remove", value: "01A" }, { action: "push", value: "01Y" }, ["01B", "01Y"]],
      [{ action: "remove", value: "01B" }, { action: "remove", value: "01B" }, ["01A"]],
      [{ action: "insert", index: 0, value: "01X" }, { action: "remove", value: "01A" }, ["01X", "01B"]],
    ];
    for (const [left, right, expected] of scenarios) {
      const a = new Y.Doc({ gc: false });
      a.getText("t").insert(0, base);
      const b = new Y.Doc({ gc: false });
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      replay(a, sectionList(a.getText("t").toString(), "folders", "children", left).edits);
      replay(b, sectionList(b.getText("t").toString(), "folders", "children", right).edits);
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(a.getText("t").toString()).toBe(b.getText("t").toString());
      const merged = children(a) as readonly FmValue[];
      expect([...merged].sort(), JSON.stringify([left, right])).toEqual([...expected].sort());
    }
  });

  it("materializes section keys into `plugins`, and only its own", () => {
    for (const text of documents) {
      const edits: SectionKeyEdit[] = [
        { key: "uid", value: "abc" },
        { key: "count", value: 3 },
        { key: "flag", value: null },
      ];
      const out = applyEdits(text, spliceSection(text, "probe", edits));
      const parsed = core.parseDocument(out);
      expect(parsed.plugins["probe"], JSON.stringify(out)).toEqual({
        uid: "abc",
        count: 3,
        flag: null,
      });
      const original = core.parseDocument(text).plugins;
      for (const [id, section] of Object.entries(original)) {
        expect(parsed.plugins[id], `${id} in ${JSON.stringify(out)}`).toEqual(section);
      }
    }
  });

  it("drops a section key, then the whole section", () => {
    const text = "body\n\n%%% probe\nuid: abc\nkeep: 1\n%%%\n";
    const dropped = applyEdits(text, spliceSection(text, "probe", [{ key: "uid" }]));
    expect(core.parseDocument(dropped).plugins["probe"]).toEqual({ keep: 1 });
    const gone = applyEdits(dropped, removeSection(dropped, "probe"));
    expect(core.parseDocument(gone).plugins["probe"]).toBeUndefined();
    expect(gone).toBe("body\n\n");
  });

  it("agrees with the core about which keys are writable", () => {
    for (const key of ["ok", "a-b_1", "", "a b", "a.b", "é", "x".repeat(65)]) {
      const writable = isValidKey(key);
      if (!writable) {
        expect(() => setFrontmatterValue("", key, 1)).toThrow();
        continue;
      }
      const out = applyEdits("", setFrontmatterValue("", key, 1));
      expect(core.parseDocument(out).fm[key]).toBe(1);
    }
  });
});

describe("concurrent writes to one key", () => {
  const seed = (text: string): Y.Doc => {
    const doc = new Y.Doc();
    doc.getText("text").insert(0, text);
    return doc;
  };

  const applyTo = (doc: Y.Doc, edits: readonly TextEdit[]): void => {
    const target = doc.getText("text");
    const ordered = [...edits].sort((a, b) => b.range.start - a.range.start);
    doc.transact(() => {
      for (const edit of ordered) {
        const length = edit.range.end - edit.range.start;
        if (length > 0) target.delete(edit.range.start, length);
        if (edit.text.length > 0) target.insert(edit.range.start, edit.text);
      }
    });
  };

  const converge = (
    base: string,
    left: (text: string) => readonly TextEdit[][],
    right: (text: string) => readonly TextEdit[][],
  ): string => {
    const a = seed(base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const edits of left(a.getText("text").toString())) applyTo(a, edits);
    for (const edits of right(b.getText("text").toString())) applyTo(b, edits);
    const fromA = Y.encodeStateAsUpdate(a);
    const fromB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, fromB);
    Y.applyUpdate(b, fromA);
    const text = a.getText("text").toString();
    expect(b.getText("text").toString(), "the two replicas converge either way").toBe(text);
    return text;
  };

  const FM = "---\ntitle: Note\npath: home/lists\n---\n\nbody\n";

  it("merges a section key to one of the two values written", () => {
    const base = "body\n\n%%% probe\nstate: idle\n%%%\n";
    const text = converge(
      base,
      (before) => [spliceSection(before, "probe", [{ key: "state", value: "running" }])],
      (before) => [spliceSection(before, "probe", [{ key: "state", value: "done" }])],
    );
    expect(text.match(/^state: /gm)).toHaveLength(2);
    const winner = [...text.matchAll(/^state: (.*)$/gm)].at(-1)?.[1];
    expect(["running", "done"]).toContain(winner);
  });

  it("concatenates a frontmatter value into one neither caller wrote", () => {
    const text = converge(
      FM,
      (before) => [setFrontmatterValue(before, "path", "archive")],
      (before) => [setFrontmatterValue(before, "path", "inbox")],
    );
    const value = /^path: (.*)$/m.exec(text)?.[1];
    expect(value).toMatch(/^(archiveinbox|inboxarchive)$/);
    expect(["archive", "inbox"]).not.toContain(value);
    expect(text.match(/^path: /gm)).toHaveLength(1);
    expect(text).toContain("title: Note");
  });

  it("would merge cleanly as a line write — at the cost of the key's position", () => {
    const write = (value: string) => (before: string): readonly TextEdit[][] => {
      const removed = applyEdits(before, removeFrontmatterKey(before, "path"));
      return [removeFrontmatterKey(before, "path"), setFrontmatterValue(removed, "path", value)];
    };
    const text = converge(FM, write("archive"), write("inbox"));
    const values = [...text.matchAll(/^path: (.*)$/gm)].map((match) => match[1]);
    expect(values).toHaveLength(2);
    for (const value of values) expect(["archive", "inbox"]).toContain(value);

    const ordered = "---\npath: home\ntitle: Note\n---\n";
    const relocated = applyEdits(
      applyEdits(ordered, removeFrontmatterKey(ordered, "path")),
      setFrontmatterValue(applyEdits(ordered, removeFrontmatterKey(ordered, "path")), "path", "archive"),
    );
    expect(relocated).toBe("---\ntitle: Note\npath: archive\n---\n");
  });
});
