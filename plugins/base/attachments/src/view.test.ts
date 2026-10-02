import { describe, expect, it } from "vitest";

import type { Kernel, RegistryEntry, SettingsValue } from "@kernel";

import type { AttachmentViewer } from "./api.js";

import { viewKey } from "./kinds.js";
import { createViewers, type ViewerSource } from "./view.js";

const kernel = { settings: { subscribe: () => () => undefined } } as unknown as Kernel;

const viewer = (id: string, extensions: readonly string[], order?: number): AttachmentViewer => ({
  id,
  label: id,
  extensions,
  component: () => null,
  ...(order === undefined ? {} : { order }),
});

function host(seated: readonly RegistryEntry<AttachmentViewer>[]) {
  const items = [...seated];
  const listeners = new Set<(values: readonly AttachmentViewer[]) => void>();
  const slot: ViewerSource = {
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
    seat(item: RegistryEntry<AttachmentViewer>) {
      items.push(item);
      for (const listener of [...listeners]) listener(slot.get());
    },
  };
}

const seat = (pluginId: string, value: AttachmentViewer): RegistryEntry<AttachmentViewer> => ({ pluginId, value });

describe("createViewers", () => {
  it("takes the first in the registry's order as the default", () => {
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

  it("lets the user's pick in Settings win over the order", () => {
    const { slot } = host([seat("late", viewer("late.image", ["png"])), seat("early", viewer("early.image", ["png"]))]);
    const read = (key: string): SettingsValue | undefined => (key === viewKey("png") ? "early.image" : undefined);
    const viewers = createViewers(kernel, slot, read);

    expect(viewers.resolve("png")?.viewer.id).toBe("early.image");
  });

  it("follows the registry as viewers are added", () => {
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
