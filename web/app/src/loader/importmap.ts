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
 * It must run before the first plugin is imported (import maps are consulted at
 * resolution time), which is exactly where `main.tsx` calls it.
 */

import { RUNTIME_SPECIFIER_NAMES } from "../../runtime/specifiers.js";

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
 * Specifiers the runtime layer promises but the page's map does not resolve.
 * Empty is the only acceptable answer in production.
 */
export function missingSpecifiers(map: ImportMap | undefined): readonly string[] {
  if (!map) return RUNTIME_SPECIFIER_NAMES;
  return RUNTIME_SPECIFIER_NAMES.filter((specifier) => map.imports[specifier] === undefined);
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
 * Build and inject a dev-only import map whose entries are blob modules
 * re-exporting this bundle's instances. Returns the map, or `undefined` when the
 * page already has one (production).
 */
export async function installDevImportMap(): Promise<ImportMap | undefined> {
  if (typeof document === "undefined") return undefined;
  if (pageImportMap()) return undefined;

  const imports: Record<string, string> = {};
  const registry = ((globalThis as Record<string, unknown>)["__lmRuntime"] ??= {}) as Record<
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
    `const m = globalThis.__lmRuntime[${JSON.stringify(specifier)}];`,
    ...keys.map((key) => `export const ${key} = m[${JSON.stringify(key)}];`),
  ];
  if ("default" in module) lines.push("export default m.default;");
  return lines.join("\n");
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);
