/**
 * The PWA entry point: the boot sequence of SPEC §9 M3, in order, with every step
 * visible.
 *
 * ```
 * browser floor  →  service worker  →  auth gate  →  kernel init  →  import map
 *                →  plugin list  →  topological activation  →  shell mounts
 * ```
 *
 * Four properties of this sequence are load-bearing:
 *
 * 1. **The auth gate comes before the kernel.** The kernel opens IndexedDB and a
 *    socket as the signed-in user; there is no "anonymous kernel" to hand a login
 *    form to, and plugins are served to authenticated clients only.
 * 2. **The kernel comes before the plugins, and boots fully offline.** By the time
 *    the first `activate()` runs, the projection is readable, the query engine is
 *    warm and sync is running or retrying. A plugin never has to ask "is the kernel
 *    ready".
 * 3. **The whole sequence survives having no network.** The two REST calls in it —
 *    `/auth/me` and `/plugins` — are `NetworkOnly` in the service worker by design, so
 *    each one falls back to what the last successful boot remembered (`boot/cache.ts`)
 *    instead of failing the boot. An offline reload opens the local workspace; it does
 *    not show "Life Manager could not start" (SPEC §4.1, §8).
 * 4. **A plugin failure is contained and reported once.** The frame renders either
 *    way; the aggregated notice says what broke (SPEC §6.4), and registry rejections and
 *    render failures land in the same notice centre rather than in the console alone.
 *
 * M5 adds a fifth, and it is the one with teeth: **inside the Flutter shell this sequence
 * reports its own outcome.** The shell has already written `failedBoots` to disk before
 * the webview loaded, and `shell.bootOk()` — sent here, after the plugin set has
 * activated — is the only thing that clears it (`app/BRIDGE.md` §7). Two consequences
 * worth stating: every early `return` on a failure path is a *silent* failed boot unless
 * it says so (hence `reportBootFailed`), and `bootOk` must not move earlier, because a
 * bundle that renders and then throws has not booted.
 */

import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  KERNEL_API_VERSION,
  type InstalledPlugin,
  type LiveWiring,
  type LogoutOptions,
  type ProtocolPackage,
  type ResolvedPluginSet,
  type SessionUser,
} from "@kernel";
import {
  PluginErrorBoundary,
  paintKernelDefaultTokens,
  type KernelHost,
} from "@kernel/runtime/index.js";

import { AuthGate } from "./boot/AuthGate.js";
import { OfflineError, installedPlugins, type PluginList, inviteTokenFromHash, logoutRequest, me, resetTokenFromHash } from "./boot/api.js";
import {
  cachedPlugins,
  cachedProtocols,
  cachedResolution,
  cachedSession,
  cachedWiring,
  forgetBootCache,
  forgetSession,
  rememberPlugins,
  rememberSession,
} from "./boot/cache.js";
import { initKernel, type KernelRuntime } from "./boot/kernel-init.js";
import { bootModeFor, safeModeFrom } from "./boot/safe-mode.js";
import { contributeShellSection } from "./boot/ShellSection.js";
import {
  inShell,
  onShellUpdateReady,
  rememberShellToken,
  reportBootFailed,
  reportBootOk,
  serverBaseUrl,
  shellToken,
  type ShellUpdateReady,
} from "./boot/shell.js";
import { ReloadPrompt, WiringWatch } from "./boot/reload-prompt.js";
import { installTestHooks } from "./boot/test-hooks.js";
import { registerServiceWorker } from "./boot/update.js";
import { trackViewportHeight } from "./boot/viewport.js";
import { installDevImportMap, missingSpecifiers, pageImportMap } from "./loader/importmap.js";
import { failureNotice, loadPlugins, type ActiveModule } from "./loader/loader.js";
import { PluginRuntime } from "./loader/runtime.js";
import { BareManager } from "./safe-mode/BareManager.js";
import { AppFrame } from "./ui/AppFrame.js";
import { BootFailure, BootScreen, UnsupportedBrowser, supportsImportMaps } from "./ui/BootScreen.js";

import "./styles.css";

const found = document.getElementById("root");
if (!found) throw new Error("index.html is missing #root");
/** Narrowing does not survive into the closures below; this does. */
const container: HTMLElement = found;
const root: Root = createRoot(container);

/**
 * Every render goes through one root boundary.
 *
 * React 18 unmounts the whole tree on an uncaught render error, and an unmounted root
 * is a white page: no notice strip, no in-place "plugin X failed" chip, and no link to
 * safe mode — so the user's only way out is knowing to type `?safe=bare` by hand.
 * `AppFrame` contains failures inside the plugin mount; this contains the frame itself,
 * so there is no render path left that can end in a blank document (SPEC §6.4).
 */
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
    // A webview too old for import maps is a shell problem, not a bundle problem: say so
    // rather than letting the watchdog revert to a bundle that cannot run either.
    reportBootFailed("this webview does not support import maps");
    return;
  }

  // Before the first render: the boot screen, the auth gate and a boot failure are
  // all written in kernel tokens, and none of them has a kernel yet (SPEC §6.4 —
  // the kernel ships the default light/dark token values).
  paintKernelDefaultTokens(document.documentElement);
  // And `--lm-viewport-height`, for the same reason and at the same moment: the auth
  // gate is a form a soft keyboard covers, and it renders before any plugin exists.
  trackViewportHeight();

  const safeMode = safeModeFrom(location.search);

  // Registered early so an update found mid-session still surfaces, but it never
  // takes over on its own (see update.ts).
  //
  // **Not in the shell.** `sw.js` is deliberately excluded from the bundle
  // (`app/BRIDGE.md` §5): the loopback origin already *is* the offline cache, and a worker
  // installed there would fight the bundle updater for control of what the webview sees —
  // two caches, two update stories, one of them invisible to the revert path. Registration
  // would also just 404, since the local server serves only manifest-listed paths.
  //
  // The prompt is the one shared with wiring changes (`reload-prompt.ts`): a user is asked
  // to reload once, whatever the reasons.
  if (!inShell()) {
    registerServiceWorker((apply) => reloadPrompt.offerUpdate(apply));
  }

  // The shell's half of the same story. A staged bundle is never applied to a running
  // webview (`app/BRIDGE.md` §7 — the page holds IndexedDB handles, a socket and an
  // activated plugin graph), so there is no "Reload" action to offer: promotion happens
  // at the next launch, and the only honest instruction is to reopen the app.
  let shellUpdate: ShellUpdateReady | undefined;
  onShellUpdateReady((info) => {
    shellUpdate = info;
    const host = runtime?.host;
    if (host) notifyShellUpdate(host, info);
  });

  render(<BootScreen message="Starting…" />);

  const token = shellToken();
  let user: SessionUser | undefined;
  /** True when the session came from the cache: the server was unreachable. */
  let offlineBoot = false;
  try {
    user = await me(token);
    if (user) rememberSession(user);
    // The server answered "not signed in", which is the one authoritative way to learn
    // the session is over. Anything remembered about it is now wrong.
    else forgetSession();
  } catch (error) {
    if (!(error instanceof OfflineError)) {
      render(<BootFailure error={asError(error)} />);
      reportBootFailed(`the session check failed: ${asError(error).message}`);
      return;
    }
    // No server. Boot the local workspace as whoever was last signed in here; if the
    // session has really expired, the socket answers `4401` and `ReauthOverlay` asks —
    // over the top of a workspace that is still readable (SPEC §5.3).
    user = cachedSession();
    offlineBoot = user !== undefined;
    if (!user) {
      render(<BootFailure error={asError(error)} offline />);
      // Nothing is wrong with the bundle: there is no server and nobody has ever signed
      // in on this device. Reverting would not help, and the shell's own recovery screen
      // is the wrong answer too — so this says why and leaves the counter to the watchdog
      // only if the user never gets further.
      reportBootFailed("offline, and no session has been established on this device yet");
      return;
    }
  }

  // A reset link (`#/reset/<token>`) is for someone who cannot sign in, so it shows the
  // "set a new password" form whatever this device's session says.
  const resetToken = resetTokenFromHash();

  if (!user || resetToken) {
    // **A booted bundle.** The kernel is not up — there is no session to build one with —
    // but the sequence ran to completion and put a working login form on screen, which is
    // the only correct thing to show for "the server says you are not signed in".
    //
    // Saying nothing here was the bug: the shell had already incremented `failedBoots`
    // before the webview loaded, and only `bootOk()` clears it (`app/BRIDGE.md` §7). So a
    // session that simply idled past its 30-day expiry (SPEC §5.2) produced a 25 s
    // watchdog expiry mid-typing, a native "Life Manager could not start" over the login
    // form, and — two launches later — a revert that quarantined a perfectly good bundle,
    // permanently, for a failure that had nothing to do with it.
    reportBootOk();
    render(
      <AuthGate
        // **In the shell, always ask for a bearer token** (SPEC §5.2): a cookie cannot
        // survive the loopback origin, so a shell that logs in without this flag gets a
        // `Set-Cookie` it will never send back and looks signed out on the next call.
        // `token !== undefined` was the wrong test — on first run there is no token yet,
        // which is exactly when the login form is shown.
        bearer={inShell()}
        resetToken={resetToken}
        inviteToken={inviteTokenFromHash()}
        onSignedIn={(signedIn, issued) => {
          if (issued) rememberShellToken(issued);
          rememberSession(signedIn);
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
        // The shell's server; absent in a browser, where every default is the page
        // origin already (`app/BRIDGE.md` §6).
        ...(server ? { serverBaseUrl: server } : {}),
        root: container,
        bootMode: bootModeFor(safeMode),
        logout: (options) => signOut(runtime, bearer, options),
        onPluginProblem: (problem) => reportPluginProblem(problem),
        onWiringVersion: (version) => wiringWatch.seen(version),
        onCoreUnavailable: (error) => console.warn("[wasm] core unavailable", error.message),
      });
      const host = runtime.host;

      // A problem reported while the kernel was still being built has no notice yet.
      notifyPluginProblems(host);

      // An update that arrived before the kernel existed has no notice yet; this shows it.
      reloadPrompt.attach((notice) => host.notices.notify(notice));
      if (shellUpdate) notifyShellUpdate(host, shellUpdate);

      // Shell-only, and nothing is contributed in a browser: which bridge this device
      // speaks, what it can do natively, and which bundle is running (SPEC §9 M5's OTA
      // and revert criteria are not testable without a visible version).
      contributeShellSection(host);

      render(
        <AppFrame
          host={host}
          // `inShell()` and not just "we have a token": the re-auth overlay of SPEC §5.3
          // must ask for a *bearer* token in the shell even on a launch that arrived here
          // without one, because a cookie cannot survive the loopback origin.
          bearer={inShell() || bearer !== undefined}
          onSignedIn={(_user, issued) => resumeSession(issued)}
        />,
      );

      if (safeMode === "bare") {
        // No plugins at all: the kernel's own manager takes the mount (SPEC §6.1).
        host.mount.mount("kernel", <BareManager {...(bearer ? { token: bearer } : {})} />);
        // `?safe=bare` *is* a successful boot: the workspace is open and the built-in
        // manager is on screen. Reverting a bundle that got this far would throw away the
        // one screen from which a broken plugin can be disabled (`app/BRIDGE.md` §7).
        reportBootOk();
        return;
      }

      await activatePlugins(host, bearer, safeMode === "base", offlineBoot);

      // **Interactive.** The kernel is up, the projection is readable, and the plugin set
      // has activated (or failed, contained and reported — a workspace with a broken
      // plugin is still a booted bundle, and its second-attempt safe mode is what
      // diagnoses that). This is the moment `app/BRIDGE.md` §7 clears `failedBoots` on,
      // and the last line of the boot sequence on purpose.
      reportBootOk();
    } catch (error) {
      const failure = asError(error);
      render(<BootFailure error={failure} />);
      reportBootFailed(failure.message);
    }
  }
}

/**
 * The shell staged a verified bundle. There is no "Reload" here and that is the whole
 * point: reloading re-runs the *current* bundle, because promotion happens at launch with
 * nothing running (`app/BRIDGE.md` §7). Offering a button that appears to update and does
 * not is worse than telling the truth.
 */
function notifyShellUpdate(host: KernelHost, info: ShellUpdateReady): void {
  host.notices.notify({
    id: "kernel:shell-update-ready",
    level: "info",
    message: "An app update is ready. Close and reopen Life Manager to finish it.",
    ...(info.bundleVersion ? { detail: `Bundle ${info.bundleVersion} is verified and staged.` } : {}),
  });
}

let runtime: KernelRuntime | undefined;

/** The one reload prompt, shared by the service-worker update and wiring changes. */
const reloadPrompt = new ReloadPrompt();

/**
 * The wiring version this page runs against the server's. Behind means a reload until
 * clients can rewire in place (PLUGIN-PROTOCOLS §6c).
 */
const wiringWatch = new WiringWatch(() => void followWiring());

/** The activated plugin set, once boot is done: what a wiring change is applied to. */
let pluginRuntime: PluginRuntime | undefined;
/** How this page booted, for fetching the next plugin set the same way. */
let bootContext: { readonly bearer: string | undefined; readonly baseOnly: boolean } | undefined;
/** A reload has been asked for: later versions wait behind it rather than half-applying. */
let reloadPending = false;
/** One follow at a time; a version that lands meanwhile is picked up when it finishes. */
let following: Promise<void> | undefined;

/**
 * The server's wiring moved past this page's (PLUGIN-PROTOCOLS §6c): fetch the new plugin
 * set and apply it in place, or ask for a reload when the change needs one. Hot applies
 * are silent.
 */
async function followWiring(): Promise<void> {
  if (following || reloadPending) return;
  following = (async () => {
    const runtime = pluginRuntime;
    const context = bootContext;
    if (!runtime || !context) {
      // No runtime: a boot without a resolution (an older server's list), or `?safe=bare`.
      reloadPending = true;
      reloadPrompt.askForWiring();
      return;
    }
    let list: PluginList;
    try {
      list = await installedPlugins(context.bearer);
    } catch {
      // Offline between the frame and the fetch: the next `welcome` brings it back here.
      return;
    }
    if (!list.wiring || !list.resolved) {
      reloadPending = true;
      reloadPrompt.askForWiring();
      return;
    }
    const outcome = await runtime.apply({
      plugins: list.plugins,
      wiring: list.wiring,
      resolution: context.baseOnly ? list.resolved.safe : list.resolved.normal,
      protocols: list.protocols ?? [],
    });
    if (outcome.kind === "reload") {
      console.info(`[wiring] v${list.wiring.version} needs a reload: ${outcome.reasons.join("; ")}`);
      reloadPending = true;
      reloadPrompt.askForWiring();
      return;
    }
    rememberPlugins(list.plugins, list.wiring, list.resolved, list.protocols);
    console.info(
      `[wiring] applied v${list.wiring.version} in place: stopped ${outcome.plan.stop.length}, restarted ${outcome.plan.restart.length}, started ${outcome.plan.start.length}`,
    );
    if (outcome.failed.length > 0) {
      reportPluginProblem({ pluginId: outcome.failed.join(", "), point: "wiring", message: "failed to start after a wiring change" });
    }
    wiringWatch.setRunning(list.wiring.version);
  })().finally(() => {
    following = undefined;
  });
  await following;
}

/**
 * Every plugin problem the kernel detects — a contribution rejected by shape or key
 * validation, and every error boundary that caught a render — aggregated into **one**
 * notice, with the count in the message and the individual lines in the detail.
 *
 * It is one notice rather than one per problem for the reason SPEC §6.4 gives for
 * activation failures: a workspace with three broken plugins must not show three
 * modals. And it is a notice rather than a `console.warn` because the console is not a
 * user interface — a `sidebar.panel` that throws at render shows its in-place chip, and
 * without this the user has no way to learn *which* plugin it was or that admin is
 * where to go next (SPEC §6.4: validation "rejects loudly").
 */
const pluginProblems: string[] = [];

function reportPluginProblem(problem: {
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
}): void {
  console.warn(`[plugin:${problem.pluginId}] ${problem.point}: ${problem.message}`);
  const line = `${problem.pluginId} — ${problem.point}: ${problem.message}`;
  // The same component can throw on every re-render; the notice lists distinct problems.
  if (pluginProblems.includes(line)) return;
  pluginProblems.push(line);
  const host = runtime?.host;
  // Before the kernel exists there is nowhere to put it; the list is replayed by
  // `notifyPluginProblems` as soon as there is.
  if (host) notifyPluginProblems(host);
}

function notifyPluginProblems(host: KernelHost): void {
  if (pluginProblems.length === 0) return;
  const count = pluginProblems.length;
  host.notices.notify({
    id: "kernel:plugin-problems",
    level: "warning",
    // "in this session" is scoping trivia: a notice is always about this session.
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

/**
 * After a mid-session re-login (the 4401 path of SPEC §5.3): resume, without ever
 * touching local data.
 *
 * A cookie session just reconnects — the new cookie is already on the connection the
 * socket will make. A **shell** session comes back with a *new* bearer token, and the
 * kernel's `fetch` and the socket were both built with the old one, so the honest
 * move is to store it and reload: rebuilding the session carrier underneath a running
 * plugin set is how you get half the app authenticating and half not. The reload
 * re-reads IndexedDB; nothing is cleared either way.
 */
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
  // In development there is no server-injected map; build one over this bundle's
  // own modules so a plugin's `import "react"` resolves to the same React.
  await installDevImportMap();

  const missing = missingSpecifiers(pageImportMap());
  if (missing.length > 0) {
    console.error(
      `[loader] the import map does not resolve: ${missing.join(", ")}. Rebuild the app bundle (\`mise run web-build\`) so the server can serve a complete map.`,
    );
    host.notices.notify({
      id: "kernel:import-map-incomplete",
      level: "error",
      // A build command is an instruction to whoever ships the app, not to whoever
      // opened it. The console keeps it; the notice says what the reader can do.
      message: "Some plugins may not load. Reinstall or update the app.",
      detail: `The import map does not resolve: ${missing.join(", ")}.`,
    });
  }

  const { plugins, wiringVersion, wiring, resolved, protocols } = await installedSet(host, bearer, offlineBoot);
  // The server resolved the wiring for both boot modes; the loader activates from the one
  // this page is in (PLUGIN-PROTOCOLS §6), and orders by itself only without one.
  const resolution = resolved ? (baseOnly ? resolved.safe : resolved.normal) : undefined;
  const activeModules = new Map<string, ActiveModule>();
  const report = await loadPlugins({
    host,
    plugins,
    kernelVersion: KERNEL_API_VERSION,
    baseOnly,
    ...(resolution ? { resolution } : {}),
    ...(protocols ? { protocols } : {}),
    activeModules,
  });

  // Hot apply needs the server's resolution to diff against; without one (an older
  // server, or a cache from before wiring) a change asks for a reload instead.
  if (resolution && wiring) {
    pluginRuntime = new PluginRuntime({
      host,
      current: { plugins, wiring, resolution, protocols: protocols ?? [] },
      active: activeModules,
      importMap: () => new Set(Object.keys(pageImportMap()?.imports ?? {})),
    });
  }
  bootContext = { bearer, baseOnly };
  if (pluginRuntime) installTestHooks(host, pluginRuntime, baseOnly);
  // Only now: a newer version seen during boot is applied to the finished plugin set.
  wiringWatch.setRunning(wiringVersion);

  console.info(
    `[loader] ${report.activated.length} activated, ${report.failed.length} failed, ${report.skipped.length} skipped in ${report.elapsedMs} ms`,
  );

  const notice = failureNotice(report, () => {
    location.hash = "#/admin/plugins";
  });
  if (notice) host.notices.notify(notice);
}

/**
 * The installed set, from the server when it is reachable and from the last boot when
 * it is not.
 *
 * `GET /api/plugins` is `NetworkOnly` in the service worker (a cached API response is a
 * second copy of the workspace, `sw.ts`), so offline this is the only thing standing
 * between a synced workspace and an app with no user interface in it at all. The
 * remembered list points at `/plugins/<id>/<version>/…` URLs, which the service worker
 * *does* cache immutably (SPEC §8) — so the modules behind it are genuinely present.
 */
async function installedSet(
  host: KernelHost,
  bearer: string | undefined,
  offlineBoot: boolean,
): Promise<{
  readonly plugins: readonly InstalledPlugin[];
  readonly wiringVersion: number;
  readonly wiring?: LiveWiring;
  readonly resolved?: ResolvedPluginSet;
  readonly protocols?: readonly ProtocolPackage[];
}> {
  try {
    const { plugins, wiring, resolved, protocols } = await installedPlugins(bearer);
    rememberPlugins(plugins, wiring, resolved, protocols);
    return {
      plugins,
      wiringVersion: wiring?.version ?? 0,
      ...(wiring ? { wiring } : {}),
      ...(resolved ? { resolved } : {}),
      ...(protocols ? { protocols } : {}),
    };
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    const remembered = cachedPlugins();
    if (remembered) {
      console.info(`[loader] offline: activating the ${remembered.length} plugins last seen here`);
      const resolved = cachedResolution();
      const protocols = cachedProtocols();
      const wiring = cachedWiring();
      return {
        plugins: remembered,
        wiringVersion: wiring?.version ?? 0,
        ...(wiring ? { wiring } : {}),
        ...(resolved ? { resolved } : {}),
        ...(protocols ? { protocols } : {}),
      };
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
    return { plugins: [], wiringVersion: 0 };
  }
}

/**
 * Sign-out — the one destructive local path (SPEC §5.3). It blocks while edits are
 * unsynced unless the user has explicitly chosen to discard them, because clearing
 * the stores is what deletes the only copy.
 */
async function signOut(
  current: KernelRuntime | undefined,
  bearer: string | undefined,
  options: LogoutOptions,
): Promise<void> {
  // Every unsent change on the device, not only the open notes': sign-out deletes them.
  const pending = Math.max(current?.sync.pending ?? 0, (await current?.host.documents.unsentCount().catch(() => 0)) ?? 0);
  if (pending > 0 && !options.discardUnsynced) {
    throw new Error(
      `${pending} local edit${pending === 1 ? "" : "s"} have not reached the server yet. Wait for sync, or sign out discarding them.`,
    );
  }
  try {
    await logoutRequest(bearer);
  } catch (error) {
    // Offline sign-out still clears this device (shared-device safety, SPEC §5.3); the
    // server-side session expires on its own schedule.
    if (!(error instanceof OfflineError)) throw error;
  } finally {
    current?.host.settings.stop();
    current?.sync.stop();
    await current?.engine.close();
    await current?.store.clear();
    await deletePluginDatabases();
    // Server screens' offline copies (`kernel.session.fetch`, dev-docs/resolved/SYNC-DECISIONS.md §9).
    await globalThis.caches?.delete("life-manager:api").catch(() => false);
    rememberShellToken(undefined);
    forgetBootCache();
    location.assign("/");
  }
}

/**
 * Plugins that keep their own data on the device name its database `life-manager:…`
 * (the files `attachments` holds while offline): it goes with the rest on sign-out.
 */
async function deletePluginDatabases(): Promise<void> {
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    for (const { name } of databases) {
      if (name?.startsWith("life-manager:")) indexedDB.deleteDatabase(name);
    }
  } catch {
    // No listing in this browser: nothing more can be found to delete.
  }
}

/**
 * The bearer token, **for shells only**, and everything else about running inside one,
 * now lives in `boot/shell.ts` (SPEC §5.2, `app/BRIDGE.md` §6). It moved out of this file
 * in M5 because three other things needed the same knowledge — the API base, the socket
 * URL and `bootOk` — and a private helper at the bottom of the entry point could not be
 * shared or tested.
 *
 * The rule it enforces is unchanged and worth repeating here, where the session is built:
 * a browser never reads or writes a token. Its session is an HTTP-only cookie the page
 * cannot see, and a long-lived credential in web storage on an origin that runs
 * full-trust plugin code (SPEC §6.1) is readable by every plugin and by any DOM-XSS on
 * the page — which is exactly what the cookie path makes impossible.
 */

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
