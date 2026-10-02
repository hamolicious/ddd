import { useEffect, useSyncExternalStore, type ComponentType, type ReactElement } from "react";

import type { CoreValue, Kernel, SettingsValue } from "@kernel";

import { addAction, openSheet } from "plugin:context-menu";
import { addDecoration, type FolderDecoration } from "plugin:folders";
import type { Icons } from "plugin:icons";
import * as indexer from "plugin:indexer";
import { addSection } from "plugin:settings";

import type { FmKeySelectLike, FmValueSelectLike, NoteSelectLike } from "../../_shared/conditions-editor.js";
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

const WRITE_DEBOUNCE_MS = 400;

interface Stored<T> {
  get(): T;
  change(next: T): void;
  flush(): void;
  adopt(): boolean;
}

export default function activate(kernel: Kernel): void {
  let iconSet: Pick<Icons, "Icon" | "Picker"> | undefined;
  const icons = (): Pick<Icons, "Icon" | "Picker"> | undefined => iconSet;
  let pickers:
    | {
        readonly NoteSelect: ComponentType<NoteSelectLike>;
        readonly FmKeySelect: ComponentType<FmKeySelectLike>;
        readonly FmValueSelect: ComponentType<FmValueSelectLike>;
      }
    | undefined;

  kernel.settings.defineSchema({
    [STYLES_KEY]: { type: "list", default: [] },
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
      pickers = { NoteSelect: module.NoteSelect, FmKeySelect: module.FmKeySelect, FmValueSelect: module.FmValueSelect };
      publish();
    })
    .catch((cause: unknown) => kernel.log.warn("search unavailable; rules pick notes from a list", cause));

  flushOnStop = () => {
    for (const each of all) each.flush();
    matcher.close();
  };

  try {
    kernel.settings.subscribe(() => {
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

  const edit = (id: string, anchor: HTMLElement): void => {
    void kernel.documents.get(id).then((row) => {
      openSheet({
        title: "Color and icon",
        anchor: anchor.isConnected ? anchor : null,
        onClose: styles.flush,
        render: (): ReactElement => (
          <Editor
            name={row?.title || "Untitled"}
            initial={styles.get().get(id)}
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
    target: "ddd/document",
    order: 50,
    items: (target) => [{ id: "edit", label: "Color and icon…", run: () => edit(target.id, target.element) }],
  });

  const index: ConditionIndex = indexer;
  const notes: NoteSource = indexNoteSource(index, { look: decorate, onChange: onLookChange });
  const suggestions: Suggestions = indexSuggestions(index);
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

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
          {...(pickers ?? {})}
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

let flushOnStop: (() => void) | undefined;

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
}
