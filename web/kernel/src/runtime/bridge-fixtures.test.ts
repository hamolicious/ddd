/**
 * **Contract parity against `app/bridge_fixtures/`** — the half of the M5 bridge contract
 * that this repository can actually check.
 *
 * `capabilities.test.ts` proves the shim's *rules* (degrade per method, never after an
 * error). This suite proves the shim's *bytes*: that what `kernel.capabilities` puts on
 * the wire is, key for key, the envelope `app/BRIDGE.md` froze and the Dart side is
 * written against. The two halves compile separately and never see each other, so without
 * a shared artefact "we agree on the envelope" is a claim. Here it is a test — and the
 * same JSON is meant to fail a Dart test the moment either side renames a field.
 *
 * Nothing here asserts anything about how the *shell* behaves; that is `app/test/`'s job
 * against the same files. What this suite owns is the web side of every boundary:
 * detection, the outgoing params, the incoming result, and the frozen name lists.
 */

import { afterEach, describe, expect, it } from "vitest";

import { SUPPORTED_BRIDGE_VERSION } from "@kernel";

import {
  fixtureCase,
  fixtureIndex,
  fixtureParams,
  fixtureRequest,
  readFixture,
  type BridgeFixtureCase,
  type BridgeFixtureFile,
  type ManifestFixture,
  type WindowShellFixture,
} from "./bridge-fixtures.js";
import { CapabilitiesHost, detectBridge } from "./capabilities.js";
import { BRIDGE_VERSION, bridgeVersionOf, readShellBridge, shellServerBaseUrl, shellUrl } from "./shell-bridge.js";

const index = fixtureIndex();
const auth = readFixture<BridgeFixtureFile>("auth.json");
const boot = readFixture<BridgeFixtureFile>("boot.json");
const filesystem = readFixture<BridgeFixtureFile>("filesystem.json");
const notifications = readFixture<BridgeFixtureFile>("notifications.json");
const envelope = readFixture<BridgeFixtureFile>("envelope.json");
const windowShell = readFixture<WindowShellFixture>("window_shell.json");
const manifest = readFixture<ManifestFixture>("manifest.json");

const capabilityFiles: readonly (readonly [string, BridgeFixtureFile])[] = [
  ["auth.json", auth],
  ["boot.json", boot],
  ["filesystem.json", filesystem],
  ["notifications.json", notifications],
];

const globals = globalThis as { shell?: unknown };
afterEach(() => {
  delete globals.shell;
});

describe("the fixture set", () => {
  it("names every case file it ships, so no side can quietly stop reading one", () => {
    expect([...index.cases].sort()).toEqual(
      ["auth.json", "boot.json", "envelope.json", "filesystem.json", "notifications.json"].sort(),
    );
    expect([...index.other].sort()).toEqual(["manifest.json", "window_shell.json"].sort());
    for (const file of [...index.cases, ...index.other]) {
      expect(() => readFixture(file)).not.toThrow();
    }
  });

  it("agrees with the bundle about which bridge major this is", () => {
    // Three constants, one number. `BRIDGE_VERSION` is what the bundle *speaks*,
    // `SUPPORTED_BRIDGE_VERSION` is the ceiling `detectBridge` enforces, and the fixture
    // is what the Dart side is written against (`kBridgeVersion`).
    expect(BRIDGE_VERSION).toBe(index.bridgeVersion);
    expect(SUPPORTED_BRIDGE_VERSION).toBe(index.bridgeVersion);
    expect(index.handler).toBe("lm_shell_v1");
  });

  it("freezes the six error codes and the envelope keys (BRIDGE.md §9)", () => {
    expect(index.errorCodes).toEqual([
      "unsupported",
      "denied",
      "cancelled",
      "invalid",
      "timeout",
      "failed",
    ]);
    expect(index.envelopeKeys.request).toEqual(["v", "id", "capability", "method", "params"]);
    expect(index.envelopeKeys.response).toEqual(["v", "id", "ok", "result", "error"]);
    expect(index.envelopeKeys.error).toEqual(["code", "message"]);
  });
});

describe("every envelope in every case file", () => {
  const allCases: readonly (readonly [string, BridgeFixtureCase])[] = [
    ...capabilityFiles,
    ["envelope.json", envelope],
  ].flatMap(([file, contents]) =>
    (contents as BridgeFixtureFile).cases.map(
      (entry) => [`${file as string} — ${entry.name}`, entry] as const,
    ),
  );

  it.each(allCases)("%s", (_label, entry) => {
    if (!entry.malformed) {
      const request = fixtureRequest(entry);
      expect(Object.keys(request).every((key) => index.envelopeKeys.request.includes(key))).toBe(
        true,
      );
      expect(Number.isInteger(request.v)).toBe(true);
      expect(typeof request.id).toBe("string");
      expect(typeof request.capability).toBe("string");
      expect(typeof request.method).toBe("string");
      // `params` is always an object when present, and an absent one means `{}` —
      // never a scalar, never an array (`BRIDGE.md` §2).
      const params = request.params;
      if (params !== undefined) {
        expect(typeof params).toBe("object");
        expect(Array.isArray(params)).toBe(false);
      }
    }

    const response = entry.response;
    expect(Object.keys(response).every((key) => index.envelopeKeys.response.includes(key))).toBe(
      true,
    );
    expect(response.v).toBe(index.bridgeVersion);
    expect(typeof response.id).toBe("string");
    expect(typeof response.ok).toBe("boolean");
    if (response.ok) {
      // `result` is present even when it is `null`: a handler that answers must answer.
      expect(Object.keys(response)).toContain("result");
      expect(response.error).toBeUndefined();
    } else {
      expect(Object.keys(response)).not.toContain("result");
      expect(response.error).toBeDefined();
      expect(index.errorCodes).toContain(response.error?.code);
      expect((response.error?.message ?? "").length).toBeGreaterThan(0);
      expect(Object.keys(response.error ?? {})).toEqual(index.envelopeKeys.error);
    }
  });

  it("only uses methods the shell actually registers", () => {
    for (const [file, contents] of capabilityFiles) {
      for (const entry of contents.cases) {
        expect(`${file}:${contents.capability}.${entry.method}`).toBe(
          `${file}:${fixtureRequest(entry).capability as string}.${fixtureRequest(entry).method as string}`,
        );
        expect(index.methods).toContain(`${contents.capability}.${entry.method}`);
      }
      expect(index.capabilities).toContain(contents.capability);
    }
  });

  it("keeps instants and bytes in the two spellings the boundary allows", () => {
    // ISO-8601 in, epoch ms out, and the shim is the only thing that converts. A
    // fixture whose two spellings disagreed would hide a real off-by-a-timezone.
    for (const entry of notifications.cases) {
      const atIso = fixtureParams(entry)["atIso"];
      if (typeof atIso === "string" && entry.atMs !== undefined) {
        expect(Date.parse(atIso)).toBe(entry.atMs);
        expect(new Date(entry.atMs).toISOString()).toBe(atIso);
      }
      for (const scheduled of Array.isArray(entry.response.result) ? entry.response.result : []) {
        const row = scheduled as { atIso?: unknown; at?: unknown };
        expect(typeof row.atIso).toBe("string");
        expect(Date.parse(row.atIso as string)).toBe(row.at);
      }
    }
    // Bytes are base64 and never a `Uint8Array` (`BRIDGE.md` §2, rule 1).
    const bytes = fixtureCase(filesystem, "export bytes as base64").bytes;
    expect(bytes).toBeDefined();
    expect(btoa(bytes?.utf8 ?? "")).toBe(bytes?.base64);
  });
});

describe("what the shim sends", () => {
  it("exports text as exactly the frozen params", async () => {
    const entry = fixtureCase(filesystem, "export text");
    const sent: unknown[] = [];
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: { export: (file: unknown) => void sent.push(file) },
    });
    const params = fixtureParams(entry);
    await host.filesystem.export({
      name: params["name"] as string,
      mime: params["mime"] as string,
      text: params["text"] as string,
    });
    expect(sent).toEqual([params]);
  });

  it("exports bytes as the frozen base64, not as an array", async () => {
    const entry = fixtureCase(filesystem, "export bytes as base64");
    const sent: unknown[] = [];
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: { export: (file: unknown) => void sent.push(file) },
    });
    const params = fixtureParams(entry);
    await host.filesystem.export({
      name: params["name"] as string,
      mime: params["mime"] as string,
      bytes: new TextEncoder().encode(entry.bytes?.utf8 ?? ""),
    });
    expect(sent).toEqual([params]);
  });

  it("asks for a picker with the frozen options and `multiple` always present", async () => {
    const entry = fixtureCase(filesystem, "pick one file");
    const seen: unknown[] = [];
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: {
        pick: (options: unknown) => {
          seen.push(options);
          return Promise.resolve(entry.response.result);
        },
      },
    });
    const params = fixtureParams(entry);
    const files = await host.filesystem.pick({
      accept: params["accept"] as string[],
      multiple: params["multiple"] as boolean,
    });
    expect(seen).toEqual([params]);
    // The picked file arrives whole, because a native picker's file has no `File`
    // object in this realm to re-read later (`BRIDGE.md` §4.2).
    expect(files.map((file) => ({ name: file.name, mime: file.mime, size: file.size }))).toEqual(
      (entry.response.result as { name: string; mime: string; size: number }[]).map((row) => ({
        name: row.name,
        mime: row.mime,
        size: row.size,
      })),
    );
    expect(await files[0]?.text()).toBe("hi");
  });

  it("converts the kernel's epoch ms into the instant the bridge takes", async () => {
    const entry = fixtureCase(notifications, "schedule a reminder");
    const params = fixtureParams(entry);
    const seen: [unknown, number][] = [];
    const host = new CapabilitiesHost({
      version: 1,
      notifications: {
        schedule: (notification: unknown, at: number) => {
          seen.push([notification, at]);
          return Promise.resolve(entry.response.result);
        },
        cancel: () => Promise.resolve(),
      },
    });
    const id = await host.notifications.schedule(
      {
        title: params["title"] as string,
        tag: params["tag"] as string,
        route: params["route"] as string,
      },
      entry.atMs ?? 0,
    );
    expect(id).toBe(entry.response.result);
    // The kernel API is epoch ms; `atIso` is the shell's spelling and the *shell*
    // converts (`BRIDGE.md` §4.3). What must match is the instant.
    expect(seen[0]?.[1]).toBe(Date.parse(params["atIso"] as string));
  });
});

describe("what the shim reads back", () => {
  it("accepts a pending list in either instant spelling", async () => {
    const entry = fixtureCase(notifications, "list what is pending");
    const rows = entry.response.result as { id: string; atIso: string; at: number }[];
    const host = new CapabilitiesHost({
      version: 1,
      notifications: {
        schedule: () => Promise.resolve("x"),
        cancel: () => Promise.resolve(),
        // `list` is the `BRIDGE.md` spelling; `scheduled` is the frozen kernel one, and
        // the shim accepts either (they are the same handler).
        list: () => Promise.resolve(rows),
      },
    });
    expect(await host.notifications.scheduled()).toEqual(
      rows.map((row) => ({ id: row.id, at: row.at })),
    );

    // A shell that sent only the canonical `atIso` is understood rather than dropped:
    // dropping it would read to a user as "my reminders vanished".
    const isoOnly = new CapabilitiesHost({
      version: 1,
      notifications: {
        schedule: () => Promise.resolve("x"),
        cancel: () => Promise.resolve(),
        scheduled: () => Promise.resolve(rows.map(({ at: _at, ...rest }) => rest)),
      },
    });
    expect(await isoOnly.notifications.scheduled()).toEqual(
      rows.map((row) => ({ id: row.id, at: row.at })),
    );
  });

  it("reads the baked-in permission synchronously", () => {
    const entry = fixtureCase(notifications, "permission, baked in");
    const host = new CapabilitiesHost({
      version: 1,
      notifications: { notify: () => undefined, permission: () => entry.response.result },
    });
    expect(host.notifications.permission()).toBe(entry.response.result);
  });

  it("treats every fixture error as a real failure and never retries in the browser", async () => {
    // Rule 3 of `BRIDGE.md` §3, read off the fixtures: a defined method that fails is a
    // failure. Falling back here would open a second save dialog or fire a second
    // notification. The browser fallback in this environment rejects with
    // /unavailable/, so a leaked fallback would change the message.
    const cancelled = fixtureCase(filesystem, "export cancelled at the share sheet");
    const cancelHost = new CapabilitiesHost({
      version: 1,
      filesystem: { export: () => Promise.reject(new Error(cancelled.response.error?.message)) },
    });
    await expect(
      cancelHost.filesystem.export({ name: "notes.md", mime: "text/markdown", text: "# hi\n" }),
    ).rejects.toThrow(cancelled.response.error?.message ?? "");

    const denied = fixtureCase(filesystem, "export the workspace as a non-admin");
    const deniedHost = new CapabilitiesHost({
      version: 1,
      filesystem: {
        export: () => Promise.resolve(),
        exportWorkspace: () => Promise.reject(new Error(denied.response.error?.message)),
      },
    });
    expect(deniedHost.filesystem.exportWorkspace).toBeDefined();
    await expect(deniedHost.filesystem.exportWorkspace?.()).rejects.toThrow(
      denied.response.error?.message ?? "",
    );
  });

  it("hands a dismissed picker an empty list rather than an error", async () => {
    const entry = fixtureCase(filesystem, "pick, dismissed");
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: { pick: () => Promise.resolve(entry.response.result) },
    });
    await expect(host.filesystem.pick({ multiple: true })).resolves.toEqual([]);
  });
});

describe("the detection rule (BRIDGE.md §3)", () => {
  it.each(windowShell.detection.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      if (entry.absent) delete globals.shell;
      else globals.shell = entry.shell;

      expect(detectBridge() !== undefined).toBe(entry.detected);
      if (entry.bridgeVersion !== undefined) {
        expect(bridgeVersionOf(readShellBridge())).toBe(entry.bridgeVersion);
      }
      if (entry.serverBaseUrl !== undefined) {
        const resolved = shellServerBaseUrl(readShellBridge());
        expect(resolved).toBe(entry.serverBaseUrl ?? undefined);
        // The one thing every caller does with it: prefix a rooted path. A base that
        // was ignored has to leave the path alone so a browser keeps working.
        expect(shellUrl("/api/admin/export", readShellBridge())).toBe(
          `${entry.serverBaseUrl ?? ""}/api/admin/export`,
        );
      }
    },
  );
});

describe("the injected surface", () => {
  it("advertises exactly the registered method set", () => {
    expect(windowShell.injected.methods).toEqual(index.methods);
    expect(windowShell.injected.capabilities).toEqual(index.capabilities);
    expect(windowShell.injected.version).toBe(index.bridgeVersion);
    // Both spellings, equal — `version` is what the committed kernel reads and
    // `bridgeVersion` is the name `BRIDGE.md` uses (§3).
    expect(windowShell.injected.bridgeVersion).toBe(windowShell.injected.version);
  });

  it("defines a JavaScript member for every registered method, and nothing else", () => {
    const functions = new Set(windowShell.injected.functions);
    const aliases = Object.entries(index.jsAliases);

    // Every registered method is reachable from JavaScript under *some* declared
    // spelling. Three of them are flat (`bootOk`, `bootFailed`, `setBearerToken`),
    // because the boot sequence reads them before a capability object means anything,
    // and `notifications.scheduled` is the frozen kernel name for `notifications.list`.
    for (const method of index.methods) {
      const spellings = [method, ...aliases.filter(([, to]) => to === method).map(([from]) => from)];
      expect(`${method} → ${spellings.some((name) => functions.has(name))}`).toBe(`${method} → true`);
    }

    // And nothing is injected that no method answers: an extra member is either a
    // capability nobody registered or a spelling the Dart side forgot to alias.
    for (const member of functions) {
      const known = index.methods.includes(member) || member in index.jsAliases;
      expect(`${member} → ${known}`).toBe(`${member} → true`);
    }

    for (const [, target] of aliases) expect(index.methods).toContain(target);
    // `boot` is the one capability with no nested spelling at all (`BRIDGE.md` §3).
    expect(functions.has("boot.ok")).toBe(false);
    expect(functions.has("bootOk")).toBe(true);
  });

  it("serves both plugin-facing capabilities natively, and exposes neither auth nor boot", () => {
    const host = new CapabilitiesHost(buildInjectedBridge());
    expect(index.pluginFacing).toEqual(["filesystem", "notifications"]);
    for (const name of index.pluginFacing) {
      expect(host.support(name as "filesystem" | "notifications")).toBe("native");
      expect(host.has(name as "filesystem" | "notifications")).toBe(true);
    }
    expect(host.notifications.supportsScheduled).toBe(true);
    expect(host.filesystem.exportWorkspace).toBeDefined();
    // `auth` is app-boot plumbing and deliberately not a feature a plugin can reach
    // (`BRIDGE.md` §4.1); `boot` is the shell talking to itself.
    for (const name of index.capabilities.filter((c) => !index.pluginFacing.includes(c))) {
      expect(name === "auth" || name === "boot").toBe(true);
      expect((host as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

/** A `window.shell` with a stub for every function the fixture says is injected. */
function buildInjectedBridge(): Record<string, unknown> {
  const bridge: Record<string, unknown> = {
    version: windowShell.injected.version,
    bridgeVersion: windowShell.injected.bridgeVersion,
    platform: windowShell.injected.platform,
    serverBaseUrl: windowShell.injected.serverBaseUrl,
    bearerToken: windowShell.injected.bearerToken,
    capabilities: windowShell.injected.capabilities,
    methods: windowShell.injected.methods,
  };
  for (const member of windowShell.injected.functions) {
    const [head, tail] = member.split(".");
    if (head === undefined) continue;
    if (tail === undefined) {
      bridge[head] = () => undefined;
      continue;
    }
    const group = (bridge[head] ??= {}) as Record<string, unknown>;
    group[tail] = () => undefined;
  }
  return bridge;
}

describe("the manifest (BRIDGE.md §5)", () => {
  it("has exactly the frozen field names", () => {
    expect(Object.keys(manifest.valid)).toEqual([
      "bundle_version",
      "min_bridge_version",
      "index_csp",
      "files",
    ]);
    for (const file of manifest.valid.files) {
      expect(Object.keys(file)).toEqual(["path", "sha256", "size"]);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(file.size)).toBe(true);
      expect(file.size).toBeGreaterThanOrEqual(0);
    }
    expect(manifest.valid.min_bridge_version).toBe(index.bridgeVersion);
  });

  it("lists the synthesized files and excludes the service worker", () => {
    const paths = manifest.valid.files.map((file) => file.path);
    // The two rendered-per-bundle files are part of the bundle and come from
    // `/api/shell/bundle/{path}`; everything else is a plain static route.
    for (const synthesized of manifest.synthesized) expect(paths).toContain(synthesized);
    // `sw.js` is excluded on purpose: the loopback origin already *is* the offline
    // cache, and a worker there would fight the updater for what the webview sees.
    expect(manifest.excluded).toContain("sw.js");
    for (const excluded of manifest.excluded) expect(paths).not.toContain(excluded);
    // A bundle with no `index.html` is a bundle that cannot boot.
    expect(paths).toContain("index.html");
  });

  it("agrees with the CSP the shell will send for index.html", () => {
    // The nonce in `index_csp` has to match the inline import map in the rendered
    // `index.html` (`BRIDGE.md` §5), and the policy is SPEC §8's with `wasm-unsafe-eval`
    // added — the shared core is Wasm.
    expect(manifest.valid.index_csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/_-]+'/);
    expect(manifest.valid.index_csp).toContain("'wasm-unsafe-eval'");
    expect(manifest.valid.index_csp).toContain("object-src 'none'");
    expect(manifest.valid.index_csp).toContain("frame-ancestors 'none'");
  });

  it("marks a path unsafe whenever it could escape the bundle directory", () => {
    // The web side never writes these paths — the Dart store does — but the rule is
    // shared data, so a disagreement about what "unsafe" means shows up here too.
    for (const path of manifest.unsafePaths) {
      const unsafe =
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("//") ||
        path.split("/").some((segment) => segment === "." || segment === "..");
      expect(`${path} → unsafe`).toBe(`${path} → ${unsafe ? "unsafe" : "safe"}`);
    }
  });
});
