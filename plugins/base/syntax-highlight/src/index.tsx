import type { Kernel } from "@kernel";
import { addExtension } from "plugin:editor";
import { addCodeBlockRenderer } from "plugin:markdown";
import { addSection } from "plugin:settings";

import catalog from "../languages.json";

import { languageRegistry, type SyntaxApi, type SyntaxLanguage } from "./api.js";
import { codeBlockFor } from "./CodeBlock.js";
import { editorExtension } from "./editor-extension.js";
import { createCustom, LANGUAGE_ID } from "./custom.js";
import { createEngine } from "./engine.js";
import { createInstalled } from "./installed.js";
import { indexLanguages, type LanguageIndex } from "./registry.js";
import { SyntaxSettings } from "./Settings.js";

export type { SyntaxApi, SyntaxLanguage } from "./api.js";
export type { CustomLanguage, CustomUpload } from "./custom.js";
export type { LoadState, Span } from "./engine.js";

export const addLanguage: (items: SyntaxLanguage | readonly SyntaxLanguage[]) => () => void =
  languageRegistry.add;

interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

const base = import.meta.url;

export default function activate(kernel: Kernel): void {
  addLanguage(
    (catalog.languages as readonly CatalogEntry[]).map((entry) => ({
      id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      wasmUrl: new URL(`languages/${entry.id}/grammar.wasm`, base).href,
      highlightsUrl: new URL(`languages/${entry.id}/highlights.scm`, base).href,
    })),
  );

  const custom = createCustom(kernel);
  const engine = createEngine({
    fetchBytes: (url) => (url.startsWith("attachment://") ? custom.fetchBytes(url) : fetchServed(url)),
  });
  const installed = createInstalled(kernel);

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
      const dispose = addLanguage({
        id,
        name: language.name,
        aliases: language.aliases,
        wasmUrl: language.wasm,
        highlightsUrl: language.highlights,
        size: language.size,
      });
      customContributions.set(id, { key: JSON.stringify(language), dispose });
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

  let index: LanguageIndex = indexLanguages(languageRegistry.get());
  languageRegistry.subscribe((all) => {
    index = indexLanguages(all);
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

  addCodeBlockRenderer({
    id: "syntax-highlight",
    component: codeBlockFor(api),
  });

  addExtension({
    id: "syntax-highlight",
    extension: editorExtension(api),
  });

  addSection({
    id: "syntax-highlight",
    title: "Code languages",
    order: 46,
    description: "Which languages fenced code is highlighted in.",
    component: () => <SyntaxSettings api={api} />,
  });
}

async function fetchServed(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function evict(urls: readonly string[]): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      await Promise.all(urls.filter((url) => /^https?:/.test(url)).map((url) => cache.delete(url)));
    }
  } catch {
  }
}
