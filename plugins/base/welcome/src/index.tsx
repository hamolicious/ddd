import type { Kernel } from "@kernel";

import { notMachine } from "../../_shared/live-search.js";

import { MARKER_ID, MARKER_TEXT, TOUR } from "./content.js";

export default function activate(kernel: Kernel): void {
  let started = false;
  const unsubscribe = kernel.sync.subscribe((state) => {
    if (started || state.status !== "synced") return;
    started = true;
    queueMicrotask(() => unsubscribe());
    seed(kernel).catch((error: unknown) => kernel.log.warn("the welcome tour could not be seeded", error));
  });
}

async function seed(kernel: Kernel): Promise<void> {
  if (await kernel.documents.get(MARKER_ID)) return;

  const existing = await kernel.search.from().where(notMachine).trash("all").select("id").limit(1).run();
  if (existing.rows.length === 0) {
    const folders = await kernel.plugins
      .optional<typeof import("plugin:folders")>("folders")
      .catch((error: unknown) => {
        kernel.log.warn("folders unavailable; the tour notes are left unfiled", error);
        return undefined;
      });
    for (const note of TOUR) {
      const made = await createOnce(kernel, note.id, note.text);
      if (made && note.parent !== undefined) {
        await folders?.file(note.id, note.parent).catch((error: unknown) => {
          kernel.log.warn(`could not file the tour note ${note.id}`, error);
        });
      }
    }
  }
  await createOnce(kernel, MARKER_ID, MARKER_TEXT);
}

async function createOnce(kernel: Kernel, id: string, text: string): Promise<boolean> {
  try {
    await kernel.documents.create({ id, text });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409 || status === 410) return false;
    throw error;
  }
}
