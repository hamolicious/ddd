/**
 * `doc-events` — "a note was just made here", from the views that make notes to the
 * plugins that react (the folder tree files it under its `parent`).
 *
 * ## API (`plugin:doc-events`)
 *
 * - `notifyCreated(doc: DocumentCreated): void` — call once, after the create went
 *   through and before the note opens.
 * - `onCreated(listener: (doc: DocumentCreated) => void): Unsubscribe`
 * - Type: `DocumentCreated` — `{ id, parent? }`, the old `ddd/document-browser.created`
 *   payload.
 *
 * A leaf with no dependencies and no UI, so both sides can depend on it without a cycle
 * (a view that makes notes need not know the tree, nor the tree every view). Everything
 * lives at module scope: it works before `activate`, and a listener that throws is logged
 * and does not stop the others.
 */

import type { Kernel, Unsubscribe } from "@kernel";

/** A document was just created on this device. */
export interface DocumentCreated {
  readonly id: string;
  /** Where the caller wants it filed (a note id), when it said. */
  readonly parent?: string;
}

const listeners = new Set<(doc: DocumentCreated) => void>();
let warn: (message: string, error: unknown) => void = (message, error) => console.warn(`[doc-events] ${message}`, error);

/** Hear about every note created on this device from now on. */
export function onCreated(listener: (doc: DocumentCreated) => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announce a note just created: once, after the create went through, before it opens. */
export function notifyCreated(doc: DocumentCreated): void {
  for (const listener of [...listeners]) {
    try {
      listener(doc);
    } catch (error) {
      warn("a created listener threw", error);
    }
  }
}

export default function activate(kernel: Kernel): void {
  warn = (message, error) => kernel.log.warn(message, error);
}
