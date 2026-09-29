/**
 * `folder-style` — a background colour and an icon for any folder. The name and icon on
 * the background are black or white, whichever has more contrast (`textOn`).
 *
 * `folders` knows nothing about this plugin. It hosts two slots and this plugin fills
 * them, both keyed by note id — which never changes, so a look follows its note through
 * every rename and move with nothing to do:
 *
 * - `look` (`lm/folders.decoration`) answers each row's colour and icon;
 * - `edit` (`lm/folders.menu-item`) adds "Color and icon…" to a row's menu, which opens
 *   the `Editor` in a sheet.
 *
 * A `settings` section sets the defaults and the rules (`Rules.tsx`): conditions, as in
 * the document list's filters, and the look of the notes that match (`matcher.ts`). A
 * note's own colour and icon always win, then the first matching rule, then the default,
 * field by field (`resolveStyle`).
 *
 * Icons come from whatever serves `lm/icons` (the base `icons` plugin draws Tabler).
 * That port is optional: without it folders still take a colour, and a stored icon name
 * waits, unused, until an icon set is wired again.
 *
 * ## Per-user, in settings
 *
 * One list, `styles`, one line per note (`styles.ts` has the format). Each person dresses
 * their own tree. Two devices changing looks at the same moment write the same key, and
 * the later line wins (SPEC §3.3): for a cosmetic setting that is an acceptable loss.
 */

import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import type { CoreValue, Kernel, SettingsValue } from "@kernel";

import type { ContextMenu } from "@protocols/lm/context-menu";
import type { FolderDecoration } from "@protocols/lm/folders.decoration";
import type { FolderMenuItem } from "@protocols/lm/folders.menu-item";
import type { Icons } from "@protocols/lm/icons";
import type { SettingsSection } from "@protocols/lm/settings.section";

import { noteLookup, type NoteLookup } from "../../_shared/conditions-editor.js";
import {
  indexNoteLookup,
  indexSuggestions,
  type ConditionIndex,
  type Suggestions,
} from "../../_shared/conditions-index.js";

import { Editor } from "./Editor.js";
import { ruleMatcher } from "./matcher.js";
import { Rules } from "./Rules.js";
import {
  parseDefaults,
  parseRules,
  parseStyles,
  resolveStyle,
  sameRules,
  sameStyle,
  sameStyles,
  serializeRules,
  serializeStyles,
  textOn,
  withStyle,
  type FolderStyle,
  type Rule,
  type Styles,
} from "./styles.js";

const STYLES_KEY = "styles";
const DEFAULT_BACKGROUND_KEY = "defaultBackground";
const DEFAULT_ICON_KEY = "defaultIcon";
const RULES_KEY = "rules";

/** A colour dragged across the picker is dozens of changes; the setting takes the last. */
const WRITE_DEBOUNCE_MS = 400;

/**
 * One piece of state kept in settings: changed at once in memory, written after a pause.
 * `adopt` takes the stored value — another device, another tab, or our own write coming
 * back — but not while a local write is waiting: that would undo what is on screen.
 */
interface Stored<T> {
  get(): T;
  change(next: T): void;
  /** Write now what is waiting, if anything: a sheet closing, or the plugin stopping. */
  flush(): void;
  /** `true` when the stored value replaced the one in memory. */
  adopt(): boolean;
}

export default function activate(kernel: Kernel): void {
  const menu = kernel.ports.use<Pick<ContextMenu, "openSheet">>("menu");
  // Optional, and rewirable while running: asked for each time rather than kept.
  const icons = (): Pick<Icons, "Icon" | "Picker"> | undefined =>
    kernel.ports.bound("icons") ? kernel.ports.use<Pick<Icons, "Icon" | "Picker">>("icons") : undefined;

  kernel.settings.defineSchema({
    // Rendered by the folder tree rather than by a settings row: declared for its default
    // and so a reader of the settings document knows what wrote the line.
    [STYLES_KEY]: { type: "list", default: [] },
    // The rest are rendered by this plugin's own section. Empty is "none".
    [DEFAULT_BACKGROUND_KEY]: { type: "string", default: "" },
    [DEFAULT_ICON_KEY]: { type: "string", default: "" },
    [RULES_KEY]: { type: "list", default: [] },
  });

  const listeners = new Set<() => void>();
  let version = 0;
  const publish = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  let writes: Promise<unknown> = Promise.resolve();
  const stored = <T,>(
    read: () => T,
    write: (value: T) => Promise<unknown>,
    same: (a: T, b: T) => boolean,
    what: string,
    onChange: () => void = () => {},
  ): Stored<T> => {
    let value = read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
      timer = undefined;
      const snapshot = value;
      writes = writes
        .then(() => write(snapshot))
        .catch((cause: unknown) => kernel.log.warn(`could not store ${what}`, cause));
    };
    return {
      get: () => value,
      change(next) {
        if (same(value, next)) return;
        value = next;
        onChange();
        publish();
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(save, WRITE_DEBOUNCE_MS);
      },
      flush() {
        if (timer === undefined) return;
        clearTimeout(timer);
        save();
      },
      adopt() {
        if (timer !== undefined) return false;
        const next = read();
        if (same(value, next)) return false;
        value = next;
        onChange();
        return true;
      },
    };
  };

  const styles = stored<Styles>(
    () => parseStyles(kernel.settings.get(STYLES_KEY)),
    (value) => kernel.settings.set(STYLES_KEY, serializeStyles(value) as readonly CoreValue[] as SettingsValue),
    sameStyles,
    "the folder looks",
  );
  const defaults = stored<FolderStyle>(
    () => parseDefaults(kernel.settings.get(DEFAULT_BACKGROUND_KEY), kernel.settings.get(DEFAULT_ICON_KEY)),
    async ({ background = "", icon = "" }) => {
      await kernel.settings.set(DEFAULT_BACKGROUND_KEY, background);
      await kernel.settings.set(DEFAULT_ICON_KEY, icon);
    },
    sameStyle,
    "the default folder look",
  );
  const matcher = ruleMatcher(kernel.documents, publish, (cause) =>
    kernel.log.warn("a folder style rule could not be run", cause),
  );
  const rules = stored<readonly Rule[]>(
    () => parseRules(kernel.settings.get(RULES_KEY)),
    (value) => kernel.settings.set(RULES_KEY, serializeRules(value) as readonly CoreValue[] as SettingsValue),
    sameRules,
    "the folder style rules",
    () => matcher.set(rules.get()),
  );
  matcher.set(rules.get());
  const all = [styles, defaults, rules] as const;

  flushOnStop = () => {
    for (const each of all) each.flush();
    matcher.close();
  };

  try {
    kernel.settings.subscribe(() => {
      // Every one of them, not the first that changed.
      const changed = all.map((each) => each.adopt());
      if (changed.some(Boolean)) publish();
    });
  } catch (cause) {
    kernel.log.warn("folder look changes on other devices will not be followed", cause);
  }

  kernel.ports.offer<FolderDecoration>("look", {
    id: "folder-style",
    decorate: (id) => {
      const style = resolveStyle(styles.get().get(id), defaults.get(), matcher.matched(id));
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
    run: (id, anchor) => {
      void kernel.documents.get(id).then((row) => {
        menu.openSheet({
          title: "Color and icon",
          ...(anchor !== undefined ? { anchor } : {}),
          // The debounce is for dragging across the colour picker, not for after the sheet
          // is gone: a reload straight after closing it must not lose the look.
          onClose: styles.flush,
          render: (): ReactElement => (
            <Editor
              name={row?.title || "Untitled"}
              initial={styles.get().get(id)}
              // What it shows without a look of its own: the rules it matches, the default.
              fallback={resolveStyle(undefined, defaults.get(), matcher.matched(id)) ?? {}}
              icons={icons()}
              onChange={(next) => {
                const style = withStyle(styles.get().get(id), next);
                const updated = new Map(styles.get());
                if (style === undefined) updated.delete(id);
                else updated.set(id, style);
                styles.change(updated);
              }}
            />
          ),
        });
      });
    },
  });

  // The indexer, when wired, suggests properties and values and finds notes offline.
  // Rewirable while running, like `icons`: the section asks on each render.
  const index = (): ConditionIndex | undefined =>
    kernel.ports.bound("index") ? kernel.ports.use<ConditionIndex>("index") : undefined;
  const fallbackNotes = noteLookup(kernel.documents);
  let lookups: { index: ConditionIndex | undefined; notes: NoteLookup; suggestions: Suggestions | undefined } | undefined;
  /** One lookup per wired index, so the editor's subscription is not renewed every render. */
  const lookupsFor = (current: ConditionIndex | undefined) => {
    if (lookups?.index !== current || lookups === undefined) {
      lookups = {
        index: current,
        notes: current !== undefined ? indexNoteLookup(current) : fallbackNotes,
        suggestions: current !== undefined ? indexSuggestions(current) : undefined,
      };
    }
    return lookups;
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** The defaults, then the rules. Written as they change; leaving the section flushes. */
  const Section = (): ReactElement => {
    useSyncExternalStore(subscribe, () => version);
    const { notes, suggestions } = lookupsFor(index());
    useEffect(
      () => () => {
        defaults.flush();
        rules.flush();
      },
      [],
    );
    return (
      <div className="folderstyle:flex folderstyle:flex-col folderstyle:gap-4">
        <section className="folderstyle:flex folderstyle:flex-col folderstyle:gap-2">
          <h3 className="folderstyle:m-0 folderstyle:text-base">Every note</h3>
          <Editor
            name="Any note"
            initial={defaults.get()}
            icons={icons()}
            onChange={(next) => defaults.change(withStyle(defaults.get(), next) ?? {})}
          />
        </section>
        <Rules
          rules={rules.get()}
          onChange={rules.change}
          defaults={defaults.get()}
          icons={icons()}
          notes={notes}
          {...(suggestions !== undefined ? { suggestions } : {})}
          openLook={(rule, anchor) =>
            menu.openSheet({
              title: "Color and icon",
              anchor,
              onClose: rules.flush,
              render: (): ReactElement => (
                <Editor
                  name="Matching notes"
                  initial={rule.style}
                  fallback={defaults.get()}
                  icons={icons()}
                  onChange={(next) => {
                    const current = rules.get();
                    rules.change(
                      current.map((each) =>
                        each.id === rule.id ? { ...each, style: withStyle(each.style, next) ?? {} } : each,
                      ),
                    );
                  }}
                />
              ),
            })
          }
        />
      </div>
    );
  };

  kernel.ports.offer<SettingsSection>("settings", {
    id: "folder-style",
    title: "Folder colors and icons",
    order: 35,
    description: "The color and icon of notes in the folder tree that do not set their own.",
    component: Section,
  });
}

/** Looks still waiting to be written, and the rules' queries; the kernel withdraws everything else (§6c). */
let flushOnStop: (() => void) | undefined;

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
}
