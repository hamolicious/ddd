import { describe, expect, it } from "vitest";

import {
  documentRegions,
  foldableRegions,
  regionAt,
  regionsOf,
  stringLines,
  type LineReader,
} from "./regions.js";

/** The slice a region covers — the readable way to assert on offsets. */
const slice = (text: string, region: { start: number; end: number } | undefined): string | undefined =>
  region === undefined ? undefined : text.slice(region.start, region.end);

const DOC = [
  "---",
  "title: Groceries",
  "path: home/lists",
  "---",
  "",
  "# Groceries",
  "",
  "- [ ] milk",
  "",
  "%%% calendar",
  "source-uid: abc123@google.com",
  "%%%",
  "%%% reminders",
  "at: 2026-09-24T08:00:00.000Z",
  "%%%",
  "",
].join("\n");

describe("documentRegions — frontmatter", () => {
  it("covers both fence lines", () => {
    const regions = documentRegions(DOC);
    expect(slice(DOC, regions.frontmatter)).toBe(
      "---\ntitle: Groceries\npath: home/lists\n---",
    );
  });

  it("opens only when the literal first line is `---`", () => {
    expect(documentRegions("\n---\na: 1\n---\n").frontmatter).toBeUndefined();
    expect(documentRegions("--- \na: 1\n---\n").frontmatter).toBeUndefined();
    expect(documentRegions("# Title\n\n---\na: 1\n---\n").frontmatter).toBeUndefined();
  });

  it("is absent entirely when the fence is never closed", () => {
    const text = "---\ntitle: half written\n\n# body\n";
    expect(documentRegions(text).frontmatter).toBeUndefined();
  });

  it("closes at the first following `---`", () => {
    const text = "---\na: 1\n---\nbody\n---\nnot frontmatter\n";
    expect(slice(text, documentRegions(text).frontmatter)).toBe("---\na: 1\n---");
  });

  it("handles an empty frontmatter block", () => {
    const text = "---\n---\n\n# body\n";
    expect(slice(text, documentRegions(text).frontmatter)).toBe("---\n---");
  });
});

describe("documentRegions — machine sections", () => {
  it("finds every section of the trailing run, in document order", () => {
    const regions = documentRegions(DOC);
    expect(regions.sections.map((section) => section.id)).toEqual(["calendar", "reminders"]);
    expect(slice(DOC, regions.sections[0])).toBe(
      "%%% calendar\nsource-uid: abc123@google.com\n%%%",
    );
    expect(slice(DOC, regions.sections[1])).toBe(
      "%%% reminders\nat: 2026-09-24T08:00:00.000Z\n%%%",
    );
  });

  it("covers the whole run, blank lines between sections included", () => {
    const text = "# body\n\n%%% a\nk: 1\n%%%\n\n%%% b\nk: 2\n%%%\n";
    const regions = documentRegions(text);
    expect(regions.sections).toHaveLength(2);
    expect(slice(text, regions.sectionsRun)).toBe("%%% a\nk: 1\n%%%\n\n%%% b\nk: 2\n%%%");
  });

  it("tolerates blank lines after the final fence", () => {
    const text = "# body\n\n%%% a\nk: 1\n%%%\n\n\n";
    expect(documentRegions(text).sections.map((section) => section.id)).toEqual(["a"]);
  });

  it("only counts the last contiguous run — earlier fences are body text", () => {
    const text = ["%%% early", "k: 1", "%%%", "", "# body text", "", "%%% late", "k: 2", "%%%", ""].join("\n");
    const regions = documentRegions(text);
    expect(regions.sections.map((section) => section.id)).toEqual(["late"]);
  });

  it("rejects a fence line with trailing whitespace", () => {
    expect(documentRegions("# b\n\n%%% a \nk: 1\n%%%\n").sections).toEqual([]);
    expect(documentRegions("# b\n\n%%% a\nk: 1\n%%% \n").sections).toEqual([]);
  });

  it("rejects an id that is not `[A-Za-z0-9_-]{1,64}`", () => {
    expect(documentRegions("# b\n\n%%% not an id\nk: 1\n%%%\n").sections).toEqual([]);
    expect(documentRegions(`# b\n\n%%% ${"x".repeat(65)}\nk: 1\n%%%\n`).sections).toEqual([]);
    expect(documentRegions(`# b\n\n%%% ${"x".repeat(64)}\nk: 1\n%%%\n`).sections).toHaveLength(1);
  });

  it("ends the run at a closing fence with no opener", () => {
    const text = "# body\n\n%%%\n\n%%% a\nk: 1\n%%%\n";
    expect(documentRegions(text).sections.map((section) => section.id)).toEqual(["a"]);
  });

  it("finds nothing in a document with no sections", () => {
    const regions = documentRegions("---\na: 1\n---\n\n# body only\n");
    expect(regions.sections).toEqual([]);
    expect(regions.sectionsRun).toBeUndefined();
  });

  it("does not read the frontmatter block as a section run", () => {
    const text = "---\na: 1\n---\n";
    const regions = documentRegions(text);
    expect(regions.sections).toEqual([]);
    expect(slice(text, regions.frontmatter)).toBe("---\na: 1\n---");
  });

  it("is total on degenerate input", () => {
    for (const text of ["", "\n", "---", "%%%", "%%% a", "\n\n\n", "%%%\n%%%\n"]) {
      expect(() => documentRegions(text)).not.toThrow();
      const regions = documentRegions(text);
      for (const region of [regions.frontmatter, regions.sectionsRun, ...regions.sections]) {
        if (!region) continue;
        expect(region.start).toBeGreaterThanOrEqual(0);
        expect(region.end).toBeLessThanOrEqual(text.length);
        expect(region.end).toBeGreaterThanOrEqual(region.start);
      }
    }
  });
});

describe("foldableRegions", () => {
  it("folds the frontmatter and every section by default", () => {
    const folds = foldableRegions(DOC);
    expect(folds.map((region) => slice(DOC, region)?.split("\n")[0])).toEqual([
      "---",
      "%%% calendar",
      "%%% reminders",
    ]);
  });

  it("leaves the frontmatter alone when the preference says so", () => {
    const folds = foldableRegions(DOC, { frontmatter: false });
    expect(folds.map((region) => slice(DOC, region)?.split("\n")[0])).toEqual([
      "%%% calendar",
      "%%% reminders",
    ]);
  });

  it("skips a region that does not span a line break", () => {
    // CodeMirror cannot fold within a line, and a fold with no handle just hides text.
    expect(foldableRegions("---\n")).toEqual([]);
  });

  it("returns nothing for a plain document", () => {
    expect(foldableRegions("# Just prose\n\nA paragraph.\n")).toEqual([]);
  });
});

describe("the line reader", () => {
  it("only visits the head and the tail, so the fold service is not O(document)", () => {
    // The fold service runs on every viewport update, i.e. every keystroke. Before this,
    // each miss materialized the whole document as a string and split it — a megabyte of
    // copying per keystroke near the SPEC §3.5 cap. The scan is head-and-tail only, and
    // this is what pins that: a reader that counts the lines it is asked for.
    const lines = ["---", "title: T", "---", ...Array.from({ length: 5_000 }, (_, i) => `body ${i}`), "%%% cal", "a: 1", "%%%", ""];
    const visited = new Set<number>();
    const source: LineReader = {
      lines: lines.length,
      length: lines.join("\n").length,
      lineAt: (index) => {
        visited.add(index);
        let from = 0;
        for (let i = 0; i < index; i += 1) from += (lines[i] ?? "").length + 1;
        return { text: lines[index] ?? "", from };
      },
    };

    const regions = regionsOf(source);
    expect(regions.frontmatter).toBeDefined();
    expect(regions.sections.map((section) => section.id)).toEqual(["cal"]);
    // Head (3 lines) + tail (the run, its blank line, and the body line that ends it).
    expect(visited.size).toBeLessThan(20);
    expect([...visited].some((index) => index > 10 && index < lines.length - 10)).toBe(false);
  });

  it("agrees with the string path", () => {
    const text = "---\ntitle: T\n---\n\nbody\n\n%%% cal\na: 1\n%%%\n";
    expect(regionsOf(stringLines(text))).toEqual(documentRegions(text));
  });
});

describe("regionAt", () => {
  it("answers with the region containing an offset", () => {
    const inFrontmatter = DOC.indexOf("title:");
    const inSection = DOC.indexOf("source-uid");
    expect(slice(DOC, regionAt(DOC, inFrontmatter))?.startsWith("---")).toBe(true);
    expect(slice(DOC, regionAt(DOC, inSection))?.startsWith("%%% calendar")).toBe(true);
  });

  it("is undefined in the body", () => {
    expect(regionAt(DOC, DOC.indexOf("- [ ] milk"))).toBeUndefined();
  });
});
