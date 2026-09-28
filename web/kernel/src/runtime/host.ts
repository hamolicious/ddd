/**
 * `KernelHost` — the singletons behind `@kernel`, and the factory that hands each
 * plugin its own attributed view of them.
 *
 * There is exactly one host per page. `forPlugin(manifest)` is what the loader
 * calls immediately before `activate(kernel)`, and the object it returns is the
 * *only* thing a plugin ever touches: every call inside it carries the plugin's id
 * without the plugin supplying one, which is what makes attribution — of
 * contributions, settings, `%%%` sections, service access and log lines — a
 * property of the kernel rather than of plugin good manners.
 */

import type { ComponentType, ReactNode } from "react";

import {
  KERNEL_API_VERSION,
  type BootMode,
  type Kernel,
  type KernelInfo,
  type KernelLogger,
  type Notice,
  type PluginManifest,
  type UiApi,
} from "@kernel";

import { KERNEL_VERSION } from "../index.js";
import type { QueryEngine } from "../query/index.js";
import type { SyncClient } from "../sync/client.js";
import type { CoreBindings } from "../wasm/index.js";
import { wrapWithBoundary } from "./boundary.js";
import { CapabilitiesHost } from "./capabilities.js";
import { CoreHost } from "./core.js";
import { DocumentsHost } from "./documents.js";
import { EventBus } from "./events.js";
import { MountPoint } from "./mount.js";
import { NoticeCenter } from "./notices.js";
import { PortsHost } from "./ports.js";
import { ExtensionRegistry, type RegistryReport } from "./registry.js";
import { ServiceRegistry } from "./services.js";
import { SessionHost, type SessionHostOptions } from "./session.js";
import { SettingsHost } from "./settings.js";
import { SyncHost } from "./sync.js";
import { ThemeController } from "./theme.js";

export interface KernelHostOptions {
  /** The node the app's React root renders into. */
  readonly root: HTMLElement;
  readonly engine: QueryEngine;
  readonly sync: SyncClient;
  readonly core: CoreBindings;
  readonly session: SessionHostOptions;
  readonly bootMode: BootMode;
  /** A contributed component threw, or a contribution was rejected. */
  readonly onPluginProblem?: (problem: PluginProblem) => void;
}

export interface PluginProblem {
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
  readonly error?: Error;
}

export class KernelHost {
  /** The slot, service and event store `kernel.ports` and the 1.x shims share (§5). */
  readonly ports: PortsHost;
  readonly extensions: ExtensionRegistry;
  readonly services: ServiceRegistry;
  readonly events: EventBus;
  readonly notices = new NoticeCenter();
  readonly theme: ThemeController;
  readonly mount: MountPoint;
  readonly documents: DocumentsHost;
  readonly settings: SettingsHost;
  readonly capabilities: CapabilitiesHost;
  readonly session: SessionHost;
  readonly sync: SyncHost;
  readonly core: CoreHost;
  readonly info: KernelInfo;

  constructor(private readonly options: KernelHostOptions) {
    const report = (problem: PluginProblem): void => options.onPluginProblem?.(problem);
    this.ports = new PortsHost((r) => this.extensions.record(r));
    this.extensions = new ExtensionRegistry(
      (r: RegistryReport) => report({ pluginId: r.pluginId, point: r.point, message: r.message }),
      this.ports,
    );
    this.services = new ServiceRegistry(this.ports);
    this.events = new EventBus((type, error) =>
      console.warn(`[events] listener for "${type}" threw`, error),
    );
    this.theme = new ThemeController(document.documentElement);
    this.mount = new MountPoint(options.root);
    this.session = new SessionHost(options.session);
    this.documents = new DocumentsHost({
      engine: options.engine,
      sync: options.sync,
      api: this.session.fetch,
      notices: this.notices,
      userId: options.session.user.id,
      parse: (text) => options.core.parseDocument(text),
    });
    this.settings = new SettingsHost({
      documents: this.documents,
      userId: options.session.user.id,
      // Only so a human opening the settings document can tell whose it is; the
      // kernel matches on `fm.settings-owner`, never on the label.
      userLabel: options.session.user.email || options.session.user.name || options.session.user.id,
    });
    this.capabilities = new CapabilitiesHost();
    this.sync = new SyncHost(options.sync);
    this.core = new CoreHost(options.core);
    this.info = {
      apiVersion: KERNEL_API_VERSION,
      bundleVersion: KERNEL_VERSION,
      bootMode: options.bootMode,
      shell: this.capabilities.bridgeVersion !== undefined,
    };
  }

  /** The per-plugin `@kernel`. Built once per plugin, just before `activate`. */
  forPlugin(manifest: PluginManifest): Kernel {
    const pluginId = manifest.id;
    this.services.declare(pluginId, Object.keys(manifest.dependencies ?? {}));
    return {
      info: this.info,
      pluginId,
      manifest,
      documents: this.documents.forPlugin(pluginId),
      extensions: this.extensions.forPlugin(pluginId, manifest),
      services: this.services.forPlugin(pluginId, manifest),
      ports: this.ports.forPlugin(manifest),
      events: this.events.forPlugin(pluginId),
      settings: this.settings.api(pluginId),
      session: this.session.api(pluginId),
      sync: this.sync.api(),
      ui: this.#ui(pluginId),
      capabilities: this.capabilities,
      core: this.core,
      log: logger(pluginId),
    };
  }

  /** Withdraw everything a plugin registered — failure, or `?safe=bare` teardown. */
  retract(pluginId: string): void {
    this.extensions.removePlugin(pluginId);
    this.services.remove(pluginId);
    this.mount.release(pluginId);
  }

  #ui(pluginId: string): UiApi {
    const host = this;
    return {
      root: host.options.root,
      mount: (element: ReactNode) => host.mount.mount(pluginId, element),
      boundary: <P extends object>(component: ComponentType<P>, info: Parameters<UiApi["boundary"]>[1]) =>
        wrapWithBoundary(component, { ...info, pluginId: info.pluginId ?? pluginId }, (error, where) =>
          host.options.onPluginProblem?.({
            pluginId: where.pluginId,
            point: where.point,
            message: error.message,
            error,
          }),
        ),
      notify: (notice: Notice) => host.notices.notify({ ...notice, pluginId }),
      notices: () => host.notices.list(),
      onNotices: (listener) => host.notices.subscribe(listener),
      tokens: host.theme.api(),
      get colorScheme() {
        return host.theme.scheme;
      },
      colorSchemePreference: () => host.theme.preference(),
      setColorSchemePreference: (preference) => host.theme.setPreference(preference),
      onColorScheme: (listener) => host.theme.onScheme(listener),
    };
  }
}

function logger(pluginId: string): KernelLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (message, ...detail) => console.debug(prefix, message, ...detail),
    info: (message, ...detail) => console.info(prefix, message, ...detail),
    warn: (message, ...detail) => console.warn(prefix, message, ...detail),
    error: (message, ...detail) => console.error(prefix, message, ...detail),
  };
}
