import { MANIFEST_KERNEL_VERSION } from "./manifest.generated.js";

export const KERNEL_API_VERSION: string = MANIFEST_KERNEL_VERSION;

export const KERNEL_API_MAJOR = Number.parseInt(KERNEL_API_VERSION, 10);

export type {
  CoreMap,
  CoreValue,
  Disposable,
  FmValue,
  Iso8601,
  KernelLogger,
  Unsubscribe,
} from "./types.js";

export {
  CapabilityUnavailableError,
  ContractViolationError,
  CoreUnavailableError,
  KernelError,
  NotImplementedError,
  PluginError,
  notImplemented,
} from "./errors.js";

export {
  anyValue,
  array,
  boolean,
  component,
  formatIssues,
  func,
  literal,
  number,
  object,
  optional,
  promise,
  record,
  s,
  shapeFromJSON,
  string,
  union,
  validate,
  type BuiltShape,
  type Shape,
  type ShapeIssue,
  type ShapeJson,
} from "./shape.js";

export type {
  CreateDocumentInput,
  DocumentId,
  DocumentPhase,
  DocumentQuery,
  DocumentQueryResult,
  DocumentRow,
  DocumentSpliceApi,
  DocumentsApi,
  FilterJson,
  OpenDocument,
  PlanHit,
  PlanResult,
  PlanSnippet,
  PlanSubscription,
  QueryPlan,
  QuerySubscription,
  SearchHit,
  SearchOptions,
  ListAction,
  ListPlan,
  SectionLineEdit,
  SortDirection,
  SortKey,
  SpliceTarget,
  TextEdit,
  TextRange,
} from "./documents.js";

export {
  checked,
  createRegistry,
  type Registry,
  type RegistryEntry,
  type RegistryOptions,
} from "./registry.js";

export {
  KERNEL_EVENT_PREFIX,
  KernelEvents,
  type EventOrigin,
  type EventsApi,
  type KernelEvent,
  type KernelEventName,
} from "./events.js";

export {
  SETTINGS_DOC_PATH,
  type SettingsApi,
  type SettingsFieldSchema,
  type SettingsSchema,
  type SettingsValue,
} from "./settings.js";

export type { AuthVia, LogoutOptions, SessionApi, SessionUser } from "./session.js";

export type { BootstrapProgress, SyncApi, SyncState, SyncStatus } from "./sync.js";

export {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_NAMES,
  type BoundaryInfo,
  type ColorScheme,
  type ColorSchemePreference,
  type Notice,
  type NoticeAction,
  type NoticeProgress,
  type NoticeLevel,
  type ThemeTokenName,
  type ThemeTokens,
  type ThemeTokensApi,
  type UiApi,
} from "./ui.js";

export {
  SUPPORTED_BRIDGE_VERSION,
  type CapabilitiesApi,
  type CapabilityName,
  type CapabilitySupport,
  type FileExport,
  type FilesystemCapability,
  type FolderCapability,
  type FolderEntry,
  type FolderState,
  type FolderStatus,
  type NotificationPermissionState,
  type NotificationRequest,
  type NotificationsCapability,
  type PickOptions,
  type PickedFile,
  type StorageReport,
} from "./capabilities.js";

export {
  PLUGIN_ID_PATTERN,
  PLUGIN_VERSION_PATTERN,
  formatProblem,
  isManifest,
  isSafeRelativePath,
  isSemverRange,
  isValidVersion,
  parsePluginRef,
  satisfies,
  validateManifest,
  type BackendExport,
  type HttpCapability,
  type InstalledPlugin,
  type ManifestProblem,
  type PluginBackend,
  type PluginCapabilities,
  type PluginConfigField,
  type PluginFrontend,
  type PluginLoad,
  type PluginManifest,
  type PluginState,
} from "./manifest.js";

export type {
  ActivateFn,
  BootMode,
  CoreApi,
  DeactivateFn,
  Kernel,
  KernelInfo,
  LoadedPlugin,
  ParsedText,
  PluginModule,
  PluginsApi,
} from "./kernel.js";
