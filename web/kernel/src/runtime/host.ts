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
import { withdrawFromRegistries } from "./attribution.js";
import { PluginsHost, type PluginImporter } from "./plugins.js";
import { SessionHost, type SessionHostOptions } from "./session.js";
import { SettingsHost } from "./settings.js";
import { SyncHost } from "./sync.js";
import { ThemeController } from "./theme.js";

export interface KernelHostOptions {
  readonly root: HTMLElement;
  readonly engine: QueryEngine;
  readonly sync: SyncClient;
  readonly core: CoreBindings;
  readonly session: SessionHostOptions;
  readonly bootMode: BootMode;
  readonly onPluginProblem?: (problem: PluginProblem) => void;
  readonly importPlugin?: PluginImporter;
}

export interface PluginProblem {
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
  readonly error?: Error;
}

export class KernelHost {
  readonly plugins: PluginsHost;
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
    this.plugins = new PluginsHost(options.importPlugin);
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

  readonly #bags = new Map<string, Set<() => void>>();
  readonly #live = new Map<string, number>();
  #generation = 0;

  forPlugin(manifest: PluginManifest): Kernel {
    const pluginId = manifest.id;
    const generation = ++this.#generation;
    this.#live.set(pluginId, generation);
    const track = (dispose: () => void): (() => void) => this.#track(pluginId, generation, dispose);
    const events = this.events.forPlugin(pluginId);
    const settings = this.settings.api(pluginId);
    const session = this.session.api(pluginId);
    const sync = this.sync.api();
    const documents = this.documents.forPlugin(pluginId);
    return {
      info: this.info,
      pluginId,
      manifest,
      documents: {
        ...documents,
        splice: documents.splice,
        subscribe: async (query) => {
          const subscription = await documents.subscribe(query);
          const close = track(() => subscription.close());
          return {
            get result() {
              return subscription.result;
            },
            onChange: (listener) => track(subscription.onChange(listener)),
            close,
          };
        },
        open: async (id) => {
          const open = await documents.open(id);
          const release = track(() => open.release());
          return new Proxy(open, {
            get(target, key) {
              if (key === "release") return release;
              if (key === "onAwareness") {
                return (listener: (payload: Uint8Array) => void) => track(target.onAwareness(listener));
              }
              return Reflect.get(target, key, target);
            },
          });
        },
      },
      plugins: this.plugins.forPlugin(manifest),
      events: {
        ...events,
        on: (type, listener) => track(events.on(type, listener)),
        once: (type, listener) => track(events.once(type, listener)),
        onAny: (listener) => track(events.onAny(listener)),
      },
      settings: new Proxy(settings, {
        get(target, key) {
          if (key === "subscribe") {
            return (listener: Parameters<typeof settings.subscribe>[0]) => track(target.subscribe(listener));
          }
          return Reflect.get(target, key, target);
        },
      }),
      session: new Proxy(session, {
        get(target, key) {
          if (key === "onAuthRequired") return (listener: () => void) => track(target.onAuthRequired(listener));
          return Reflect.get(target, key, target);
        },
      }),
      sync: new Proxy(sync, {
        get(target, key) {
          if (key === "subscribe") {
            return (listener: Parameters<typeof sync.subscribe>[0]) => track(target.subscribe(listener));
          }
          return Reflect.get(target, key, target);
        },
      }),
      ui: this.#ui(pluginId, track),
      capabilities: this.capabilities,
      core: this.core,
      log: logger(pluginId),
    };
  }

  #track(pluginId: string, generation: number, dispose: () => void): () => void {
    if (this.#live.get(pluginId) !== generation) {
      dispose();
      return () => undefined;
    }
    const bag = this.#bags.get(pluginId) ?? new Set<() => void>();
    this.#bags.set(pluginId, bag);
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      bag.delete(run);
      dispose();
    };
    bag.add(run);
    return run;
  }

  held(pluginId: string): number {
    return this.#bags.get(pluginId)?.size ?? 0;
  }

  retract(pluginId: string): void {
    for (const dispose of [...(this.#bags.get(pluginId) ?? [])]) {
      try {
        dispose();
      } catch (error) {
        console.warn(`[kernel] releasing a resource of "${pluginId}" threw`, error);
      }
    }
    this.#bags.delete(pluginId);
    this.#live.delete(pluginId);
    withdrawFromRegistries(pluginId);
    this.mount.release(pluginId);
    if (typeof document !== "undefined") {
      for (const link of document.querySelectorAll(`link[data-ddd-plugin="${CSS.escape(pluginId)}"]`)) link.remove();
    }
  }

  #ui(pluginId: string, track: (dispose: () => void) => () => void): UiApi {
    const host = this;
    const tokens = host.theme.api();
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
      notify: (notice: Notice) => track(host.notices.notify({ ...notice, pluginId })),
      notices: () => host.notices.list(),
      onNotices: (listener) => track(host.notices.subscribe(listener)),
      tokens: new Proxy(tokens, {
        get(target, key) {
          if (key === "apply") {
            return (...args: Parameters<typeof tokens.apply>) => track(target.apply(...args));
          }
          return Reflect.get(target, key, target);
        },
      }),
      get colorScheme() {
        return host.theme.scheme;
      },
      colorSchemePreference: () => host.theme.preference(),
      setColorSchemePreference: (preference) => host.theme.setPreference(preference),
      onColorScheme: (listener) => track(host.theme.onScheme(listener)),
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
