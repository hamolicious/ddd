import { describe, expect, it } from "vitest";

import { notifyCreated, onCreated, type DocumentCreated } from "./index.js";

describe("doc-events", () => {
  it("tells every listener, until it unsubscribes", () => {
    const heard: DocumentCreated[] = [];
    const off = onCreated((doc) => heard.push(doc));
    notifyCreated({ id: "a", parent: "p" });
    off();
    notifyCreated({ id: "b" });
    expect(heard).toEqual([{ id: "a", parent: "p" }]);
  });

  it("keeps going past a listener that throws", () => {
    const heard: string[] = [];
    const offBad = onCreated(() => {
      throw new Error("boom");
    });
    const offGood = onCreated((doc) => heard.push(doc.id));
    notifyCreated({ id: "c" });
    offBad();
    offGood();
    expect(heard).toEqual(["c"]);
  });
});
