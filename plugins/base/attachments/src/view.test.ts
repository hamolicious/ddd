/**
 * The `viewers` host as `view.tsx` reads it (PLUGIN-PROTOCOLS §6a, "Hosts stop sorting"):
 * the host is already in the wiring's seat order, so the first viewer claiming an extension
 * is its default, and an item's `order` hint means nothing here any more.
 */

import { describe, expect, it } from "vitest";

import type { Kernel, SettingsValue, SlotHost, SlotItem } from "@kernel";
import type { AttachmentViewer } from "@protocols/lm/attachments.viewer";

import { viewKey } from "./kinds.js";
import { createViewers } from "./view.js";

const kernel = { settings: { subscribe: () => () => undefined } } as unknown as Kernel;

const viewer = (id: string, extensions: readonly string[], order?: number): AttachmentViewer => ({
  id,
  label: id,
  extensions,
  component: () => null,
  ...(order === undefined ? {} : { order }),
});

/** A host in a fixed seat order, with a way to seat one more. */
function host(seated: readonly SlotItem<AttachmentViewer>[]) {
  const items = [...seated];
  const listeners = new Set<(values: readonly AttachmentViewer[]) => void>();
  const slot: SlotHost<AttachmentViewer> = {
    get: () => items.map((item) => item.value),
    entries: () => [...items],
    subscribe: (listener) => {
      listeners.add(listener);
      listener(slot.get());
      return () => void listeners.delete(listener);
    },
  };
  return {
    slot,
    seat(item: SlotItem<AttachmentViewer>) {
      items.push(item);
      for (const listener of [...listeners]) listener(slot.get());
    },
  };
}

const seat = (pluginId: string, value: AttachmentViewer): SlotItem<AttachmentViewer> => ({ pluginId, port: "viewers", value });

describe("createViewers", () => {
  it("takes the first seat as the default, whatever the order hints say", () => {
    const { slot } = host([
      seat("late", viewer("late.image", ["png", "jpg"], 200)),
      seat("early", viewer("early.image", ["png"], 1)),
    ]);
    const viewers = createViewers(kernel, slot, () => undefined);

    expect(viewers.candidates("png").map((v) => v.id)).toEqual(["late.image", "early.image"]);
    expect(viewers.resolve("png")).toMatchObject({ pluginId: "late", viewer: { id: "late.image" } });
    expect(viewers.resolve("jpg")?.viewer.id).toBe("late.image");
    expect(viewers.resolve("pdf")).toBeUndefined();
  });

  it("lets the user's pick in Settings win over the seat", () => {
    const { slot } = host([seat("late", viewer("late.image", ["png"])), seat("early", viewer("early.image", ["png"]))]);
    const read = (key: string): SettingsValue | undefined => (key === viewKey("png") ? "early.image" : undefined);
    const viewers = createViewers(kernel, slot, read);

    expect(viewers.resolve("png")?.viewer.id).toBe("early.image");
  });

  it("follows the host as viewers are wired in", () => {
    const { slot, seat: wire } = host([seat("native", viewer("native.image", ["png"]))]);
    const viewers = createViewers(kernel, slot, () => undefined);
    let changes = 0;
    viewers.subscribe(() => {
      changes += 1;
    });

    expect(viewers.extensions()).toEqual(["png"]);
    wire(seat("pdfjs", viewer("pdfjs.viewer", ["pdf"])));
    expect(changes).toBe(1);
    expect(viewers.extensions()).toEqual(["pdf", "png"]);
    expect(viewers.resolve("pdf")?.pluginId).toBe("pdfjs");
  });
});
