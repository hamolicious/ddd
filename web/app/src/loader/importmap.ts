/**
 * The import map: how the blessed runtime layer reaches a plugin module.
 *
 * **Production.** The server injects the map inline into `index.html` with a CSP
 * nonce and also serves it at `/importmap.json` (SPEC §8: "import map served
 * external or nonced" — browsers never shipped `<script type="importmap" src>`, so
 * inline-with-nonce is the only form that both works and satisfies the CSP). This
 * module then has nothing to do but check that the map the page got actually covers
 * what the installed plugins declared, and say so loudly if it does not — a missing
 * entry otherwise surfaces as a bare "Failed to resolve module specifier" from
 * inside somebody's bundle.
 *
 * **Development.** Vite serves the app's own dependencies as rewritten URLs, so
 * there is no map in the page, and a plugin bundle's `import "react"` would fail.
 * {@link installDevImportMap} builds one at runtime out of the modules this bundle
 * already has: each specifier becomes a blob module that re-exports the *same*
 * instance the app is using. One React, one Yjs, in dev as in production.
 *
 * **Plugins are specifiers too** (`@kernel` 3.0). `plugin:<id>` maps to the enabled
 * plugin's version-scoped module URL (with the server's `?v=` fingerprint), plus an alias
 * under the id a stand-in `provides`. The server writes those entries into its map; the dev
 * map adds them from the plugin list. The loader and every plugin import a plugin only
 * through its specifier, so each module is instantiated once.
 *
 * It must run before the first plugin is imported (import maps are consulted at
 * resolution time), which is exactly where `main.tsx` calls it — after the plugin list is
 * known, because the dev map needs it.
 */

import { parsePluginRef, type InstalledPlugin } from "@kernel";

import { RUNTIME_SPECIFIER_NAMES } from "../../runtime/specifiers.js";
import { moduleUrl, pluginSpecifier } from "./loader.js";

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>;
}

/** The map the page was served, if any. */
export function pageImportMap(): ImportMap | undefined {
  if (typeof document === "undefined") return undefined;
  const script = document.querySelector('script[type="importmap"]');
  if (!script?.textContent) return undefined;
  try {
    return JSON.parse(script.textContent) as ImportMap;
  } catch {
    return undefined;
  }
}

/**
 * Whether the page was served the signed-out map: a server map with no `plugin:<id>`
 * entry. The server names the installed plugins only to a session (`statics.rs`
 * `page_imports`), and a map cannot change after load, so a page that signed in on top
 * of it must reload to get the entries. `false` in dev, where there is no server map
 * and `installDevImportMap` builds one after sign-in.
 */
export function pageMapLacksPlugins(): boolean {
  const map = pageImportMap();
  return map !== undefined && !Object.keys(map.imports ?? {}).some((specifier) => specifier.startsWith("plugin:"));
}

/**
 * Every specifier the page's import maps resolve (a page can carry more than one), or
 * `undefined` when there is no map at all (no DOM, or a map not installed yet).
 */
export function importMapSpecifiers(): ReadonlySet<string> | undefined {
  if (typeof document === "undefined") return undefined;
  const scripts = document.querySelectorAll('script[type="importmap"]');
  if (scripts.length === 0) return undefined;
  const specifiers = new Set<string>();
  for (const script of scripts) {
    try {
      const map = JSON.parse(script.textContent ?? "") as Partial<ImportMap>;
      for (const specifier of Object.keys(map.imports ?? {})) specifiers.add(specifier);
    } catch {
      // A map the browser could not parse either resolves nothing.
    }
  }
  return specifiers;
}

/**
 * Specifiers the runtime layer promises but the page's maps do not resolve.
 * Empty is the only acceptable answer in production.
 */
export function missingSpecifiers(specifiers: ReadonlySet<string> | undefined): readonly string[] {
  if (!specifiers) return RUNTIME_SPECIFIER_NAMES;
  return RUNTIME_SPECIFIER_NAMES.filter((specifier) => !specifiers.has(specifier));
}

/** Loaders for the dev map. Static imports, so Vite pre-bundles them. */
const DEV_MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  "@kernel": () => import("@kernel"),
  react: () => import("react") as Promise<Record<string, unknown>>,
  "react/jsx-runtime": () => import("react/jsx-runtime") as Promise<Record<string, unknown>>,
  "react-dom": () => import("react-dom") as Promise<Record<string, unknown>>,
  "react-dom/client": () => import("react-dom/client") as Promise<Record<string, unknown>>,
  yjs: () => import("yjs") as Promise<Record<string, unknown>>,
  "@codemirror/state": () => import("@codemirror/state") as Promise<Record<string, unknown>>,
  "@codemirror/view": () => import("@codemirror/view") as Promise<Record<string, unknown>>,
  "@codemirror/commands": () => import("@codemirror/commands") as Promise<Record<string, unknown>>,
  "@codemirror/language": () => import("@codemirror/language") as Promise<Record<string, unknown>>,
  "@lezer/common": () => import("@lezer/common") as Promise<Record<string, unknown>>,
  "@lezer/highlight": () => import("@lezer/highlight") as Promise<Record<string, unknown>>,
  "y-codemirror.next": () => import("y-codemirror.next") as Promise<Record<string, unknown>>,
  unified: () => import("unified") as Promise<Record<string, unknown>>,
  "remark-parse": () => import("remark-parse") as Promise<Record<string, unknown>>,
  "remark-gfm": () => import("remark-gfm") as Promise<Record<string, unknown>>,
  "remark-directive": () => import("remark-directive") as Promise<Record<string, unknown>>,
};

/**
 * `plugin:<id>` → module URL for every plugin with a frontend, plus the alias a stand-in's
 * `provides` names. The same entries the server writes (`plugins::plugin_imports`).
 */
export function pluginImports(plugins: readonly InstalledPlugin[]): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const plugin of plugins) {
    if (!plugin.manifest.frontend) continue;
    const url = moduleUrl(plugin);
    imports[pluginSpecifier(plugin.manifest.id)] = url;
    const provided = plugin.manifest.provides ? parsePluginRef(plugin.manifest.provides) : undefined;
    if (provided) imports[pluginSpecifier(provided.id)] ??= url;
  }
  return imports;
}

/**
 * Build and inject a dev-only import map: blob modules re-exporting this bundle's
 * instances of the runtime layer, and a `plugin:<id>` entry for every plugin in
 * `plugins` (the ones this boot loads). Returns the map, or `undefined` when the page
 * already has one (production: the server's map carries the plugin entries).
 */
export async function installDevImportMap(plugins: readonly InstalledPlugin[] = []): Promise<ImportMap | undefined> {
  if (typeof document === "undefined") return undefined;
  if (pageImportMap()) return undefined;

  const imports: Record<string, string> = { ...pluginImports(plugins) };
  const registry = ((globalThis as Record<string, unknown>)["__dddRuntime"] ??= {}) as Record<
    string,
    unknown
  >;

  for (const [specifier, load] of Object.entries(DEV_MODULES)) {
    const module = await load();
    registry[specifier] = module;
    imports[specifier] = URL.createObjectURL(
      new Blob([reexportSource(specifier, module)], { type: "text/javascript" }),
    );
  }

  const script = document.createElement("script");
  script.type = "importmap";
  script.textContent = JSON.stringify({ imports });
  // Import maps are consulted at module-resolution time; this runs before the first
  // plugin import, which is the only resolution in the page that needs the map.
  document.head.append(script);
  return { imports };
}

/**
 * A module that re-exports a live object from the registry. Generated from the
 * module's own keys, so it stays correct as libraries add exports — and `let`
 * bindings assigned once keep live-binding semantics close enough for our use
 * (nothing in the runtime layer mutates its exports after load).
 */
function reexportSource(specifier: string, module: Record<string, unknown>): string {
  const keys = Object.keys(module).filter((key) => key !== "default" && isIdentifier(key));
  const lines = [
    `const m = globalThis.__dddRuntime[${JSON.stringify(specifier)}];`,
    ...keys.map((key) => `export const ${key} = m[${JSON.stringify(key)}];`),
  ];
  if ("default" in module) lines.push("export default m.default;");
  return lines.join("\n");
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);
