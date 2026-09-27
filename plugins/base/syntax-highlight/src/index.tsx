/**
 * `syntax-highlight` — fenced code, highlighted with tree-sitter grammars the user
 * installs when they want them.
 *
 * - Defines `syntax.language`, and contributes its own catalog to it (`languages.json`,
 *   built into `frontend/languages/` by `build.mjs`). Another plugin can add a language
 *   the same way.
 * - Contributes the `markdown.codeBlock` renderer, which replaces markdown's plain `<pre>`
 *   for every fence no `markdown.fence` claims; and an `editor.extension`, which colours
 *   the same blocks while editing (SPEC §6.6: a syntax contributor pairs the two).
 * - Which languages are installed is a per-user setting; the bytes are fetched once per
 *   device and kept by the service worker.
 *
 * Nothing here is required by anything: without this plugin code is a plain `<pre>`, as
 * it always was.
 */

import type { Kernel } from "@kernel";

import {
  POINTS,
  syntaxLanguageShape,
  type EditorExtension,
  type MarkdownCodeBlock,
  type SettingsSection,
  type SyntaxLanguage,
} from "../../_shared/points.js";
import catalog from "../languages.json";

import { codeBlockFor } from "./CodeBlock.js";
import { editorExtension } from "./editor-extension.js";
import { createCustom, type CustomLanguage, type CustomUpload, LANGUAGE_ID } from "./custom.js";
import { createEngine, type LoadState, type Span } from "./engine.js";
import { createInstalled } from "./installed.js";
import { indexLanguages, type LanguageIndex } from "./registry.js";
import { SyntaxSettings } from "./Settings.js";

/** The service this plugin returns, for plugins that want highlighted code of their own. */
export interface SyntaxApi {
  /** Every language on offer, installed or not. */
  languages(): readonly SyntaxLanguage[];
  /** The language an info string (`ts`, `Rust`, `rust {1}`) means, if any is on offer. */
  resolve(infoString: string | undefined): SyntaxLanguage | undefined;
  isInstalled(id: string): boolean;
  /** Mark installed for this user and fetch it here. Rejects when it cannot be fetched. */
  install(id: string): Promise<void>;
  /** Unmark it, and drop its files from this device's cache. */
  remove(id: string): Promise<void>;
  state(id: string): LoadState | undefined;
  /** Start fetching an installed language, unless it already is; `retry` after a failure. */
  ensureLoaded(id: string, retry?: boolean): void;
  /** Spans for `code` in `language` (an id or alias), or `undefined` while it is not ready. */
  highlight(code: string, language: string): readonly Span[] | undefined;
  /** The languages this user uploaded themselves. */
  custom(): readonly CustomLanguage[];
  /**
   * Check an uploaded grammar and query in this browser, store them as attachments, and
   * install the language. Rejects with a message fit to show.
   */
  addCustom(upload: CustomUpload): Promise<void>;
  /** Uninstall and forget an uploaded language, deleting its files. */
  removeCustom(id: string): Promise<void>;
  /** Something changed: a grammar loaded, the installed set, the catalog. */
  subscribe(listener: () => void): () => void;
  /** Bumps on every such change, for `useSyncExternalStore`. */
  revision(): number;
}

interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

/** This module's URL; the grammars sit beside it. A variable, so Vite leaves `new URL` alone. */
const base = import.meta.url;

export default function activate(kernel: Kernel): SyntaxApi {
  const point = kernel.extensions.definePoint<SyntaxLanguage>({
    name: POINTS.syntaxLanguage,
    shape: syntaxLanguageShape,
    key: (language) => language.id,
    description: "A tree-sitter grammar fenced code can be highlighted with.",
  });

  for (const entry of catalog.languages as readonly CatalogEntry[]) {
    kernel.extensions.contribute<SyntaxLanguage>(POINTS.syntaxLanguage, {
      id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      wasmUrl: new URL(`languages/${entry.id}/grammar.wasm`, base).href,
      highlightsUrl: new URL(`languages/${entry.id}/highlights.scm`, base).href,
    });
  }

  const custom = createCustom(kernel);
  const engine = createEngine({
    fetchBytes: (url) => (url.startsWith("attachment://") ? custom.fetchBytes(url) : fetchServed(url)),
  });
  const installed = createInstalled(kernel);

  // Uploaded languages are contributions like any other, kept in step with the setting.
  const customContributions = new Map<string, { readonly key: string; dispose(): void }>();
  const syncCustom = (): void => {
    const current = new Map(custom.list().map((language) => [language.id, language]));
    for (const [id, contribution] of customContributions) {
      const language = current.get(id);
      if (language && contribution.key === JSON.stringify(language)) continue;
      contribution.dispose();
      customContributions.delete(id);
      engine.forget(id);
    }
    for (const [id, language] of current) {
      if (customContributions.has(id)) continue;
      const disposable = kernel.extensions.contribute<SyntaxLanguage>(POINTS.syntaxLanguage, {
        id,
        name: language.name,
        aliases: language.aliases,
        wasmUrl: language.wasm,
        highlightsUrl: language.highlights,
        size: language.size,
      });
      customContributions.set(id, { key: JSON.stringify(language), dispose: () => disposable.dispose() });
    }
  };
  syncCustom();
  custom.subscribe(syncCustom);

  let revision = 0;
  const listeners = new Set<() => void>();
  const announce = (): void => {
    revision += 1;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        kernel.log.error("syntax-highlight listener threw", error);
      }
    }
  };

  let index: LanguageIndex = indexLanguages(point.get());
  point.subscribe(() => {
    index = indexLanguages(point.get());
    announce();
  });
  installed.subscribe(announce);
  engine.subscribe(announce);

  const byId = (id: string): SyntaxLanguage => {
    const language = index.resolve(id);
    if (!language) throw new Error(`no language "${id}" is on offer`);
    return language;
  };

  const api: SyntaxApi = {
    languages: () => index.languages,
    resolve: (infoString) => index.resolve(infoString),
    isInstalled: (id) => installed.has(id),
    state: (id) => engine.state(id),

    async install(id) {
      const language = byId(id);
      await installed.add(language.id);
      await engine.load(language);
    },

    async remove(id) {
      const language = byId(id);
      await installed.remove(language.id);
      await evict([language.wasmUrl, language.highlightsUrl]);
    },

    ensureLoaded(id, retry = false) {
      const language = index.resolve(id);
      if (!language) return;
      const state = engine.state(language.id);
      if (state === "ready" || state === "loading" || (state === "failed" && !retry)) return;
      engine.load(language).catch((error: unknown) => {
        kernel.log.warn(`the ${language.name} grammar did not load`, error);
      });
    },

    highlight(code, name) {
      const language = index.resolve(name);
      if (!language || !installed.has(language.id)) return undefined;
      return engine.highlight(code, language.id);
    },

    custom: () => custom.list(),

    async addCustom(upload) {
      if (!LANGUAGE_ID.test(upload.id)) {
        throw new Error("The id is what follows ``` in a note: lowercase letters, digits, _ + # or -, starting with a letter.");
      }
      if (!upload.name.trim()) throw new Error("Give the language a name.");
      const taken = index.resolve(upload.id);
      if (taken && !custom.list().some((language) => language.id === upload.id)) {
        throw new Error(`"${upload.id}" already means ${taken.name}. Choose another id.`);
      }
      await custom.add({ ...upload, name: upload.name.trim() }, (grammar, highlights) =>
        engine.check(grammar, highlights),
      );
      syncCustom();
      await installed.add(upload.id);
    },

    async removeCustom(id) {
      await installed.remove(id);
      await custom.remove(id);
      syncCustom();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
  };

  kernel.extensions.contribute<MarkdownCodeBlock>(POINTS.markdownCodeBlock, {
    id: "syntax-highlight",
    component: codeBlockFor(api),
  });

  kernel.extensions.contribute<EditorExtension>(POINTS.editorExtension, {
    id: "syntax-highlight",
    extension: editorExtension(api),
  });

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "syntax-highlight",
    title: "Code languages",
    order: 46,
    description: "Which languages fenced code is highlighted in.",
    component: () => <SyntaxSettings api={api} />,
  });

  return api;
}

async function fetchServed(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Drop a removed language's files from the service worker's caches, so removing one
 * gives the space back. Best effort: where there is no Cache Storage there is nothing
 * to drop, and the files are small enough that a failure costs nothing but space.
 */
async function evict(urls: readonly string[]): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      await Promise.all(urls.filter((url) => /^https?:/.test(url)).map((url) => cache.delete(url)));
    }
  } catch {
    // Space, not correctness.
  }
}
