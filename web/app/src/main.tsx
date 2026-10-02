import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KERNEL_API_VERSION, type InstalledPlugin, type LogoutOptions, type PluginLoad, type SessionUser } from "@kernel";
import {
  PluginErrorBoundary,
  paintKernelDefaultTokens,
  type KernelHost,
} from "@kernel/runtime/index.js";

import { AuthGate } from "./boot/AuthGate.js";
import { OfflineError, installedPlugins, inviteTokenFromHash, logoutRequest, me, resetTokenFromHash } from "./boot/api.js";
import {
  cachedLoad,
  cachedPlugins,
  cachedSession,
  forgetBootCache,
  forgetSession,
  rememberPlugins,
  rememberSession,
} from "./boot/cache.js";
import { initKernel, type KernelRuntime } from "./boot/kernel-init.js";
import { bootModeFor, safeModeFrom } from "./boot/safe-mode.js";
import { contributeShellSection } from "./boot/ShellSection.js";
import { contributeHardRefreshCommand } from "./boot/hard-refresh-command.js";
import {
  shellOwnsSession,
  onShellUpdateReady,
  rememberShellToken,
  reportBootFailed,
  reportBootOk,
  serverBaseUrl,
  shellToken,
  type ShellUpdateReady,
} from "./boot/shell.js";
import { ReloadPrompt } from "./boot/reload-prompt.js";
import { registerServiceWorker, type UpdateFlow } from "./boot/update.js";
import { trackViewportHeight } from "./boot/viewport.js";
import { importMapSpecifiers, installDevImportMap, missingSpecifiers, pageMapLacksPlugins } from "./loader/importmap.js";
import { failureNotice, loadPlugins, pluginSpecifier } from "./loader/loader.js";
import { BareManager } from "./safe-mode/BareManager.js";
import { AppFrame } from "./ui/AppFrame.js";
import { BootFailure, BootScreen, UnsupportedBrowser, supportsImportMaps } from "./ui/BootScreen.js";

import "./styles.css";

const found = document.getElementById("root");
if (!found) throw new Error("index.html is missing #root");
const container: HTMLElement = found;
const root: Root = createRoot(container);

const render = (node: ReactNode): void =>
  root.render(
    <StrictMode>
      <PluginErrorBoundary
        pluginId="kernel"
        point="app.root"
        fallback={({ error }) => <BootFailure error={error} />}
      >
        {node}
      </PluginErrorBoundary>
    </StrictMode>,
  );

void boot();

async function boot(): Promise<void> {
  if (!supportsImportMaps()) {
    render(<UnsupportedBrowser />);
    reportBootFailed("this webview does not support import maps");
    return;
  }

  paintKernelDefaultTokens(document.documentElement);
  trackViewportHeight();

  const safeMode = safeModeFrom(location.search);

  if (!shellOwnsSession()) {
    updates = registerServiceWorker((apply) => reloadPrompt.offerUpdate(apply));
  }

  let shellUpdate: ShellUpdateReady | undefined;
  onShellUpdateReady((info) => {
    shellUpdate = info;
    const host = runtime?.host;
    if (host) notifyShellUpdate(host, info);
  });

  render(<BootScreen message="Starting…" />);

  const token = shellToken();
  let user: SessionUser | undefined;
  let offlineBoot = false;
  try {
    user = await me(token);
    if (user) rememberSession(user);
    else forgetSession();
  } catch (error) {
    if (!(error instanceof OfflineError)) {
      render(<BootFailure error={asError(error)} />);
      reportBootFailed(`the session check failed: ${asError(error).message}`);
      return;
    }
    user = cachedSession();
    offlineBoot = user !== undefined;
    if (!user) {
      render(<BootFailure error={asError(error)} offline />);
      reportBootFailed("offline, and no session has been established on this device yet");
      return;
    }
  }

  const resetToken = resetTokenFromHash();

  if (!user || resetToken) {
    reportBootOk();
    render(
      <AuthGate
        bearer={shellOwnsSession()}
        resetToken={resetToken}
        inviteToken={inviteTokenFromHash()}
        onSignedIn={(signedIn, issued) => {
          if (issued) rememberShellToken(issued);
          rememberSession(signedIn);
          if (pageMapLacksPlugins()) {
            location.reload();
            return;
          }
          void withSession(signedIn, issued ?? token);
        }}
      />,
    );
    return;
  }

  await withSession(user, token);

  async function withSession(signedIn: SessionUser, bearer: string | undefined): Promise<void> {
    try {
      render(<BootScreen message="Opening your workspace…" />);
      const server = serverBaseUrl();
      runtime = await initKernel({
        user: signedIn,
        ...(bearer ? { bearerToken: bearer } : {}),
        ...(server ? { serverBaseUrl: server } : {}),
        root: container,
        bootMode: bootModeFor(safeMode),
        logout: (options) => signOut(runtime, bearer, options),
        onPluginProblem: (problem) => reportPluginProblem(problem),
        onCoreUnavailable: (error) => console.warn("[wasm] core unavailable", error.message),
      });
      const host = runtime.host;

      let wasConnected = false;
      host.sync.api().subscribe((state) => {
        const connected = state.status === "syncing" || state.status === "synced";
        if (connected && !wasConnected) updates?.check();
        wasConnected = connected;
      });

      notifyPluginProblems(host);

      reloadPrompt.attach((notice) => host.notices.notify(notice));
      if (shellUpdate) notifyShellUpdate(host, shellUpdate);

      render(
        <AppFrame
          host={host}
          bearer={shellOwnsSession() || bearer !== undefined}
          onSignedIn={(_user, issued) => resumeSession(issued)}
        />,
      );

      if (safeMode === "bare") {
        host.mount.mount("kernel", <BareManager user={signedIn} {...(bearer ? { token: bearer } : {})} />);
        reportBootOk();
        return;
      }

      await activatePlugins(host, bearer, safeMode === "base", offlineBoot);

      await contributeShellSection(host).catch((error: unknown) => console.warn("[shell] the device section could not be added", error));
      await contributeHardRefreshCommand(host).catch((error: unknown) => console.warn("[app] the hard refresh command could not be added", error));

      reportBootOk();
    } catch (error) {
      const failure = asError(error);
      render(<BootFailure error={failure} />);
      reportBootFailed(failure.message);
    }
  }
}

function notifyShellUpdate(host: KernelHost, info: ShellUpdateReady): void {
  host.notices.notify({
    id: "kernel:shell-update-ready",
    level: "info",
    message: "An app update is ready. Close and reopen ddd to finish it.",
    ...(info.bundleVersion ? { detail: `Bundle ${info.bundleVersion} is verified and staged.` } : {}),
  });
}

let runtime: KernelRuntime | undefined;
let updates: UpdateFlow | undefined;

const reloadPrompt = new ReloadPrompt();

const pluginProblems: string[] = [];

function reportPluginProblem(problem: {
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
}): void {
  console.warn(`[plugin:${problem.pluginId}] ${problem.point}: ${problem.message}`);
  const line = `${problem.pluginId} — ${problem.point}: ${problem.message}`;
  if (pluginProblems.includes(line)) return;
  pluginProblems.push(line);
  const host = runtime?.host;
  if (host) notifyPluginProblems(host);
}

function notifyPluginProblems(host: KernelHost): void {
  if (pluginProblems.length === 0) return;
  const count = pluginProblems.length;
  host.notices.notify({
    id: "kernel:plugin-problems",
    level: "warning",
    message: `${count} plugin problem${count === 1 ? "" : "s"}.`,
    detail: pluginProblems.join("\n"),
    actions: [
      {
        label: "Open admin",
        run: () => {
          location.hash = "#/admin/plugins";
        },
      },
    ],
  });
}

function resumeSession(issued: string | undefined): void {
  if (issued !== undefined) {
    rememberShellToken(issued);
    location.reload();
    return;
  }
  runtime?.sync.reconnectNow();
}

async function activatePlugins(
  host: KernelHost,
  bearer: string | undefined,
  baseOnly: boolean,
  offlineBoot: boolean,
): Promise<void> {
  const { plugins, load } = await installedSet(host, bearer, offlineBoot);
  if (!load) {
    if (plugins.length > 0) {
      console.warn("[loader] the plugin list has no load resolution; not activating plugins until a reload fetches one");
      reloadPrompt.askForStale();
    }
    return;
  }
  const order = baseOnly ? load.safe : load.normal;
  const loading = new Set(order);

  await installDevImportMap(plugins.filter((plugin) => loading.has(plugin.manifest.id)));

  const specifiers = importMapSpecifiers();
  const missing = missingSpecifiers(specifiers);
  if (missing.length > 0) {
    console.error(
      `[loader] the import map does not resolve: ${missing.join(", ")}. Rebuild the app bundle (\`mise run web-build\`) so the server can serve a complete map.`,
    );
    host.notices.notify({
      id: "kernel:import-map-incomplete",
      level: "error",
      message: "Some plugins may not load. Reinstall or update the app.",
      detail: `The import map does not resolve: ${missing.join(", ")}.`,
    });
  }

  const report = await loadPlugins({
    host,
    plugins,
    kernelVersion: KERNEL_API_VERSION,
    order,
    serverSkipped: load.skipped,
    ...(specifiers ? { available: (id: string) => specifiers.has(pluginSpecifier(id)) } : {}),
  });

  console.info(
    `[loader] ${report.activated.length} activated, ${report.failed.length} failed, ${report.skipped.length} skipped in ${report.elapsedMs} ms`,
  );

  const notice = failureNotice(report, () => {
    location.hash = "#/admin/plugins";
  });
  if (notice) host.notices.notify(notice);
}

async function installedSet(
  host: KernelHost,
  bearer: string | undefined,
  offlineBoot: boolean,
): Promise<{ readonly plugins: readonly InstalledPlugin[]; readonly load?: PluginLoad }> {
  try {
    const { plugins, load } = await installedPlugins(bearer);
    rememberPlugins(plugins, load);
    return { plugins, ...(load ? { load } : {}) };
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    const remembered = cachedPlugins();
    if (remembered) {
      console.info(`[loader] offline: activating the ${remembered.length} plugins last seen here`);
      const load = cachedLoad();
      return { plugins: remembered, ...(load ? { load } : {}) };
    }
    host.notices.notify({
      id: "kernel:plugins-unavailable",
      level: "error",
      message: offlineBoot
        ? "Offline, and this device has never fetched the plugin list."
        : "The plugin list could not be fetched.",
      detail:
        "Your documents are here, but the interface could not load. Reconnect and reload once.",
      actions: [{ label: "Reload", run: () => location.reload() }],
    });
    return { plugins: [] };
  }
}

async function signOut(
  current: KernelRuntime | undefined,
  bearer: string | undefined,
  options: LogoutOptions,
): Promise<void> {
  const pending = Math.max(current?.sync.pending ?? 0, (await current?.host.documents.unsentCount().catch(() => 0)) ?? 0);
  if (pending > 0 && !options.discardUnsynced) {
    throw new Error(
      `${pending} local edit${pending === 1 ? "" : "s"} have not reached the server yet. Wait for sync, or sign out discarding them.`,
    );
  }
  try {
    await logoutRequest(bearer);
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
  } finally {
    current?.host.settings.stop();
    current?.sync.stop();
    await current?.engine.close();
    await current?.store.clear();
    await deletePluginDatabases();
    await globalThis.caches?.delete("ddd:api").catch(() => false);
    rememberShellToken(undefined);
    forgetBootCache();
    location.assign("/");
  }
}

async function deletePluginDatabases(): Promise<void> {
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    for (const { name } of databases) {
      if (name?.startsWith("ddd:")) indexedDB.deleteDatabase(name);
    }
  } catch {
  }
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
