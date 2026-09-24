import { describe, expect, it } from "vitest";

import { ALLOWED_SCHEMES, classifyUrl, fragmentOf, idFromScheme, isAllowed } from "./schemes.js";

const ULID = "01JBQ2X4Y5Z6A7B8C9D0E1F2G3";

describe("the allowlist", () => {
  it("is exactly the five schemes SPEC §8 names", () => {
    expect([...ALLOWED_SCHEMES].sort()).toEqual(["attachment", "doc", "http", "https", "mailto"]);
  });

  it.each(["http://example.com/a", "https://example.com/a", "mailto:a@b.c", `doc://${ULID}`, `attachment://${ULID}`])(
    "allows %s",
    (url: string) => {
      expect(classifyUrl(url).kind).toBe("allowed");
      expect(isAllowed(url)).toBe(true);
    },
  );

  it("is case-insensitive on the scheme", () => {
    const verdict = classifyUrl("HTTPS://example.com");
    expect(verdict).toMatchObject({ kind: "allowed", scheme: "https" });
  });
});

describe("what it refuses", () => {
  it.each([
    ["javascript:alert(1)", "the obvious one"],
    ["JaVaScRiPt:alert(1)", "mixed case"],
    [" javascript:alert(1)", "leading space"],
    ["java\nscript:alert(1)", "an embedded newline"],
    ["java\tscript:alert(1)", "an embedded tab"],
    ["java\u0000script:alert(1)", "an embedded NUL"],
    ["jav\u0001ascript:alert(1)", "an embedded control character"],
    ["vbscript:msgbox(1)", "the other script scheme"],
    ["data:text/html;base64,PHNjcmlwdD4=", "an inline document"],
    ["file:///etc/passwd", "a local file"],
    ["blob:https://example.com/abc", "a blob URL"],
    ["%6aavascript:alert(1)", "a percent-encoded scheme letter"],
  ])("blocks %s (%s)", (url: string) => {
    expect(classifyUrl(url).kind).toBe("blocked");
    expect(isAllowed(url)).toBe(false);
  });

  it("blocks relative and scheme-relative URLs", () => {
    // Documents are id-addressed (`doc://<ulid>`), so a relative path has no meaning
    // here and inheriting the page's scheme is not an allowlisted scheme.
    expect(classifyUrl("./notes.md")).toMatchObject({ kind: "blocked", reason: "relative URL" });
    expect(classifyUrl("/api/admin/export")).toMatchObject({ kind: "blocked", reason: "relative URL" });
    expect(classifyUrl("//evil.example/x")).toMatchObject({ kind: "blocked", reason: "scheme-relative URL" });
  });

  it("blocks the empty and the absent", () => {
    expect(classifyUrl("").kind).toBe("blocked");
    expect(classifyUrl("   ").kind).toBe("blocked");
    expect(classifyUrl(undefined).kind).toBe("blocked");
    expect(classifyUrl(null).kind).toBe("blocked");
  });

  it("allows a pure in-page anchor, which cannot navigate away", () => {
    expect(classifyUrl("#groceries")).toEqual({ kind: "fragment", url: "#groceries" });
    expect(isAllowed("#groceries")).toBe(true);
  });
});

describe("idFromScheme", () => {
  it("reads both spellings", () => {
    expect(idFromScheme(`doc://${ULID}`, "doc")).toBe(ULID);
    expect(idFromScheme(`doc:${ULID}`, "doc")).toBe(ULID);
    expect(idFromScheme(`attachment://${ULID}`, "attachment")).toBe(ULID);
  });

  it("stops at a fragment, query or path", () => {
    expect(idFromScheme(`doc://${ULID}#heading`, "doc")).toBe(ULID);
    expect(idFromScheme(`doc://${ULID}?x=1`, "doc")).toBe(ULID);
    expect(idFromScheme(`doc://${ULID}/extra`, "doc")).toBe(ULID);
  });

  it("does not cross schemes, and refuses an empty id", () => {
    expect(idFromScheme(`doc://${ULID}`, "attachment")).toBeNull();
    expect(idFromScheme("https://example.com", "doc")).toBeNull();
    expect(idFromScheme("doc://", "doc")).toBeNull();
    expect(idFromScheme("javascript:alert(1)", "doc")).toBeNull();
  });
});

describe("fragmentOf", () => {
  it("returns the fragment without the hash, or null", () => {
    expect(fragmentOf(`doc://${ULID}#groceries`)).toBe("groceries");
    expect(fragmentOf(`doc://${ULID}`)).toBeNull();
    expect(fragmentOf(`doc://${ULID}#`)).toBeNull();
  });
});
