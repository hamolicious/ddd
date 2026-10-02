import { parsePluginRef, type InstalledPlugin } from "@kernel";

import { RUNTIME_SPECIFIER_NAMES } from "../../runtime/specifiers.js";
import { moduleUrl, pluginSpecifier } from "./loader.js";

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>;
}

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

export function pageMapLacksPlugins(): boolean {
  const map = pageImportMap();
  return map !== undefined && !Object.keys(map.imports ?? {}).some((specifier) => specifier.startsWith("plugin:"));
}

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
    }
  }
  return specifiers;
}

export function missingSpecifiers(specifiers: ReadonlySet<string> | undefined): readonly string[] {
  if (!specifiers) return RUNTIME_SPECIFIER_NAMES;
  return RUNTIME_SPECIFIER_NAMES.filter((specifier) => !specifiers.has(specifier));
}

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
  document.head.append(script);
  return { imports };
}

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
