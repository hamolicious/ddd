/**
 * The kernel runtime (M3): the implementation of the `@kernel` contract over the
 * M2 substrate.
 *
 * Everything a plugin can reach is declared in `web/kernel-api/` and implemented
 * here. The split is not ceremony — `kernel-api` is what `/kernel.d.ts` is
 * generated from and what a third-party plugin author compiles against, and it must
 * stay free of IndexedDB, sockets and Wasm.
 *
 * The app (`web/app/`) builds one {@link KernelHost}, hands `host.forPlugin(manifest)`
 * to each plugin's `activate()`, and renders {@link KernelOutlet} inside its own
 * frame. Nothing else in the tree constructs a kernel.
 */

export { KernelHost, type KernelHostOptions, type PluginProblem } from "./host.js";
export { PluginsHost, type PluginImporter } from "./plugins.js";
export { activatingPlugin, asPlugin, asPluginSync, withdrawFromRegistries } from "./attribution.js";
export { EventBus } from "./events.js";
export { NoticeCenter } from "./notices.js";
export {
  ThemeController,
  COLOR_SCHEME_STORAGE_KEY,
  paintKernelDefaultTokens,
} from "./theme.js";
export { MountPoint, KernelOutlet } from "./mount.js";
export {
  DefaultFallback,
  PluginErrorBoundary,
  wrapWithBoundary,
  type BoundaryFallbackProps,
  type BoundaryProps,
} from "./boundary.js";
export { DocumentsHost, SpliceHost, type ApiFetch, type DocumentsHostOptions } from "./documents.js";
export {
  SettingsHost,
  SETTINGS_OWNER_KEY,
  settingsFilter,
  type SettingsHostOptions,
} from "./settings.js";
export {
  applyEdits,
  isValidKey,
  removeFrontmatterKey,
  removeSection,
  setFrontmatterValue,
  spliceSection,
  toYamlInline,
  type SectionKeyEdit,
} from "./splice.js";
export { SessionHost, type SessionHostOptions } from "./session.js";
export { SyncHost } from "./sync.js";
export { CoreHost } from "./core.js";
export { CapabilitiesHost, detectBridge, type ShellBridge } from "./capabilities.js";
// The full `window.shell` v1 declaration (SPEC §7; `app/BRIDGE.md` is authoritative).
export {
  BRIDGE_VERSION,
  FOLDER_CHANGED_EVENT,
  bridgeOwnsSession,
  bridgeVersionOf,
  readShellBridge,
  shellServerBaseUrl,
  shellUrl,
  type ShellAuth,
  type ShellBridgeV1,
  type ShellExportFile,
  type ShellFilesystem,
  type ShellFolder,
  type ShellFolderEntry,
  type ShellNotification,
  type ShellNotifications,
  type ShellPermission,
  type ShellPickOptions,
  type ShellPickedFile,
} from "./shell-bridge.js";
