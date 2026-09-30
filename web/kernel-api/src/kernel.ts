/**
 * The `@kernel` module itself: what a plugin's `activate()` receives.
 *
 * **The object is per-plugin.** Every call is attributed to the plugin that made
 * it — `settings` reads its namespace, `splice` writes its `%%%` section, notices
 * carry its id, and `log` is prefixed with it. A plugin cannot spoof another by
 * passing an id, because it never passes one.
 *
 * **Activation follows the dependency graph** (`@kernel` 3.0). Plugins activate in the
 * order the server's load resolution gives: every plugin after the plugins it lists under
 * `dependencies` and `optionalDependencies`. Plugins reach each other through ordinary ES
 * imports (`import { addItem } from "plugin:header"`), not through the kernel. There is no
 * hot reload: any install, update, enable or disable reloads every open client.
 *
 * **FROZEN.**
 */

import type { CapabilitiesApi } from "./capabilities.js";
import type { DocumentsApi } from "./documents.js";
import type { EventsApi } from "./events.js";
import type { PluginManifest } from "./manifest.js";
import type { SessionApi } from "./session.js";
import type { SettingsApi } from "./settings.js";
import type { SyncApi } from "./sync.js";
import type { CoreMap, KernelLogger } from "./types.js";
import type { UiApi } from "./ui.js";

/**
 * The shared Rust core, in the client (SPEC §2: parity by construction).
 *
 * Exposed because plugins legitimately need to read a document's metadata out of
 * text they hold — a preview, a paste, an unsaved buffer — and a TypeScript
 * re-implementation of the frontmatter or `%%%` parser is the single most
 * effective way to make client and server disagree.
 */
export interface CoreApi {
  /** Frontmatter, `%%%` sections, and the resolved title of a text. */
  parseDocument(text: string): ParsedText;
  /** Title resolution alone: `fm.title` → first ATX heading → first line → "Untitled". */
  resolveTitle(text: string): string;
  /** Canonical ISO-8601 form, so lexicographic sort is correct (SPEC §3.4). */
  normalizeDate(input: string): string;
  /** The core's semantics version, compared against the server's at connect. */
  semanticsVersion(): number;
}

export interface ParsedText {
  readonly title: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
}

/** How this client was booted — `safe-*` modes skip or replace the plugin set. */
export type BootMode = "normal" | "safe" | "bare";

export interface KernelInfo {
  /** The `@kernel` contract version this build implements (semver). */
  readonly apiVersion: string;
  /** The web bundle's own version, for support questions. */
  readonly bundleVersion: string;
  readonly bootMode: BootMode;
  /** `true` in a Flutter shell webview. */
  readonly shell: boolean;
}

export interface Kernel {
  readonly info: KernelInfo;
  /** The calling plugin's id. Attribution is the kernel's, not the caller's. */
  readonly pluginId: string;
  /** The calling plugin's own manifest, as the server served it. */
  readonly manifest: PluginManifest;

  readonly documents: DocumentsApi;
  /** The plugin set of this boot: who is active, and the way to an optional dependency. */
  readonly plugins: PluginsApi;
  readonly events: EventsApi;
  readonly settings: SettingsApi;
  readonly session: SessionApi;
  readonly sync: SyncApi;
  readonly ui: UiApi;
  readonly capabilities: CapabilitiesApi;
  readonly core: CoreApi;
  readonly log: KernelLogger;
}

/** One plugin of this boot's load set. */
export interface LoadedPlugin {
  readonly id: string;
  readonly version: string;
  /** `<id>@<version>` when this plugin stands in for another one. */
  readonly provides?: string;
}

/**
 * `kernel.plugins` — the plugin set this page booted with (`@kernel` 3.0).
 *
 * A required dependency is a static import (`import { x } from "plugin:header"`); an
 * **optional** one is never imported statically, because the import would fail when it is
 * absent. It is reached here instead:
 *
 * ```ts
 * const icons = await kernel.plugins.optional<typeof import("plugin:icons")>("icons");
 * icons?.register(…);
 * ```
 */
export interface PluginsApi {
  /**
   * Whether `id` activated in this boot. A stand-in counts under the id it provides
   * (`provides: "editor@2.0.0"` makes `active("editor")` true).
   */
  active(id: string): boolean;
  /**
   * The module of an optional dependency, or `undefined` when it is not active. `id` must
   * be listed under the calling plugin's `optionalDependencies` or `dependencies`;
   * anything else throws `ContractViolationError`.
   */
  optional<M>(id: string): Promise<M | undefined>;
  /** Every plugin in this boot's load set, in load order. */
  list(): readonly LoadedPlugin[];
}

/**
 * A frontend plugin module. `activate` receives the plugin's own kernel; its return value
 * is ignored. What other plugins may use is the module's **named exports** (functions,
 * components, types), importable as `plugin:<id>`.
 *
 * Throwing from `activate` marks the plugin failed and **skips every plugin that depends
 * on it**, transitively, with one aggregated notice linking to admin (SPEC §6.4).
 */
export type ActivateFn = (kernel: Kernel) => unknown | Promise<unknown>;

/**
 * Runs when the plugin is stopped (a failed activation's cleanup, `?safe=bare` teardown).
 * It releases what the plugin built outside the kernel (window listeners, timers); the
 * kernel withdraws the rest.
 */
export type DeactivateFn = () => void | Promise<void>;

export interface PluginModule {
  readonly default: ActivateFn;
  readonly deactivate?: DeactivateFn;
}
