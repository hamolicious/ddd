import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChildrenFooter, type ChildrenSource } from "./ChildrenFooter.js";

const link = (id: string) => <a data-note={id}>note {id}</a>;
const tree = (children: Readonly<Record<string, readonly string[]>>): ChildrenSource => ({
  childrenOf: (id) => children[id] ?? [],
  onChange: () => () => undefined,
});

describe("ChildrenFooter", () => {
  it("lists the notes inside, in the tree's order, each a note to right-click", () => {
    const html = renderToStaticMarkup(<ChildrenFooter id="p" folders={tree({ p: ["b", "a"] })} renderDocLink={link} />);
    expect(html).toContain("Inside this note");
    expect(html.indexOf('data-note="b"')).toBeLessThan(html.indexOf('data-note="a"'));
    expect(html).toContain('data-lm-target="lm/document"');
    expect(html).toContain('data-lm-target-id="a"');
  });

  it("drops the rule above the list when there is no body to divide it from", () => {
    const html = (divided: boolean) =>
      renderToStaticMarkup(<ChildrenFooter id="p" folders={tree({ p: ["a"] })} renderDocLink={link} divided={divided} />);
    expect(html(true)).toContain("border-t");
    expect(html(false)).not.toContain("border-t");
  });

  it("draws nothing for a note with nothing inside", () => {
    expect(renderToStaticMarkup(<ChildrenFooter id="leaf" folders={tree({})} renderDocLink={link} />)).toBe("");
  });
});
