/**
 * `kernel.ports` (PLUGIN-PROTOCOLS §5): since `@kernel` 2.0 the only way plugins reach
 * each other.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ContractViolationError,
  type PluginManifest,
  type ProtocolPackage,
  type Resolution,
} from "@kernel";

import { PortsHost } from "./ports.js";

const protocols: ProtocolPackage[] = [
  {
    id: "lm/router",
    version: "1.0.0",
    kind: "service",
    owner: "router",
    shape: { object: { navigate: "func", current: "func", url: "func" } },
  },
  {
    id: "lm/sidebar.panel",
    version: "1.0.0",
    kind: "slot",
    owner: "shell-ui",
    key: "id",
    shape: { object: { id: "string", title: "string" } },
  },
  {
    id: "acme/outline.panel",
    version: "1.0.0",
    kind: "slot",
    owner: "acme",
    shape: { object: { id: "string", title: "string", depth: "number" } },
  },
  {
    id: "lm/folders.default-location",
    version: "1.0.0",
    kind: "event",
    owner: "folders",
    sticky: true,
    shape: { object: { path: "string" } },
  },
];

const manifest = (id: string, ports: Pick<PluginManifest, "provides" | "consumes"> = {}): PluginManifest => ({
  id,
  version: "1.0.0",
  kernel: "^2.0",
  frontend: { module: "frontend/index.mjs" },
  ...ports,
});

function resolution(parts: Partial<Resolution>): Resolution {
  return {
    order: [],
    skipped: [],
    wires: [],
    bindings: {},
    seats: {},
    bench: {},
    listeners: {},
    activation: [],
    diagnostics: [],
    status: {},
    ...parts,
  };
}

function setup(manifests: PluginManifest[], parts: Partial<Resolution>) {
  const reports: string[] = [];
  const ports = new PortsHost((report) => reports.push(`${report.pluginId}: ${report.message}`));
  ports.configure({ protocols, manifests, resolution: resolution(parts) });
  const kernel = (id: string) => ({ ports: ports.forPlugin(manifests.find((entry) => entry.id === id)!) });
  return { ports, kernel, reports };
}

const routerApi = () => ({ navigate: vi.fn(), current: () => "/", url: (path: string) => `#${path}`, secret: 1 });

describe("services", () => {
  const manifests = [
    manifest("router", { provides: { router: { protocol: "lm/router@1.0.0" } } }),
    manifest("graph", { consumes: { router: { protocol: "lm/router@^1.0", needs: ["navigate", "current"] } } }),
    manifest("themes", { consumes: { settings: { protocol: "lm/router@^1.0", optional: true } } }),
  ];

  it("use() returns what the wiring bound, limited to the port's needs", () => {
    const { kernel } = setup(manifests, { bindings: { "graph:router": "router:router" } });
    const api = routerApi();
    kernel("router").ports.serve("router", api);
    const router = kernel("graph").ports.use<ReturnType<typeof routerApi>>("router");

    router.navigate("/doc/1");
    expect(api.navigate).toHaveBeenCalledWith("/doc/1");
    expect(router.current()).toBe("/");
    // `url` is in the protocol but not in this port's needs; `secret` is not even in the protocol.
    expect(() => router.url("/x")).toThrow(ContractViolationError);
    expect(() => router.secret).toThrow(/not in that port's needs/);
    // Awaiting or logging a handle is not reading a member.
    expect((router as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("an optional port with nothing bound is undefined; an undeclared port throws", () => {
    const { kernel } = setup(manifests, {});
    expect(kernel("themes").ports.use("settings")).toBeUndefined();
    expect(kernel("themes").ports.bound("settings")).toBe(false);
    expect(() => kernel("themes").ports.use("nope")).toThrow(/no consumed port "nope"/);
  });

  it("a served API is checked against the whole protocol, at the provider", () => {
    const { kernel } = setup(manifests, {});
    expect(() => kernel("router").ports.serve("router", { navigate: () => undefined })).toThrow(
      /does not match lm\/router@1.0.0: current: expected function/,
    );
  });
});

describe("slots", () => {
  const manifests = [
    manifest("shell-ui", { consumes: { sidebar: { protocol: "lm/sidebar.panel@^1.0" } } }),
    manifest("folders", { provides: { tree: { protocol: "lm/sidebar.panel@1.0.0", order: 20 } } }),
    manifest("doc-list", { provides: { list: { protocol: "lm/sidebar.panel@1.0.0", order: 10 } } }),
    manifest("acme", { provides: { outline: { protocol: "acme/outline.panel@1.0.0" } } }),
  ];
  const seats = { "shell-ui:sidebar": ["folders:tree", "acme:outline", "doc-list:list"] };
  const wires: Resolution["wires"] = [
    { from: "acme:outline", to: "shell-ui:sidebar", kind: "slot", protocol: "lm/sidebar.panel", offerProtocol: "acme/outline.panel", byShape: true, seat: 2 },
  ];

  it("a host collects in seat order, and one provider's items stay together in offer order", () => {
    const { kernel } = setup(manifests, { seats, wires });
    kernel("doc-list").ports.offer("list", { id: "list", title: "Documents" });
    kernel("folders").ports.offer("tree", [
      { id: "tree", title: "Folders" },
      { id: "tree-2", title: "More folders" },
    ]);
    kernel("acme").ports.offer("outline", { id: "outline", title: "Outline", depth: 3 });
    const host = kernel("shell-ui").ports.collect<{ id: string }>("sidebar");
    expect(host.get().map((item) => item.id)).toEqual(["tree", "tree-2", "outline", "list"]);
    expect(host.entries()[2]).toMatchObject({ pluginId: "acme", port: "outline" });
  });

  it("is live: offers, withdrawals and a new resolution reach subscribers", () => {
    const { ports, kernel } = setup(manifests, { seats });
    const seen = vi.fn();
    kernel("shell-ui").ports.collect<{ id: string }>("sidebar").subscribe((items) => seen(items.map((i) => i.id)));
    const offered = kernel("doc-list").ports.offer("list", { id: "list", title: "Documents" });
    kernel("folders").ports.offer("tree", { id: "tree", title: "Folders" });
    expect(seen).toHaveBeenLastCalledWith(["tree", "list"]);
    ports.setResolution(resolution({ seats: { "shell-ui:sidebar": ["doc-list:list", "folders:tree"] } }));
    expect(seen).toHaveBeenLastCalledWith(["list", "tree"]);
    offered.dispose();
    expect(seen).toHaveBeenLastCalledWith(["tree"]);
  });

  it("an offer that does not match its protocol throws at the provider", () => {
    const { kernel } = setup(manifests, { seats });
    expect(() => kernel("doc-list").ports.offer("list", { id: 1 })).toThrow(ContractViolationError);
  });

  it("the lower seat wins a duplicate key, and the other is reported once", () => {
    const { kernel, reports } = setup(manifests, { seats });
    kernel("folders").ports.offer("tree", { id: "same", title: "Folders" });
    kernel("doc-list").ports.offer("list", { id: "same", title: "Documents" });
    const host = kernel("shell-ui").ports.collect<{ title: string }>("sidebar");
    expect(host.get().map((item) => item.title)).toEqual(["Folders"]);
    host.get();
    expect(reports).toEqual(["doc-list: Two plugins claim “same”. folders is being used."]);
  });
});

describe("events", () => {
  const manifests = [
    manifest("folders", { provides: { location: { protocol: "lm/folders.default-location@1.0.0" } } }),
    manifest("doc-list", { consumes: { location: { protocol: "lm/folders.default-location@^1.0" } } }),
  ];
  const listeners = { "doc-list:location": ["folders:location"] };

  it("reaches wired listeners, and a sticky protocol hands a late listener the last value", () => {
    const { kernel } = setup(manifests, { listeners });
    const early = vi.fn();
    kernel("doc-list").ports.on("location", early);
    kernel("folders").ports.emit("location", { path: "inbox" });
    expect(early).toHaveBeenCalledWith({ path: "inbox" }, "folders");

    // A restarted doc-list still learns where new notes go (doc-list/index.tsx's old gap).
    const late = vi.fn();
    kernel("doc-list").ports.on("location", late);
    expect(late).toHaveBeenCalledWith({ path: "inbox" }, "folders");
  });
});

describe("the kernel's own items and withdrawal", () => {
  const manifests = [
    manifest("shell-ui", { consumes: { sidebar: { protocol: "lm/sidebar.panel@^1.0" } } }),
    manifest("folders", { provides: { tree: { protocol: "lm/sidebar.panel@1.0.0", order: 20 } } }),
    manifest("router", { provides: { router: { protocol: "lm/router@1.0.0" } } }),
    manifest("graph", { consumes: { router: { protocol: "lm/router@^1.0", needs: ["navigate"] } } }),
  ];
  const parts: Partial<Resolution> = {
    seats: { "shell-ui:sidebar": ["folders:tree"] },
    bindings: { "graph:router": "router:router" },
  };

  it("a kernel item follows every host's wired seats, and is checked against the protocol", () => {
    const { ports, kernel } = setup(manifests, parts);
    ports.offerAsKernel("lm/sidebar.panel", { id: "device", title: "This device" });
    kernel("folders").ports.offer("tree", { id: "tree", title: "Folders" });
    const host = kernel("shell-ui").ports.collect<{ id: string }>("sidebar");
    expect(host.get().map((i) => i.id)).toEqual(["tree", "device"]);
    expect(host.entries()[1]).toMatchObject({ pluginId: "kernel" });
    expect(() => ports.offerAsKernel("lm/sidebar.panel", { id: 1 })).toThrow(ContractViolationError);
  });

  it("an item offered on no declared port throws: there is no implicit port any more", () => {
    const { kernel } = setup(manifests, parts);
    expect(() => kernel("graph").ports.offer("sidebar", { id: "x", title: "X" })).toThrow(/no provided port "sidebar"/);
  });

  it("removing a plugin withdraws its items, its services and its listeners", () => {
    const { ports, kernel } = setup(manifests, parts);
    kernel("folders").ports.offer("tree", { id: "tree", title: "Folders" });
    kernel("router").ports.serve("router", routerApi());
    const seen = vi.fn();
    kernel("shell-ui").ports.collect("sidebar").subscribe(seen);
    ports.removePlugin("folders");
    expect(seen).toHaveBeenLastCalledWith([]);
    ports.removePlugin("router");
    expect(() => kernel("graph").ports.use("router")).toThrow(/serves nothing/);
    ports.removePlugin("shell-ui");
    expect(ports.stats()).toEqual({ offers: 0, served: 0, hostListeners: 0, eventListeners: 0 });
  });
});
