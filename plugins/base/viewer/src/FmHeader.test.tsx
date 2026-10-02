import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FmHeader } from "./FmHeader.js";

const link = (id: string) => <a data-note={id}>note {id}</a>;

describe("FmHeader", () => {
  it("draws a doc:// value as a link to the note, alone and in a list", () => {
    const html = renderToStaticMarkup(
      <FmHeader fm={{ hub: "doc://01ABC", hubs: ["doc://01DEF", "plain"] }} renderDocLink={link} />,
    );
    expect(html).toContain('data-note="01ABC"');
    expect(html).toContain('data-note="01DEF"');
    expect(html).toContain(">plain<");
    expect(html).not.toContain("doc://");
  });

  it("leaves doc:// as text without a link renderer, and text that only mentions one", () => {
    const html = renderToStaticMarkup(<FmHeader fm={{ hub: "doc://01ABC", note: "see doc://01ABC" }} />);
    expect(html).toContain("doc://01ABC");
    expect(renderToStaticMarkup(<FmHeader fm={{ note: "see doc://01ABC" }} renderDocLink={link} />)).not.toContain(
      "data-note",
    );
  });

  it("keeps the full-width flag out of the properties, and takes the wide column", () => {
    const html = renderToStaticMarkup(<FmHeader fm={{ "full-width": true, status: "draft" }} fullWidth />);
    expect(html).not.toContain("full-width");
    expect(html).toContain("viewer:px-[15px]");
    expect(renderToStaticMarkup(<FmHeader fm={{ "full-width": true }} />)).toBe("");
  });
});
