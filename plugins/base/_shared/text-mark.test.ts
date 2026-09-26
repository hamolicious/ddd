import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { markAt, trackInsertion } from "./text-mark.js";

function textOf(initial: string): Y.Text {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, initial);
  return text;
}

describe("trackInsertion", () => {
  it("replaces the inserted text after edits before and after it", () => {
    const text = textOf("ab");
    text.insert(1, "[up]");
    const slot = trackInsertion(text, 1, "[up]");
    text.insert(0, "xx");
    text.insert(text.length, "yy");
    expect(slot.replace("DONE")).toBe(true);
    expect(text.toString()).toBe("xxaDONEbyy");
  });

  it("keeps typing right next to it outside", () => {
    const text = textOf("");
    text.insert(0, "[up]");
    const slot = trackInsertion(text, 0, "[up]");
    text.insert(0, "<");
    text.insert(text.length, ">");
    expect(slot.replace("ok")).toBe(true);
    expect(text.toString()).toBe("<ok>");
  });

  it("leaves it alone once the user edited it", () => {
    const text = textOf("");
    text.insert(0, "[up]");
    const slot = trackInsertion(text, 0, "[up]");
    text.insert(2, "!");
    expect(slot.replace("ok")).toBe(false);
    expect(text.toString()).toBe("[u!p]");
  });

  it("does nothing when it was deleted", () => {
    const text = textOf("a");
    text.insert(1, "[up]");
    const slot = trackInsertion(text, 1, "[up]");
    text.delete(1, 4);
    expect(slot.remove()).toBe(false);
    expect(text.toString()).toBe("a");
  });

  it("settles after one replace", () => {
    const text = textOf("");
    text.insert(0, "[up]");
    const slot = trackInsertion(text, 0, "[up]");
    expect(slot.remove()).toBe(true);
    expect(slot.replace("again")).toBe(false);
    expect(text.toString()).toBe("");
  });

  it("follows the same document on another replica", () => {
    const text = textOf("hello");
    text.insert(5, "[up]");
    const slot = trackInsertion(text, 5, "[up]");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(text.doc!));
    remote.getText("t").insert(0, "> ");
    Y.applyUpdate(text.doc!, Y.encodeStateAsUpdate(remote));
    expect(slot.replace(" world")).toBe(true);
    expect(text.toString()).toBe("> hello world");
  });
});

describe("markAt", () => {
  it("inserts at the spot, in order, after edits elsewhere", () => {
    const text = textOf("ab");
    const mark = markAt(text, 1);
    text.insert(0, ">");
    text.insert(text.length, "<");
    mark.insert("1");
    mark.insert("2");
    expect(text.toString()).toBe(">a12b<");
  });

  it("hands back an insertion that can be replaced", () => {
    const text = textOf("");
    const slot = markAt(text, 0).insert("[up]");
    text.insert(0, "x ");
    expect(slot.replace("done")).toBe(true);
    expect(text.toString()).toBe("x done");
  });
});
