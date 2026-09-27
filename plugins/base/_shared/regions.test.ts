import { describe, expect, it } from "vitest";

import { bodyOf, bodyStart, openFenceId, regionsOf } from "./regions.js";

/** Read a span back as text — the only readable way to assert on offsets. */
const at = (text: string, span: { start: number; end: number } | null): string | null =>
  span === null ? null : text.slice(span.start, span.end);

const DOC = [
  "---",
  "title: Groceries",
  "path: home/lists",
  "---",
  "",
  "# Groceries",
  "",
  "- [ ] milk",
  "- [x] bread",
  "",
  "%%% calendar",
  "source-uid: abc123@google.com",
  "%%%",
  "",
].join("\n");

describe("regionsOf — the SPEC §3.1 document", () => {
  it("splits the three regions", () => {
    const regions = regionsOf(DOC);
    expect(at(DOC, regions.frontmatter)).toBe("---\ntitle: Groceries\npath: home/lists\n---\n");
    expect(at(DOC, regions.sections)).toBe("%%% calendar\nsource-uid: abc123@google.com\n%%%\n");
    expect(at(DOC, regions.body)).toBe("\n# Groceries\n\n- [ ] milk\n- [x] bread\n\n");
  });

  it("makes bodyOf and bodyStart agree with the spans", () => {
    const regions = regionsOf(DOC);
    expect(bodyOf(DOC)).toBe(at(DOC, regions.body));
    expect(bodyStart(DOC)).toBe(regions.body.start);
    // The invariant the task-splice path depends on: a body offset plus the base is the
    // document offset.
    expect(DOC.slice(bodyStart(DOC) + bodyOf(DOC).indexOf("[x]"), bodyStart(DOC) + bodyOf(DOC).indexOf("[x]") + 3),
    ).toBe("[x]");
  });
});

describe("frontmatter fence rules (SPEC §3.4)", () => {
  it("opens only on a literal first line", () => {
    expect(regionsOf("\n---\ntitle: x\n---\nbody").frontmatter).toBeNull();
    expect(regionsOf(" ---\ntitle: x\n---\nbody").frontmatter).toBeNull();
  });

  it("treats a fence with trailing whitespace as not a fence", () => {
    expect(regionsOf("--- \ntitle: x\n---\nbody").frontmatter).toBeNull();
    // Closing fence with a trailing space: the block never closes, so there is none.
    expect(regionsOf("---\ntitle: x\n--- \nbody").frontmatter).toBeNull();
  });

  it("has no frontmatter at all when the block never closes", () => {
    const text = "---\ntitle: x\nbody without a closing fence\n";
    expect(regionsOf(text).frontmatter).toBeNull();
    expect(bodyOf(text)).toBe(text);
  });

  it("handles CRLF, keeping offsets against the original text", () => {
    const text = "---\r\ntitle: x\r\n---\r\nbody\r\n";
    expect(at(text, regionsOf(text).frontmatter)).toBe("---\r\ntitle: x\r\n---\r\n");
    expect(bodyOf(text)).toBe("body\r\n");
  });

  it("skips a leading BOM the way core::document::normalize_input does", () => {
    const text = "﻿---\ntitle: x\n---\nbody\n";
    expect(at(text, regionsOf(text).frontmatter)).toBe("---\ntitle: x\n---\n");
    expect(bodyOf(text)).toBe("body\n");
  });

  it("is an empty body for a document that is only frontmatter", () => {
    const text = "---\ntitle: x\n---\n";
    expect(bodyOf(text)).toBe("");
  });
});

describe("%%% run rules (SPEC §3.4)", () => {
  it("only the last contiguous run at the end counts", () => {
    const text = ["# Notes", "", "%%% not-a-section", "this is body text", "%%%", "", "more body", ""].join("\n");
    // The run is not at the end, so every line of it is prose.
    expect(regionsOf(text).sections).toBeNull();
    expect(bodyOf(text)).toBe(text);
  });

  it("pairs several sections into one run", () => {
    const text = ["body", "%%% calendar", "a: 1", "%%%", "%%% reminders", "b: 2", "%%%", ""].join("\n");
    expect(at(text, regionsOf(text).sections)).toBe("%%% calendar\na: 1\n%%%\n%%% reminders\nb: 2\n%%%\n");
    expect(bodyOf(text)).toBe("body\n");
  });

  it("tolerates blank lines inside and after the run", () => {
    const text = ["body", "%%% calendar", "a: 1", "%%%", "", "%%% reminders", "b: 2", "%%%", "", ""].join("\n");
    expect(bodyOf(text)).toBe("body\n");
  });

  it("is not a run when the fence never closes", () => {
    const text = "body\n%%% calendar\na: 1\n";
    expect(regionsOf(text).sections).toBeNull();
    expect(bodyOf(text)).toBe(text);
  });

  it("does not treat body text after the run as part of it", () => {
    const text = "body\n%%% calendar\na: 1\n%%%\ntrailing prose\n";
    expect(regionsOf(text).sections).toBeNull();
    expect(bodyOf(text)).toBe(text);
  });
});

describe("openFenceId (core::sections::open_fence_id)", () => {
  it("accepts a valid plugin id", () => {
    expect(openFenceId("%%% calendar")).toBe("calendar");
    expect(openFenceId("%%% my-plugin_2")).toBe("my-plugin_2");
  });

  it("refuses everything else", () => {
    expect(openFenceId("%%%")).toBeNull();
    expect(openFenceId("%%%calendar")).toBeNull();
    expect(openFenceId("%%% calendar ")).toBeNull();
    expect(openFenceId("%%% two words")).toBeNull();
    expect(openFenceId("%%% ")).toBeNull();
    expect(openFenceId(`%%% ${"a".repeat(65)}`)).toBeNull();
    expect(openFenceId(`%%% ${"a".repeat(64)}`)).toBe("a".repeat(64));
  });
});

describe("totality", () => {
  it.each(["", "\n", "---", "%%%", "%%% ", "---\n", "﻿", "a".repeat(1000)])(
    "returns usable spans for %j",
    (text: string) => {
      const regions = regionsOf(text);
      expect(regions.body.end).toBeGreaterThanOrEqual(regions.body.start);
      expect(regions.body.end).toBeLessThanOrEqual(text.length);
      expect(bodyOf(text)).toBe(text.slice(regions.body.start, regions.body.end));
    },
  );
});
