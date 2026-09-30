import { afterEach, describe, expect, it, vi } from "vitest";

import { pageMapLacksPlugins } from "./importmap.js";

/** A page whose one `<script type="importmap">` holds `map` (or no page map at all). */
function servePage(map: unknown): void {
  const script = map === undefined ? null : { textContent: JSON.stringify(map) };
  vi.stubGlobal("document", { querySelector: () => script });
}

describe("pageMapLacksPlugins", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true for the signed-out map: the runtime layer and no plugin entry", () => {
    servePage({ imports: { react: "/runtime/react.js", "@kernel": "/runtime/kernel.js" } });
    expect(pageMapLacksPlugins()).toBe(true);
  });

  it("is false once the map names a plugin", () => {
    servePage({ imports: { react: "/runtime/react.js", "plugin:header": "/plugins/header/2.0.0/frontend/index.mjs" } });
    expect(pageMapLacksPlugins()).toBe(false);
  });

  it("is false in dev, where there is no server map to reload for", () => {
    servePage(undefined);
    expect(pageMapLacksPlugins()).toBe(false);
  });
});
