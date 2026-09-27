import { describe, expect, it } from "vitest";

import { extensionOf, knownExtensions, pasteAs, reference, schema, settingKey } from "./kinds.js";
import { waitingPlaceholder, waitingToken } from "./queue.js";

describe("extensionOf", () => {
  it("reads the name, lower case", () => {
    expect(extensionOf("Scan.PDF", "application/pdf")).toBe("pdf");
    expect(extensionOf("archive.tar.gz", "application/gzip")).toBe("gz");
  });

  it("falls back to the MIME subtype", () => {
    expect(extensionOf("image", "image/png")).toBe("png");
    expect(extensionOf("", "image/jpeg")).toBe("jpeg");
  });

  it("gives up on nothing usable", () => {
    expect(extensionOf(".bashrc", "")).toBeUndefined();
    expect(extensionOf("notes", "application/vnd.ms-excel")).toBeUndefined();
    expect(extensionOf("weird.ex$t", "")).toBeUndefined();
  });
});

describe("settings", () => {
  it("previews images and links everything else by default", () => {
    const fields = schema();
    expect(fields[settingKey("png")]?.default).toBe("preview");
    expect(fields[settingKey("pdf")]?.default).toBe("link");
    expect(fields[settingKey("svg")]?.default).toBe("link");
  });

  it("keys are writable settings keys", () => {
    for (const key of Object.keys(schema())) expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("reads anything unexpected as a link", () => {
    expect(pasteAs("preview")).toBe("preview");
    expect(pasteAs("link")).toBe("link");
    expect(pasteAs(undefined)).toBe("link");
    expect(pasteAs(3)).toBe("link");
  });

  it("lists every extension with a setting", () => {
    expect(knownExtensions({ "paste-png": "preview", "paste-heic": "link", other: 1 })).toEqual(["heic", "png"]);
  });
});

describe("text", () => {
  it("previews with an image embed and links with a link", () => {
    expect(reference("a.png", "01J", "preview")).toBe("![a.png](attachment://01J)");
    expect(reference("a.pdf", "01J", "link")).toBe("[a.pdf](attachment://01J)");
  });

  it("keeps brackets and line breaks out of the label", () => {
    expect(reference("[x]\ny.png", "01J", "link")).toBe("[xy.png](attachment://01J)");
    expect(waitingPlaceholder("[x].png", "1a2b3c4d")).toBe("![Uploading x.png…](attachment://waiting-1a2b3c4d)");
  });

  it("reads the token back out of a placeholder's id, and nothing out of a real one", () => {
    expect(waitingToken("waiting-1a2b3c4d")).toBe("1a2b3c4d");
    expect(waitingToken("01J0000000000000000000000A")).toBeUndefined();
    expect(waitingToken("waiting-")).toBeUndefined();
  });
});
