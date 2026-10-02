import type { CapabilitiesApi } from "./capabilities.js";
import type { DocumentsApi } from "./documents.js";
import type { EventsApi } from "./events.js";
import type { PluginManifest } from "./manifest.js";
import type { SessionApi } from "./session.js";
import type { SettingsApi } from "./settings.js";
import type { SyncApi } from "./sync.js";
import type { CoreMap, KernelLogger } from "./types.js";
import type { UiApi } from "./ui.js";

export interface CoreApi {
  parseDocument(text: string): ParsedText;
  resolveTitle(text: string): string;
  normalizeDate(input: string): string;
  semanticsVersion(): number;
}

export interface ParsedText {
  readonly title: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
}

export type BootMode = "normal" | "safe" | "bare";

export interface KernelInfo {
  readonly apiVersion: string;
  readonly bundleVersion: string;
  readonly bootMode: BootMode;
  readonly shell: boolean;
}

export interface Kernel {
  readonly info: KernelInfo;
  readonly pluginId: string;
  readonly manifest: PluginManifest;

  readonly documents: DocumentsApi;
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

export interface LoadedPlugin {
  readonly id: string;
  readonly version: string;
  readonly provides?: string;
}

export interface PluginsApi {
  active(id: string): boolean;
  optional<M>(id: string): Promise<M | undefined>;
  list(): readonly LoadedPlugin[];
}

export type ActivateFn = (kernel: Kernel) => unknown | Promise<unknown>;

export type DeactivateFn = () => void | Promise<void>;

export interface PluginModule {
  readonly default: ActivateFn;
  readonly deactivate?: DeactivateFn;
}
