/**
 * `welcome` — fills a new, empty workspace with a short tour (`content.ts`): one note per
 * base feature, under the `welcome` folder, all deletable.
 *
 * **Once per workspace.** After the first complete sync, if the hidden marker note is
 * missing: an empty workspace gets the tour, a workspace that already has notes gets
 * nothing. Either way the marker is written, so it is never offered again, and deleted
 * tour notes stay deleted.
 *
 * **Safe to race.** Every note has a fixed id, so two devices seeding at once cannot
 * duplicate anything: the second create of an id is refused (409), and an id that was
 * deleted for good is refused too (410). Both are skipped.
 *
 * It needs the server (a create is a REST call), so it waits for `synced` and does
 * nothing offline.
 */

import type { Kernel } from "@kernel";

import { withoutMachineDocuments } from "../../_shared/machine-docs.js";

import { MARKER_ID, MARKER_TEXT, TOUR } from "./content.js";

export default function activate(kernel: Kernel): void {
  let started = false;
  const unsubscribe = kernel.sync.subscribe((state) => {
    if (started || state.status !== "synced") return;
    started = true;
    // Unsubscribed from outside the callback: it fires once synchronously on subscribe.
    queueMicrotask(() => unsubscribe());
    seed(kernel).catch((error: unknown) => kernel.log.warn("the welcome tour could not be seeded", error));
  });
}

async function seed(kernel: Kernel): Promise<void> {
  if (await kernel.documents.get(MARKER_ID)) return;

  const existing = await kernel.documents.query({
    filter: withoutMachineDocuments(),
    limit: 1,
    includeDeleted: true,
  });
  if (existing.total === 0) {
    for (const note of TOUR) await createOnce(kernel, note.id, note.text);
  }
  await createOnce(kernel, MARKER_ID, MARKER_TEXT);
}

/** Create, treating "already exists" and "deleted for good" as done. */
async function createOnce(kernel: Kernel, id: string, text: string): Promise<void> {
  try {
    await kernel.documents.create({ id, text });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409 || status === 410) return;
    throw error;
  }
}
