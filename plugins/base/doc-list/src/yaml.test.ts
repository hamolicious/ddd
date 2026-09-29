/**
 * The frontmatter scalar writer.
 *
 * Everything here is a case where an unquoted value parses back as the *wrong type*, and
 * a wrongly-typed `fm.title` is the quietest of them: the resolver falls through to the
 * body and the document looks almost right.
 */

import { describe, expect, it } from "vitest";

import { needsQuoting, yamlScalar } from "./yaml.js";

describe("yamlScalar", () => {
  it("leaves ordinary text alone", () => {
    expect(yamlScalar("Groceries")).toBe("Groceries");
    expect(yamlScalar("home/lists")).toBe("home/lists");
    expect(yamlScalar("Q3 plan (draft)")).toBe("Q3 plan (draft)");
  });

  it("quotes values the strict subset would type as something other than a string", () => {
    expect(yamlScalar("2026")).toBe("'2026'");
    expect(yamlScalar("1.5")).toBe("'1.5'");
    expect(yamlScalar("1e3")).toBe("'1e3'");
    expect(yamlScalar("true")).toBe("'true'");
    expect(yamlScalar("NULL")).toBe("'NULL'");
    expect(yamlScalar("~")).toBe("'~'");
    expect(yamlScalar("2026-09-23")).toBe("'2026-09-23'");
  });

  it("quotes values that would break the line", () => {
    expect(yamlScalar("yes: no")).toBe("'yes: no'");
    expect(yamlScalar("todo # later")).toBe("'todo # later'");
    expect(yamlScalar("[a, b]")).toBe("'[a, b]'");
    expect(yamlScalar("- item")).toBe("'- item'");
    expect(yamlScalar("trailing:")).toBe("'trailing:'");
    expect(yamlScalar("")).toBe("''");
    expect(yamlScalar("  padded  ")).toBe("'  padded  '");
  });

  it("doubles an apostrophe, the subset's one escape", () => {
    expect(yamlScalar("it's: fine")).toBe("'it''s: fine'");
    // A leading quote character starts a construct, so it is quoted even alone.
    expect(yamlScalar("'quoted'")).toBe("'''quoted'''");
  });

  it("never lets a value become a second frontmatter line", () => {
    // The injection this closes: a value can come from a document any workspace user
    // can write, and creating a document writes it back. A single-quoted scalar has no
    // newline escape, so quoting alone produced an unterminated quote plus an injected
    // `title:` line the creating user never typed.
    expect(yamlScalar("home\ntitle: owned")).toBe('"home\\ntitle: owned"');
    expect(yamlScalar("a\rb")).toBe('"a\\rb"');
    expect(yamlScalar("a\tb")).toBe('"a\\tb"');
    expect(yamlScalar("ab")).toBe('"a\\u0001b"');
    // Double-quoting means the double-quote and backslash escapes apply too.
    expect(yamlScalar('say "hi"\nthere')).toBe('"say \\"hi\\"\\nthere"');
    expect(yamlScalar("back\\slash\nx")).toBe('"back\\\\slash\\nx"');
    for (const value of ["home\ntitle: owned", "a\tb"]) {
      expect(yamlScalar(value)).not.toContain("\n");
      expect(needsQuoting(value)).toBe(true);
    }
  });

  it("agrees with needsQuoting", () => {
    for (const value of ["Groceries", "2026", "yes: no", "", "true"]) {
      expect(yamlScalar(value) !== value).toBe(needsQuoting(value));
    }
  });
});
