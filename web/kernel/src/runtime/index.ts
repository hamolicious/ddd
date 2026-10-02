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
