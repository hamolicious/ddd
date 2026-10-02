import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { usedBy, type HealthClient } from "./api.js";
import { HealthSection } from "./Health.js";

const never = (): Promise<never> => new Promise(() => {});
const client: HealthClient = {
  orphans: never,
  scanOrphans: never,
  duplicateFiles: never,
  duplicateDocuments: never,
  deleteAttachment: never,
  trashDocument: never,
};

describe("HealthSection", () => {
  it("shows both checks, loading", () => {
    const html = renderToStaticMarkup(<HealthSection client={client} confirm={() => Promise.resolve(false)} />);
    expect(html).toContain("Orphan files");
    expect(html).toContain("Duplicates");
    expect(html).toContain("Loading…");
  });
});

describe("usedBy", () => {
  it("says nothing, one note or several", () => {
    expect(usedBy(0)).toBe("Nothing");
    expect(usedBy(1)).toBe("1 note");
    expect(usedBy(3)).toBe("3 notes");
  });
});
