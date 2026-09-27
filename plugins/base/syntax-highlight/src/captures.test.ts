import { describe, expect, it } from "vitest";

import { captureClass } from "./captures.js";

describe("captureClass", () => {
  it("colours a known capture", () => {
    expect(captureClass("keyword")).toBe("lmsh-keyword");
    expect(captureClass("constant.builtin")).toBe("lmsh-constant-builtin");
  });

  it("falls back to the nearest known prefix", () => {
    expect(captureClass("function.method.call")).toBe("lmsh-function");
    expect(captureClass("string.special.key")).toBe("lmsh-string-special");
  });

  it("maps the other names grammars use", () => {
    expect(captureClass("boolean")).toBe("lmsh-constant-builtin");
    expect(captureClass("field")).toBe("lmsh-property");
  });

  it("leaves what it does not know uncoloured", () => {
    expect(captureClass("variable")).toBeUndefined();
    expect(captureClass("spell")).toBeUndefined();
  });
});
