/**
 * The boot sequence's side of the bridge (`app/BRIDGE.md` §3, §4.1, §6, §7), checked
 * against the same `app/bridge_fixtures/` the Dart handlers are written against.
 *
 * Four properties are load-bearing enough to be tested rather than reviewed:
 *
 * 1. **A browser is unaffected.** No token is read or written, no API base moves, and
 *    `bootOk` is never called. That is the security property of SPEC §5.2, not an
 *    implementation detail — a long-lived credential in web storage on an origin that
 *    runs full-trust plugin code (SPEC §6.1) is exactly what the cookie design prevents.
 * 2. **API and socket URLs resolve against `shell.serverBaseUrl`.** Without this the
 *    shell signs in and then never syncs, because the page's own origin is the loopback
 *    bundle server (`BRIDGE.md` §6).
 * 3. **`bootOk` is sent once**, and never after a failure was reported. It is the only
 *    thing that clears the shell's on-disk failed-boot counter (`BRIDGE.md` §7).
 * 4. **Nothing here throws** — a bridge that is missing, half-injected or a plugin's idea
 *    of a joke must degrade to the browser path rather than take the boot down with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fixtureIndex,
  readFixture,
  type ManifestFixture,
  type WindowShellFixture,
} from "@kernel/runtime/bridge-fixtures.js";

import {
  apiBase,
  inShell,
  onShellUpdateReady,
  readShellManifest,
  rememberShellToken,
  reportBootFailed,
  reportBootOk,
  resetBootReportForTests,
  serverBaseUrl,
  shellInfo,
  shellToken,
  SHELL_UPDATE_EVENT,
} from "./shell.js";

const index = fixtureIndex();
const windowShell = readFixture<WindowShellFixture>("window_shell.json");
const manifestFixture = readFixture<ManifestFixture>("manifest.json");

const globals = globalThis as {
  shell?: unknown;
  dddShellUpdateReady?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
  dispatchEvent?: unknown;
};

interface FakeShell {
  bootOk: ReturnType<typeof vi.fn>;
  bootFailed: ReturnType<typeof vi.fn>;
  setBearerToken: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

/** `window.shell` exactly as `bootstrapScript` injects it (`window_shell.json`). */
function injectShell(overrides: Record<string, unknown> = {}): FakeShell {
  const injected = windowShell.injected;
  const shell: FakeShell = {
    version: injected.version,
    bridgeVersion: injected.bridgeVersion,
    platform: injected.platform,
    serverBaseUrl: injected.serverBaseUrl,
    bearerToken: injected.bearerToken,
    capabilities: injected.capabilities,
    methods: injected.methods,
    bootOk: vi.fn(),
    bootFailed: vi.fn(),
    setBearerToken: vi.fn(),
    ...overrides,
  };
  globals.shell = shell;
  return shell;
}

beforeEach(() => {
  resetBootReportForTests();
});

afterEach(() => {
  delete globals.shell;
  delete globals.dddShellUpdateReady;
  resetBootReportForTests();
});

describe("in a plain browser", () => {
  it("is not in a shell and keeps every default", () => {
    expect(inShell()).toBe(false);
    expect(serverBaseUrl()).toBeUndefined();
    // Same-origin `/api` — the browser's answer, and the one the service worker's
    // routes and the cookie's `SameSite` are written against.
    expect(apiBase()).toBe("/api");
    expect(shellToken()).toBeUndefined();
    expect(shellInfo()).toBeUndefined();
  });

  it("neither reads nor reports anything, and nothing throws", () => {
    expect(() => reportBootOk()).not.toThrow();
    expect(() => reportBootFailed("x")).not.toThrow();
    expect(() => rememberShellToken("a-token")).not.toThrow();
    // No listener is installed at all: there is no shell to hear from.
    const stop = onShellUpdateReady(() => {
      throw new Error("a browser must never receive a shell update event");
    });
    expect(globals.dddShellUpdateReady).toBeUndefined();
    expect(() => stop()).not.toThrow();
  });

  it.each([
    ["a string", "yes"],
    ["an object claiming no version", { serverBaseUrl: "https://elsewhere.example.com", bearerToken: "nope" }],
    ["a non-numeric version", { version: "1", serverBaseUrl: "https://elsewhere.example.com" }],
  ])("refuses %s as a bridge (BRIDGE.md §3, rule 2)", (_name, candidate) => {
    // Full-trust plugins can put anything on `window` (SPEC §6.1), so an object that does
    // not say what it is must not switch boot from the cookie session to bearer auth
    // against an origin it named itself.
    globals.shell = candidate;
    expect(inShell()).toBe(false);
    expect(serverBaseUrl()).toBeUndefined();
    expect(apiBase()).toBe("/api");
    expect(shellToken()).toBeUndefined();
    expect(shellInfo()).toBeUndefined();
  });
});

describe("inside the shell", () => {
  it("resolves the API against the shell's server, not the loopback page origin", () => {
    injectShell();
    expect(inShell()).toBe(true);
    expect(serverBaseUrl()).toBe(windowShell.injected.serverBaseUrl);
    expect(apiBase()).toBe(`${windowShell.injected.serverBaseUrl}/api`);
  });

  it("ignores a serverBaseUrl that is not an absolute http(s) URL", () => {
    injectShell({ serverBaseUrl: "javascript:alert(1)" });
    expect(serverBaseUrl()).toBeUndefined();
    // The page origin is a working answer in a browser and a safe one everywhere.
    expect(apiBase()).toBe("/api");
  });

  it("reads the baked-in bearer token (SPEC §5.2) and hands new ones to the keystore", () => {
    const shell = injectShell();
    expect(shellToken()).toBe(windowShell.injected.bearerToken);

    rememberShellToken("ddd.session.Bz1…");
    expect(shell.setBearerToken).toHaveBeenCalledWith("ddd.session.Bz1…");
    // Sign-out forgets it: `null`, not `undefined`, because only JSON crosses the bridge.
    rememberShellToken(undefined);
    expect(shell.setBearerToken).toHaveBeenLastCalledWith(null);
  });

  it("survives a keystore that throws", () => {
    const shell = injectShell({
      setBearerToken: vi.fn(() => {
        throw new Error("keystore unavailable");
      }),
    });
    expect(() => rememberShellToken("t")).not.toThrow();
    expect(shell.setBearerToken).toHaveBeenCalled();
  });

  it("reports what the shell says about itself, method list included", () => {
    injectShell();
    const info = shellInfo();
    expect(info?.bridgeVersion).toBe(index.bridgeVersion);
    expect(info?.platform).toBe(windowShell.injected.platform);
    expect(info?.serverBaseUrl).toBe(windowShell.injected.serverBaseUrl);
    expect(info?.methods).toEqual(index.methods);
    expect(info?.capabilities).toEqual(index.capabilities);
    // The fixture injects no `bundleVersion` — the Dart `bootstrapScript` does not set
    // one — so the panel says "not reported by the shell".
    expect(info?.bundleVersion).toBeUndefined();
  });

  it("reports the running bundle when the shell does inject one", () => {
    // `bundleVersion` is a declared optional member of the bridge (`BRIDGE.md` §8: a new
    // optional member is not a version bump). This is the assertion that makes the web
    // half ready for it without the fixture — and the Dart side — having to move first.
    injectShell({ bundleVersion: manifestFixture.valid.bundle_version });
    expect(shellInfo()?.bundleVersion).toBe(manifestFixture.valid.bundle_version);
  });

  it("ignores a bundle version that is not a non-empty string", () => {
    // Full-trust plugin code can write anything onto `window.shell` (SPEC §6.1), and a
    // diagnostics panel printing `[object Object]` is the least of the reasons to narrow.
    injectShell({ bundleVersion: 42 as unknown as string });
    expect(shellInfo()?.bundleVersion).toBeUndefined();
    injectShell({ bundleVersion: "" });
    expect(shellInfo()?.bundleVersion).toBeUndefined();
  });

  it("still boots on a shell whose major is newer than this bundle", () => {
    // `BRIDGE.md` §8: an old bundle on a new shell "still works; it just does not get
    // native behaviour". Capabilities degrade (`detectBridge` refuses the ABI), but the
    // four boot members are plain values — degrade *those* and the app falls back to a
    // cookie on a loopback origin, which cannot work at all.
    const shell = injectShell({
      version: index.bridgeVersion + 1,
      bridgeVersion: index.bridgeVersion + 1,
    });
    expect(inShell()).toBe(true);
    expect(apiBase()).toBe(`${windowShell.injected.serverBaseUrl}/api`);
    expect(shellToken()).toBe(windowShell.injected.bearerToken);
    reportBootOk();
    expect(shell.bootOk).toHaveBeenCalledTimes(1);
    // And the settings panel can say *why* nothing native works, which needs the number
    // detection refused.
    expect(shellInfo()?.bridgeVersion).toBe(index.bridgeVersion + 1);
  });
});

describe("the boot report (BRIDGE.md §7)", () => {
  it("sends boot.ok exactly once", () => {
    const shell = injectShell();
    reportBootOk();
    reportBootOk();
    expect(shell.bootOk).toHaveBeenCalledTimes(1);
    expect(shell.bootFailed).not.toHaveBeenCalled();
  });

  it("does not send boot.ok after a failure was already reported", () => {
    const shell = injectShell();
    reportBootFailed("the session check failed");
    reportBootOk();
    expect(shell.bootFailed).toHaveBeenCalledWith("the session check failed");
    expect(shell.bootOk).not.toHaveBeenCalled();
  });

  it("does not fail the boot when the shell cannot hear it", () => {
    // A shell that registered neither handler still has its 25 s watchdog; the page's
    // job is done either way and must not throw on the way out.
    injectShell({ bootOk: undefined, bootFailed: undefined });
    expect(() => reportBootOk()).not.toThrow();
    expect(() => reportBootFailed("x")).not.toThrow();

    const throwing = injectShell({
      bootOk: vi.fn(() => {
        throw new Error("handler gone");
      }),
    });
    resetBootReportForTests();
    expect(() => reportBootOk()).not.toThrow();
    expect(throwing.bootOk).toHaveBeenCalled();
  });

  it("swallows a rejected bootOk promise rather than surfacing an unhandled rejection", async () => {
    const shell = injectShell({ bootOk: vi.fn(() => Promise.reject(new Error("no"))) });
    reportBootOk();
    await Promise.resolve();
    expect(shell.bootOk).toHaveBeenCalled();
  });
});

describe("the update-ready signal", () => {
  it("hears the function spelling and stops on unsubscribe", () => {
    injectShell();
    const seen: unknown[] = [];
    const stop = onShellUpdateReady((info) => seen.push(info));

    const notify = globals.dddShellUpdateReady as (info?: unknown) => void;
    expect(typeof notify).toBe("function");
    notify({ bundleVersion: manifestFixture.valid.bundle_version });
    // A shell that says nothing but "something is staged" is still a valid signal.
    notify(undefined);
    expect(seen).toEqual([{ bundleVersion: manifestFixture.valid.bundle_version }, {}]);

    stop();
    expect(globals.dddShellUpdateReady).toBeUndefined();
  });

  it("listens for exactly the event the shell dispatches", () => {
    // `window_shell.json` holds the strings; `app/test/bridge/fixtures_test.dart` asserts
    // the Dart side against the same entry. Without that pairing this module's listeners
    // and the shell's `evaluateJavascript` can disagree forever while both suites pass —
    // which is precisely what happened between M5 landing and this fixture existing.
    expect(SHELL_UPDATE_EVENT).toBe(windowShell.updateReady.event);
    expect(windowShell.updateReady.functionSpelling).toBe("dddShellUpdateReady");
    expect(windowShell.updateReady.script).toContain(JSON.stringify(SHELL_UPDATE_EVENT));
    expect(windowShell.updateReady.script).toContain(windowShell.updateReady.detailKey);
    expect(windowShell.updateReady.script).toContain(
      JSON.stringify(windowShell.updateReady.scriptVersion),
    );
  });

  it("turns the shell's own dispatch into a notice", () => {
    // The fixture's `script` is the literal source the Dart shell evaluates in the page;
    // running it here is the closest a host test gets to the device path.
    const bus = new EventTarget();
    globals.addEventListener = bus.addEventListener.bind(bus);
    globals.removeEventListener = bus.removeEventListener.bind(bus);
    const scope = globals as { window?: unknown };
    scope.window = { dispatchEvent: bus.dispatchEvent.bind(bus) };
    try {
      injectShell();
      const seen: unknown[] = [];
      const stop = onShellUpdateReady((info) => seen.push(info));
      // eslint-disable-next-line no-new-func -- the fixture is a committed constant.
      new Function("window", windowShell.updateReady.script)(scope.window);
      expect(seen).toEqual([{ bundleVersion: windowShell.updateReady.scriptVersion }]);
      stop();
    } finally {
      delete globals.addEventListener;
      delete globals.removeEventListener;
      delete scope.window;
    }
  });

  it("hears the event spelling where there is an event target", () => {
    // Node has no global `addEventListener`; a webview does. Both spellings land on the
    // same notice, and the module must not throw in either environment.
    const bus = new EventTarget();
    globals.addEventListener = bus.addEventListener.bind(bus);
    globals.removeEventListener = bus.removeEventListener.bind(bus);
    try {
      injectShell();
      const seen: unknown[] = [];
      const stop = onShellUpdateReady((info) => seen.push(info));
      bus.dispatchEvent(new CustomEvent(SHELL_UPDATE_EVENT, { detail: { bundleVersion: "b1f3" } }));
      expect(seen).toEqual([{ bundleVersion: "b1f3" }]);

      stop();
      bus.dispatchEvent(new CustomEvent(SHELL_UPDATE_EVENT, { detail: { bundleVersion: "b2" } }));
      expect(seen).toHaveLength(1);
    } finally {
      delete globals.addEventListener;
      delete globals.removeEventListener;
    }
  });
});

describe("GET /api/shell/manifest, as the page reads it", () => {
  it("reads the two fields the web side depends on", () => {
    const read = readShellManifest(manifestFixture.valid);
    expect(read.bundleVersion).toBe(manifestFixture.valid.bundle_version);
    expect(read.minBridgeVersion).toBe(manifestFixture.valid.min_bridge_version);
    expect(read.minBridgeVersion).toBe(index.bridgeVersion);
  });

  it("reads every malformed manifest as 'unknown' rather than throwing", () => {
    for (const invalid of manifestFixture.invalid) {
      const manifest = invalid.manifest as Record<string, unknown>;
      const read = readShellManifest(manifest);
      // Narrowing, not validating: whether the *file list* is usable is the Dart
      // updater's question (it is the only party that downloads bytes). What must hold
      // here is that a field the page reads is present exactly when the JSON has it.
      expect(`${invalid.name}: ${String(read.bundleVersion)}`).toBe(
        `${invalid.name}: ${String(
          typeof manifest["bundle_version"] === "string" && manifest["bundle_version"].length > 0
            ? manifest["bundle_version"]
            : undefined,
        )}`,
      );
      expect(`${invalid.name}: ${String(read.minBridgeVersion)}`).toBe(
        `${invalid.name}: ${String(
          Number.isInteger(manifest["min_bridge_version"])
            ? (manifest["min_bridge_version"] as number)
            : undefined,
        )}`,
      );
    }
  });

  it("treats anything that is not an object as an empty manifest", () => {
    for (const value of [undefined, null, "b1f3", 7, []]) {
      expect(readShellManifest(value)).toEqual({
        bundleVersion: undefined,
        minBridgeVersion: undefined,
      });
    }
  });
});
