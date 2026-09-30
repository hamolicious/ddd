/**
 * `folder-style` — a background colour and an icon for any folder. The name and icon on
 * the background are black or white, whichever has more contrast (`textOn`).
 *
 * `folders` knows nothing about this plugin. This plugin adds to two hosts, both keyed by
 * note id — which never changes, so a look follows its note through every rename and move
 * with nothing to do:
 *
 * - `addDecoration` (`plugin:folders`) answers each row's colour and icon;
 * - `addAction` (`plugin:context-menu`) adds "Color and icon…" to a note's menu, wherever
 *   the note is right-clicked; it opens the `Editor` in a sheet.
 *
 * A `settings` section sets the defaults and the rules (`Rules.tsx`): conditions, as in
 * the document list's filters, and the look of the notes that match (`matcher.ts`). A
 * note's own colour and icon always win, then the first matching rule, then the default,
 * field by field (`resolveStyle`).
 *
 * Icons come from the `icons` plugin (Tabler), an optional dependency: without it folders
 * still take a colour, and a stored icon name waits, unused, until `icons` is enabled.
 * A rule's note is picked with `search`'s `NoteSelect`, also optional: without it, with the
 * shared note picker.
 *
 * ## Per-user, in settings
 *
 * One list, `styles`, one line per note (`styles.ts` has the format). Each person dresses
 * their own tree. Two devices changing looks at the same moment write the same key, and
 * the later line wins (SPEC §3.3): for a cosmetic setting that is an acceptable loss.
 */

import { useEffect, useSyncExternalStore, type ComponentType, type ReactElement } from "react";

import type { CoreValue, Kernel, SettingsValue } from "@kernel";

import { addAction, openSheet } from "plugin:context-menu";
import { addDecoration, type FolderDecoration } from "plugin:folders";
import type { Icons } from "plugin:icons";
import * as indexer from "plugin:indexer";
import { addSection } from "plugin:settings";

import type { NoteSelectLike } from "../../_shared/conditions-editor.js";
import type { NoteSource } from "../../_shared/note-picker.js";
import {
  indexNoteSource,
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
  // Optional: loaded once; until it arrives (or without it) looks have no icon.
  let iconSet: Pick<Icons, "Icon" | "Picker"> | undefined;
  const icons = (): Pick<Icons, "Icon" | "Picker"> | undefined => iconSet;
  let NoteSelect: ComponentType<NoteSelectLike> | undefined;

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

  void kernel.plugins
    .optional<typeof import("plugin:icons")>("icons")
    .then((module) => {
      if (module === undefined) return;
      iconSet = module;
      publish();
    })
    .catch((cause: unknown) => kernel.log.warn("icons unavailable; folders show no icon", cause));

  void kernel.plugins
    .optional<typeof import("plugin:search")>("search")
    .then((module) => {
      if (module === undefined) return;
      NoteSelect = module.NoteSelect;
      publish();
    })
    .catch((cause: unknown) => kernel.log.warn("search unavailable; rules pick notes from a list", cause));

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

  const decorate: FolderDecoration["decorate"] = (id) => {
    const style = resolveStyle(styles.get().get(id), defaults.get(), matcher.matched(id));
    if (style === undefined) return undefined;
    const set = style.icon !== undefined ? icons() : undefined;
    return {
      ...(style.background !== undefined
        ? { background: style.background, color: textOn(style.background) }
        : {}),
      ...(set !== undefined && style.icon !== undefined ? { icon: <set.Icon name={style.icon} /> } : {}),
    };
  };
  const onLookChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  addDecoration({ id: "folder-style", decorate, onChange: onLookChange });

  /** The look editor for one note, beside the element it was chosen from. */
  const edit = (id: string, anchor: HTMLElement): void => {
    void kernel.documents.get(id).then((row) => {
      openSheet({
        title: "Color and icon",
        anchor: anchor.isConnected ? anchor : null,
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
  };

  addAction({
    id: "folder-style.edit",
    target: "lm/document",
    order: 50,
    items: (target) => [{ id: "edit", label: "Color and icon…", run: () => edit(target.id, target.element) }],
  });

  // The indexer suggests properties and values and finds notes offline; the picker
  // draws notes as the tree does, since this plugin is what dresses them there.
  const index: ConditionIndex = indexer;
  const notes: NoteSource = indexNoteSource(index, { look: decorate, onChange: onLookChange });
  const suggestions: Suggestions = indexSuggestions(index);
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** The defaults, then the rules. Written as they change; leaving the section flushes. */
  const Section = (): ReactElement => {
    useSyncExternalStore(subscribe, () => version);
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
          {...(NoteSelect !== undefined ? { NoteSelect } : {})}
          suggestions={suggestions}
          openLook={(rule, label, anchor) =>
            openSheet({
              title: `Color and icon: ${label}`,
              anchor,
              onClose: rules.flush,
              render: (): ReactElement => (
                <Editor
                  name={label}
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

  addSection({
    id: "folder-style",
    title: "Folder colors and icons",
    order: 35,
    description: "The color and icon of notes in the folder tree that do not set their own.",
    component: Section,
  });
}

/** Looks still waiting to be written, and the rules' queries; the kernel withdraws everything else. */
let flushOnStop: (() => void) | undefined;

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
}
