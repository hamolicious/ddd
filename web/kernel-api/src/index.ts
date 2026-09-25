/**
 * `@kernel` — the entire public contract between the kernel and a plugin
 * (SPEC §6.4: "Types are the contract").
 *
 * This barrel is what the import map resolves `@kernel` to at runtime, what
 * `/kernel.d.ts` is generated from, and the only thing a plugin may import from
 * the host. A plugin that reaches into `@kernel/…` internals is depending on an
 * implementation that is free to change inside one kernel version.
 *
 * ```ts
 * import type { Kernel } from "@kernel";
 *
 * export default function activate(kernel: Kernel) {
 *   kernel.extensions.contribute("navbar.item", { id: "hello", label: "Hello" });
 *   return { greet: () => "hi" };            // this plugin's API, for dependents
 * }
 * ```
 *
 * **FROZEN.** One `kernel` semver covers this surface and the Wasm host ABI;
 * removals and signature changes are a major (SPEC §6.4). `docs/KERNEL-API.md` is
 * the changelog.
 */

export const KERNEL_API_VERSION = "1.1.0";

/** Major of {@link KERNEL_API_VERSION} — what a manifest's `kernel` range is checked against. */
export const KERNEL_API_MAJOR = 1;

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
  record,
  s,
  string,
  union,
  validate,
  type Shape,
  type ShapeIssue,
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
  QuerySubscription,
  SearchHit,
  SearchOptions,
  SectionLineEdit,
  SortDirection,
  SortKey,
  SpliceTarget,
  TextEdit,
  TextRange,
} from "./documents.js";

export {
  DEFAULT_CONTRIBUTION_ORDER,
  type Contribution,
  type ContributeOptions,
  type ExtensionPoint,
  type ExtensionPointDefinition,
  type ExtensionsApi,
} from "./extensions.js";

export type { ServicesApi } from "./services.js";

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
  satisfies,
  validateManifest,
  type InstalledPlugin,
  type ManifestProblem,
  type PluginBackend,
  type PluginCapabilities,
  type PluginConfigField,
  type PluginFrontend,
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
  ParsedText,
  PluginModule,
} from "./kernel.js";
