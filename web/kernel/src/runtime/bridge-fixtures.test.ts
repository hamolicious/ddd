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
import {
  BRIDGE_VERSION,
  FOLDER_CHANGED_EVENT,
  bridgeOwnsSession,
  bridgeVersionOf,
  readShellBridge,
  shellServerBaseUrl,
  shellUrl,
} from "./shell-bridge.js";

const index = fixtureIndex();
const auth = readFixture<BridgeFixtureFile>("auth.json");
const boot = readFixture<BridgeFixtureFile>("boot.json");
const filesystem = readFixture<BridgeFixtureFile>("filesystem.json");
const folder = readFixture<BridgeFixtureFile>("folder.json");
const notifications = readFixture<BridgeFixtureFile>("notifications.json");
const envelope = readFixture<BridgeFixtureFile>("envelope.json");
const windowShell = readFixture<WindowShellFixture>("window_shell.json");
const manifest = readFixture<ManifestFixture>("manifest.json");

const capabilityFiles: readonly (readonly [string, BridgeFixtureFile])[] = [
  ["auth.json", auth],
  ["boot.json", boot],
  ["filesystem.json", filesystem],
  ["folder.json", folder],
  ["notifications.json", notifications],
];

const globals = globalThis as { shell?: unknown };
afterEach(() => {
  delete globals.shell;
});

describe("the fixture set", () => {
  it("names every case file it ships, so no side can quietly stop reading one", () => {
    expect([...index.cases].sort()).toEqual(
      [
        "auth.json",
        "boot.json",
        "envelope.json",
        "filesystem.json",
        "folder.json",
        "notifications.json",
      ].sort(),
    );
    expect([...index.other].sort()).toEqual(["manifest.json", "window_shell.json"].sort());
    for (const file of [...index.cases, ...index.other]) {
      expect(() => readFixture(file)).not.toThrow();
    }
  });

  it("agrees with the bundle about which bridge major this is", () => {
    expect(BRIDGE_VERSION).toBe(index.bridgeVersion);
    expect(SUPPORTED_BRIDGE_VERSION).toBe(index.bridgeVersion);
    expect(index.handler).toBe("ddd_shell_v1");
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
        list: () => Promise.resolve(rows),
      },
    });
    expect(await host.notifications.scheduled()).toEqual(
      rows.map((row) => ({ id: row.id, at: row.at })),
    );

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

describe("what the folder shim sends and reads back", () => {
  const response = (name: string): unknown => {
    const entry = folder.cases.find((c) => c.name === name);
    if (!entry?.response.ok) throw new Error(`no successful case ${name}`);
    return entry.response.result;
  };

  it("writes bytes as the frozen base64 params and reads them back", async () => {
    const sent: unknown[] = [];
    const read = folder.cases.find((c) => c.name === "read a file as base64")!;
    const bridge = buildInjectedBridge();
    Object.assign(bridge["folder"] as Record<string, unknown>, {
      write: (params: unknown) => {
        sent.push(params);
        return response("write a file, creating its directory");
      },
      read: () => response("read a file as base64"),
    });
    const host = new CapabilitiesHost(bridge);
    await host.folder.write("Work/Plans.md", new TextEncoder().encode("# Plans\n"));
    expect(sent).toEqual([fixtureParams(folder.cases.find((c) => c.name === "write a file, creating its directory")!)]);
    const file = await host.folder.read("Home/Home.md");
    expect(new TextDecoder().decode(file.bytes)).toBe(read.bytes?.utf8);
  });

  it("refuses a path that climbs out before the shell sees it", async () => {
    const host = new CapabilitiesHost(buildInjectedBridge());
    await expect(host.folder.read("../secrets.txt")).rejects.toMatchObject({ code: "invalid" });
  });

  it("hears the shell's change event under the fixture's name", () => {
    expect(FOLDER_CHANGED_EVENT).toBe(windowShell.folderChanged.event);
    expect(windowShell.folderChanged.detailKey).toBe("paths");
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
      if (entry.ownsSession !== undefined) {
        expect(bridgeOwnsSession(readShellBridge())).toBe(entry.ownsSession);
      }
      if (entry.serverBaseUrl !== undefined) {
        const resolved = shellServerBaseUrl(readShellBridge());
        expect(resolved).toBe(entry.serverBaseUrl ?? undefined);
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
    expect(windowShell.injected.bridgeVersion).toBe(windowShell.injected.version);
  });

  it("defines a JavaScript member for every registered method, and nothing else", () => {
    const functions = new Set(windowShell.injected.functions);
    const aliases = Object.entries(index.jsAliases);

    for (const method of index.methods) {
      const spellings = [method, ...aliases.filter(([, to]) => to === method).map(([from]) => from)];
      expect(`${method} → ${spellings.some((name) => functions.has(name))}`).toBe(`${method} → true`);
    }

    for (const member of functions) {
      const known = index.methods.includes(member) || member in index.jsAliases;
      expect(`${member} → ${known}`).toBe(`${member} → true`);
    }

    for (const [, target] of aliases) expect(index.methods).toContain(target);
    expect(functions.has("boot.ok")).toBe(false);
    expect(functions.has("bootOk")).toBe(true);
  });

  it("serves every plugin-facing capability natively, and exposes neither auth nor boot", () => {
    const host = new CapabilitiesHost(buildInjectedBridge());
    expect(index.pluginFacing).toEqual(["filesystem", "folder", "notifications"]);
    for (const name of index.pluginFacing) {
      expect(host.support(name as "filesystem" | "folder" | "notifications")).toBe("native");
      expect(host.has(name as "filesystem" | "folder" | "notifications")).toBe(true);
    }
    expect(host.notifications.supportsScheduled).toBe(true);
    expect(host.filesystem.exportWorkspace).toBeDefined();
    for (const name of index.capabilities.filter((c) => !index.pluginFacing.includes(c))) {
      expect(name === "auth" || name === "boot").toBe(true);
      expect((host as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

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
    for (const synthesized of manifest.synthesized) expect(paths).toContain(synthesized);
    expect(manifest.excluded).toContain("sw.js");
    for (const excluded of manifest.excluded) expect(paths).not.toContain(excluded);
    expect(paths).toContain("index.html");
  });

  it("agrees with the CSP the shell will send for index.html", () => {
    expect(manifest.valid.index_csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/_-]+'/);
    expect(manifest.valid.index_csp).toContain("'wasm-unsafe-eval'");
    expect(manifest.valid.index_csp).toContain("object-src 'none'");
    expect(manifest.valid.index_csp).toContain("frame-ancestors 'none'");
  });

  it("marks a path unsafe whenever it could escape the bundle directory", () => {
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
