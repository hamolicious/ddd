import { describe, expect, it } from "vitest";

import {
  attachmentIdsIn,
  formatBytes,
  previewKindFor,
  wrapperAttachmentOf,
} from "./wrapper.js";

const ULID = "01JBQ2X4Y5Z6A7B8C9D0E1F2G3";

describe("wrapperAttachmentOf", () => {
  it("recognises a lone image embed", () => {
    expect(wrapperAttachmentOf(`![Scan.pdf](attachment://${ULID})`)).toEqual({
      id: ULID,
      label: "Scan.pdf",
      embedded: true,
    });
  });

  it("recognises a lone link", () => {
    expect(wrapperAttachmentOf(`[notes.txt](attachment://${ULID})`)).toEqual({
      id: ULID,
      label: "notes.txt",
      embedded: false,
    });
  });

  it("recognises a bare url and an angle-bracketed one", () => {
    expect(wrapperAttachmentOf(`attachment://${ULID}`)?.id).toBe(ULID);
    expect(wrapperAttachmentOf(`<attachment://${ULID}>`)?.id).toBe(ULID);
  });

  it("tolerates surrounding blank lines and a leading heading", () => {
    const body = `\n\n# Scan.pdf\n\n![Scan.pdf](attachment://${ULID})\n\n`;
    expect(wrapperAttachmentOf(body)?.id).toBe(ULID);
  });

  it("drops an empty label rather than reporting an empty string", () => {
    expect(wrapperAttachmentOf(`![](attachment://${ULID})`)).toEqual({
      id: ULID,
      label: undefined,
      embedded: true,
    });
  });

  it("ignores a link title", () => {
    expect(wrapperAttachmentOf(`![alt](attachment://${ULID} "the title")`)?.id).toBe(ULID);
  });

  it("is not a wrapper when there is prose around the embed", () => {
    expect(wrapperAttachmentOf(`Here is the scan:\n\n![s](attachment://${ULID})`)).toBeUndefined();
    expect(wrapperAttachmentOf(`![s](attachment://${ULID})\n\nIt arrived today.`)).toBeUndefined();
  });

  it("is not a wrapper with two embeds", () => {
    const body = `![a](attachment://${ULID})\n![b](attachment://01JBQ2X4Y5Z6A7B8C9D0E1F2G4)`;
    expect(wrapperAttachmentOf(body)).toBeUndefined();
  });

  it("is not a wrapper when the only line is something else", () => {
    expect(wrapperAttachmentOf("# Just a heading")).toBeUndefined();
    expect(wrapperAttachmentOf("")).toBeUndefined();
    expect(wrapperAttachmentOf("- [ ] a task")).toBeUndefined();
    expect(wrapperAttachmentOf(`![a](doc://${ULID})`)).toBeUndefined();
    expect(wrapperAttachmentOf(`![a](https://example.com/a.png)`)).toBeUndefined();
  });

  it("does not match a heading-only document with no embed", () => {
    expect(wrapperAttachmentOf("# Scan\n\n## Notes")).toBeUndefined();
  });
});

describe("attachmentIdsIn", () => {
  it("collects every referenced id once, in order", () => {
    const second = "01JBQ2X4Y5Z6A7B8C9D0E1F2G4";
    const body = `![a](attachment://${ULID}) and ![b](attachment://${second}) and again ${ULID ? `attachment://${ULID}` : ""}`;
    expect(attachmentIdsIn(body)).toEqual([ULID, second]);
  });

  it("is empty for a body with no attachments", () => {
    expect(attachmentIdsIn("# Hello\n\nNo files here.")).toEqual([]);
  });
});

describe("previewKindFor", () => {
  it("maps the inline-previewable families", () => {
    expect(previewKindFor("image/png")).toBe("image");
    expect(previewKindFor("audio/mpeg")).toBe("audio");
    expect(previewKindFor("video/mp4")).toBe("video");
    expect(previewKindFor("application/pdf")).toBe("pdf");
    expect(previewKindFor("text/markdown")).toBe("text");
    expect(previewKindFor("application/json")).toBe("text");
  });

  it("never previews SVG inline (SPEC §3.6: stored-XSS vector)", () => {
    expect(previewKindFor("image/svg+xml")).toBe("file");
    expect(previewKindFor("IMAGE/SVG+XML; charset=utf-8")).toBe("file");
  });

  it("ignores parameters and case", () => {
    expect(previewKindFor("TEXT/PLAIN; charset=UTF-8")).toBe("text");
  });

  it("falls back to a file chip for anything unknown or missing", () => {
    expect(previewKindFor("application/octet-stream")).toBe("file");
    expect(previewKindFor(undefined)).toBe("file");
    expect(previewKindFor("")).toBe("file");
  });
});

describe("formatBytes", () => {
  it("formats binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MiB");
    expect(formatBytes(1024 * 1024 * 25)).toBe("25 MiB");
  });

  it("says so when the size is unknown", () => {
    expect(formatBytes(undefined)).toBe("unknown size");
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});
