/**
 * The `@kernel` module itself: what a plugin's `activate()` receives.
 *
 * **The object is per-plugin.** Every call is attributed to the plugin that made
 * it — contributions carry its id, `settings` reads its namespace, `splice` writes
 * its `%%%` section, `services.require` is checked against its declared
 * dependencies, and `log` is prefixed with its id. A plugin cannot spoof another
 * by passing an id, because it never passes one.
 *
 * **Activation is reload-only** (SPEC §6.4). Plugins load once at boot in
 * topological order; `deactivate` exists for symmetry and for the `?safe=bare`
 * teardown, and installing or enabling a plugin prompts "reload to activate".
 * Backend halves still hot-load (M4) — that asymmetry is deliberate.
 *
 * **FROZEN.**
 */

import type { CapabilitiesApi } from "./capabilities.js";
import type { DocumentsApi } from "./documents.js";
import type { EventsApi } from "./events.js";
import type { ExtensionsApi } from "./extensions.js";
import type { PluginManifest } from "./manifest.js";
import type { ServicesApi } from "./services.js";
import type { SessionApi } from "./session.js";
import type { SettingsApi } from "./settings.js";
import type { SyncApi } from "./sync.js";
import type { CoreMap, KernelLogger } from "./types.js";
import type { ShapeJson } from "./shape.js";
import type { UiApi } from "./ui.js";
import type { ApplyPlan, PortCandidate, Resolution, WiringInput, WiringOverrides } from "./wiring.js";

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
  /**
   * Resolve plugin wiring with the server's own resolver (PLUGIN-PROTOCOLS §6): what the
   * wiring editor previews a draft with. Throws `CoreUnavailableError` without the Wasm
   * core, which is the editor's cue to go read-only.
   */
  resolveWiring(input: WiringInput): Resolution;
  /** What applying `after` on a client running `before` does (§6c). */
  planWiring(request: {
    readonly before: Resolution;
    readonly after: Resolution;
    readonly beforeWiring: WiringOverrides;
    readonly afterWiring: WiringOverrides;
    readonly hot: readonly string[];
  }): ApplyPlan;
  /** Every port that could connect to `port`, and why not when it cannot (§6b). */
  wiringCandidates(input: WiringInput, port: string, dir: "in" | "out"): readonly PortCandidate[];
  /** Why offering `offer` where `need` is required fails; empty when it fits (§6b). */
  shapeFits(offer: ShapeJson, need: ShapeJson): readonly string[];
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
  readonly extensions: ExtensionsApi;
  readonly services: ServicesApi;
  readonly events: EventsApi;
  readonly settings: SettingsApi;
  readonly session: SessionApi;
  readonly sync: SyncApi;
  readonly ui: UiApi;
  readonly capabilities: CapabilitiesApi;
  readonly core: CoreApi;
  readonly log: KernelLogger;
}

/**
 * A frontend plugin module. `activate`'s return value becomes the plugin's API for
 * its dependents (`kernel.services.require`); returning nothing is fine for a
 * plugin nobody depends on.
 *
 * Throwing from `activate` marks the plugin failed and **skips every transitive
 * dependent**, with one aggregated notice linking to admin (SPEC §6.4).
 */
export type ActivateFn = (kernel: Kernel) => unknown | Promise<unknown>;

/** Defined for symmetry; activation is reload-only, so it runs only on teardown. */
export type DeactivateFn = () => void | Promise<void>;

export interface PluginModule {
  readonly default: ActivateFn;
  readonly deactivate?: DeactivateFn;
}
