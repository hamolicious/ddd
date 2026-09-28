/**
 * `folder-style` — a background colour and an icon for any folder. The name and icon on
 * the background are black or white, whichever has more contrast (`textOn`).
 *
 * `folders` knows nothing about this plugin. It hosts two slots and announces moves, and
 * this plugin fills them:
 *
 * - `look` (`lm/folders.decoration`) answers each folder row's colour and icon;
 * - `edit` (`lm/folders.menu-item`) adds "Color and icon…" to a folder's menu, which opens
 *   the `Editor` in a sheet;
 * - `moved` (`lm/folders.moved`) is how a look follows its folder through a rename, or
 *   goes with it when the folder is deleted.
 *
 * Icons come from whatever serves `lm/icons` (the base `icons` plugin draws Tabler).
 * That port is optional: without it folders still take a colour, and a stored icon name
 * waits, unused, until an icon set is wired again.
 *
 * ## Per-user, in settings
 *
 * One list, `styles`, one line per folder (`styles.ts` has the format). Each person dresses
 * their own tree. Two devices changing looks at the same moment write the same key, and
 * the later line wins (SPEC §3.3): for a cosmetic setting that is an acceptable loss.
 */

import type { ReactElement } from "react";

import type { CoreValue, Kernel, SettingsValue } from "@kernel";

import type { ContextMenu } from "@protocols/lm/context-menu";
import type { FolderDecoration } from "@protocols/lm/folders.decoration";
import type { FolderMenuItem } from "@protocols/lm/folders.menu-item";
import type { FolderMoved } from "@protocols/lm/folders.moved";
import type { Icons } from "@protocols/lm/icons";

import { Editor } from "./Editor.js";
import {
  followMove,
  parseStyles,
  sameStyles,
  serializeStyles,
  textOn,
  withStyle,
  type Styles,
} from "./styles.js";

const STYLES_KEY = "styles";

/** A colour dragged across the picker is dozens of changes; the setting takes the last. */
const WRITE_DEBOUNCE_MS = 400;

export default function activate(kernel: Kernel): void {
  const menu = kernel.ports.use<Pick<ContextMenu, "openSheet">>("menu");
  // Optional, and rewirable while running: asked for each time rather than kept.
  const icons = (): Pick<Icons, "Icon" | "Picker"> | undefined =>
    kernel.ports.bound("icons") ? kernel.ports.use<Pick<Icons, "Icon" | "Picker">>("icons") : undefined;

  kernel.settings.defineSchema({
    // Rendered by the folder tree rather than by a settings row: declared for its default
    // and so a reader of the settings document knows what wrote the line.
    [STYLES_KEY]: { type: "list", default: [] },
  });

  let styles: Styles = parseStyles(kernel.settings.get(STYLES_KEY));
  const listeners = new Set<() => void>();
  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const write = (): void => {
    writeTimer = undefined;
    const value = serializeStyles(styles) as readonly CoreValue[] as SettingsValue;
    writes = writes
      .then(() => kernel.settings.set(STYLES_KEY, value))
      .catch((cause: unknown) => kernel.log.warn("could not store the folder looks", cause));
  };
  const change = (next: Styles): void => {
    if (sameStyles(styles, next)) return;
    styles = next;
    publish();
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = setTimeout(write, WRITE_DEBOUNCE_MS);
  };
  /** Write now what is waiting, if anything: the sheet closing, or the plugin stopping. */
  const flush = (): void => {
    if (writeTimer === undefined) return;
    clearTimeout(writeTimer);
    write();
  };
  flushOnStop = flush;

  // Another device, another tab, or our own write coming back. Not while a local write is
  // waiting: adopting the stored value then would undo what is on screen.
  try {
    kernel.settings.subscribe(() => {
      if (writeTimer !== undefined) return;
      const stored = parseStyles(kernel.settings.get(STYLES_KEY));
      if (sameStyles(styles, stored)) return;
      styles = stored;
      publish();
    });
  } catch (cause) {
    kernel.log.warn("folder look changes on other devices will not be followed", cause);
  }

  kernel.ports.on<FolderMoved>("moved", (event) => change(followMove(styles, event)));

  kernel.ports.offer<FolderDecoration>("look", {
    id: "folder-style",
    decorate: (path) => {
      const style = styles.get(path);
      if (style === undefined) return undefined;
      const set = style.icon !== undefined ? icons() : undefined;
      return {
        ...(style.background !== undefined
          ? { background: style.background, color: textOn(style.background) }
          : {}),
        ...(set !== undefined && style.icon !== undefined ? { icon: <set.Icon name={style.icon} /> } : {}),
      };
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });

  kernel.ports.offer<FolderMenuItem>("edit", {
    id: "folder-style.edit",
    label: "Color and icon…",
    run: (path, anchor) => {
      menu.openSheet({
        title: "Color and icon",
        ...(anchor !== undefined ? { anchor } : {}),
        // The debounce is for dragging across the colour picker, not for after the sheet
        // is gone: a reload straight after closing it must not lose the look.
        onClose: flush,
        render: (): ReactElement => (
          <Editor
            path={path}
            initial={styles.get(path)}
            icons={icons()}
            onChange={(next) => {
              const style = withStyle(styles.get(path), next);
              const updated = new Map(styles);
              if (style === undefined) updated.delete(path);
              else updated.set(path, style);
              change(updated);
            }}
          />
        ),
      });
    },
  });
}

/** A look change still waiting to be written; the kernel withdraws everything else (§6c). */
let flushOnStop: (() => void) | undefined;

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
}
