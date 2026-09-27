import { describe, expect, it } from "vitest";

import { rewriteFrontmatterWikilinks, rewriteWikilinks, type LinkTarget } from "./links.js";

const TARGETS: readonly LinkTarget[] = [
  { kind: "document", id: "HOME", path: "Home.md", title: "Home", aliases: [] },
  { kind: "document", id: "ONE", path: "Projects/One.md", title: "Project One", aliases: ["First project"] },
  { kind: "document", id: "NEAR", path: "Projects/Daily/Note.md", title: "Nearby note", aliases: [] },
  { kind: "document", id: "FAR", path: "Archive/Note.md", title: "Archived note", aliases: [] },
  { kind: "attachment", id: "PHOTO_WRAPPER", attachmentId: "PHOTO", path: "Projects/Assets/photo.png", title: "photo.png", aliases: [] },
  { kind: "attachment", id: "PDF_WRAPPER", attachmentId: "PDF", path: "Files/manual.pdf", title: "manual.pdf", aliases: [] },
  { kind: "attachment", id: "DIAGRAM_WRAPPER", attachmentId: "DIAGRAM", path: "Projects/Assets/system diagram.svg", title: "system diagram.svg", aliases: [] },
];

describe("Obsidian wikilink conversion", () => {
  it("resolves paths, aliases, fragments, self-links and embeds", () => {
    const source = [
      "[[Projects/One]] [[First project|one]] [[Projects/One#Status|status]]",
      "[[#Top]] [[Projects/One^block-id]] ![[Home]]",
    ].join("\n");
    expect(rewriteWikilinks(source, "Home.md", TARGETS).text).toBe(
      [
        "[One](doc://ONE) [one](doc://ONE) [status](doc://ONE#Status)",
        "[Top](doc://HOME#Top) [One](doc://ONE#%5Eblock-id) ![](doc://HOME)",
      ].join("\n"),
    );
  });

  it("chooses the nearest duplicate basename", () => {
    expect(rewriteWikilinks("[[Note]]", "Projects/Today.md", TARGETS).text).toBe("[Note](doc://NEAR)");
  });

  it("resolves Obsidian embeds and Markdown file links to attachments", () => {
    const source = [
      "![[Assets/photo.png]] [[manual.pdf|manual]] ![[Assets/photo.png|300]]",
      "![photo](Assets/photo.png) [PDF](../Files/manual.pdf)",
    ].join("\n");
    expect(rewriteWikilinks(source, "Projects/Note.md", TARGETS).text).toBe(
      [
        "![photo.png](doc://PHOTO_WRAPPER) [manual](doc://PDF_WRAPPER) ![photo.png](doc://PHOTO_WRAPPER)",
        "![photo](doc://PHOTO_WRAPPER) [PDF](doc://PDF_WRAPPER)",
      ].join("\n"),
    );
  });

  it("resolves extension-hidden attachment embeds and encoded filenames", () => {
    const source = [
      "![[Assets/photo]] ![[system diagram|Architecture]]",
      "![diagram](Assets/system%20diagram.svg)",
    ].join("\n");
    expect(rewriteWikilinks(source, "Projects/Note.md", TARGETS).text).toBe(
      [
        "![photo.png](doc://PHOTO_WRAPPER) ![Architecture](doc://DIAGRAM_WRAPPER)",
        "![diagram](doc://DIAGRAM_WRAPPER)",
      ].join("\n"),
    );
  });

  it("keeps an extensionless document ahead of an attachment stem", () => {
    const targets: readonly LinkTarget[] = [
      ...TARGETS,
      { kind: "document", id: "PHOTO_NOTE", path: "Notes/photo.md", title: "photo", aliases: [] },
    ];
    expect(rewriteWikilinks("[[photo]]", "Projects/Note.md", targets).text).toBe(
      "[photo](doc://PHOTO_NOTE)",
    );
  });

  it("migrates attachment URLs from earlier imports to their wrapper documents", () => {
    const source = "![photo](attachment://PHOTO) [manual](attachment:PDF)";
    const result = rewriteWikilinks(source, "Projects/Note.md", TARGETS);
    expect(result.text).toBe(
      "![photo](doc://PHOTO_WRAPPER) [manual](doc://PDF_WRAPPER)",
    );
    expect(result).toMatchObject({ resolved: 2, unresolved: 0 });
  });

  it("leaves unresolved links and code untouched", () => {
    const source = ["[[Missing]] `[[Home]]`", "```md", "[[Home]]", "```"].join("\n");
    const result = rewriteWikilinks(source, "Home.md", TARGETS);
    expect(result.text).toBe(source);
    expect(result).toMatchObject({ resolved: 0, unresolved: 1 });
  });

  it("does not rewrite frontmatter or plugin metadata", () => {
    const source = ["---", "related: '[[Home]]'", "---", "[[Home]]", "", "%%% x", "value: '[[Home]]'", "%%%"].join("\n");
    expect(rewriteWikilinks(source, "Projects/One.md", TARGETS).text).toContain(
      "related: '[[Home]]'\n---\n[Home](doc://HOME)\n\n%%% x\nvalue: '[[Home]]'",
    );
  });

  it("resolves frontmatter scalars, lists and nested maps", () => {
    const result = rewriteFrontmatterWikilinks(
      {
        hub: "[[Home]]",
        hubs: ["[[Projects/One]]", "[[First project]]", "plain"],
        project: { parent: "[[Projects/One#Status]]" },
        missing: "[[Missing]]",
        cover: "![[Assets/photo.png]]",
      },
      "Home.md",
      TARGETS,
    );
    expect(Object.fromEntries(result.values)).toEqual({
      hub: "doc://HOME",
      hubs: ["doc://ONE", "doc://ONE", "plain"],
      project: { parent: "doc://ONE#Status" },
      cover: "doc://PHOTO_WRAPPER",
    });
    expect(result).toMatchObject({ resolved: 5, unresolved: 1 });
  });

  it("migrates attachment URLs in frontmatter", () => {
    const result = rewriteFrontmatterWikilinks(
      { cover: "attachment://PHOTO", files: ["attachment:PDF", "plain"] },
      "Home.md",
      TARGETS,
    );
    expect(Object.fromEntries(result.values)).toEqual({
      cover: "doc://PHOTO_WRAPPER",
      files: ["doc://PDF_WRAPPER", "plain"],
    });
    expect(result).toMatchObject({ resolved: 2, unresolved: 0 });
  });
});
