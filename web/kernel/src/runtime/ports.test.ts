/**
 * `kernel.ports` (PLUGIN-PROTOCOLS §5) and the 1.x shims over it (§9 step 5).
 *
 * The step is done when a plugin on ports and a plugin still on `extensions`/`services`
 * wire to each other in one session, both ways round; the last group pins that.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ContractViolationError,
  type PluginManifest,
  type ProtocolPackage,
  type Resolution,
} from "@kernel";

import { PortsHost } from "./ports.js";
import { ExtensionRegistry } from "./registry.js";
import { ServiceRegistry } from "./services.js";

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

const manifest = (id: string, ports: Pick<PluginManifest, "provides" | "consumes" | "dependencies"> = {}): PluginManifest => ({
  id,
  version: "1.0.0",
  kernel: "^1.2",
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
  const extensions = new ExtensionRegistry(undefined, ports);
  const services = new ServiceRegistry(ports);
  ports.configure({ protocols, manifests, resolution: resolution(parts) });
  const kernel = (id: string) => {
    const m = manifests.find((entry) => entry.id === id)!;
    services.declare(id, Object.keys(m.dependencies ?? {}));
    return { ports: ports.forPlugin(m), extensions: extensions.forPlugin(id, m), services: services.forPlugin(id, m) };
  };
  return { ports, services, kernel, reports };
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

describe("a plugin on ports and a plugin on 1.x wire to each other (§9 step 5)", () => {
  const manifests = [
    // On ports: a host, a provider and a consumer.
    manifest("shell-ui", { consumes: { sidebar: { protocol: "lm/sidebar.panel@^1.0" } } }),
    manifest("folders", { provides: { tree: { protocol: "lm/sidebar.panel@1.0.0", order: 20 } } }),
    manifest("graph", { consumes: { router: { protocol: "lm/router@^1.0", needs: ["navigate"] } } }),
    manifest("router-next", { provides: { router: { protocol: "lm/router@1.0.0" } } }),
    // On 1.x: no ports at all.
    manifest("legacy-panel"),
    manifest("legacy-host"),
    manifest("router"),
    manifest("legacy-consumer", { dependencies: { "router-next": "^1.0" } }),
  ];
  const parts: Partial<Resolution> = {
    seats: { "shell-ui:sidebar": ["folders:tree"] },
    // The resolver gives a 1.x owner of a service protocol an implicit port.
    bindings: { "graph:router": "router:~router" },
  };

  it("a 1.x contribution reaches a host on ports, after its wired seats", () => {
    const { kernel } = setup(manifests, parts);
    kernel("folders").ports.offer("tree", { id: "tree", title: "Folders" });
    kernel("legacy-panel").extensions.contribute("sidebar.panel", { id: "legacy", title: "Legacy" });
    expect(kernel("shell-ui").ports.collect<{ id: string }>("sidebar").get().map((i) => i.id)).toEqual(["tree", "legacy"]);
  });

  it("an offer on a port reaches a 1.x host", () => {
    const { kernel } = setup(manifests, parts);
    const point = kernel("legacy-host").extensions.definePoint<{ id: string }>({ name: "sidebar.panel" });
    kernel("folders").ports.offer("tree", { id: "tree", title: "Folders" });
    kernel("legacy-panel").extensions.contribute("sidebar.panel", { id: "legacy", title: "Legacy" }, { order: 5 });
    expect(point.get().map((i) => i.id)).toEqual(["legacy", "tree"]);
  });

  it("a consumer on ports uses a 1.x provider's returned API", () => {
    const { ports, kernel } = setup(manifests, parts);
    const api = routerApi();
    ports.adoptLegacyApi("router", api);
    kernel("graph").ports.use<{ navigate(path: string): void }>("router").navigate("/x");
    expect(api.navigate).toHaveBeenCalledWith("/x");
  });

  it("a 1.x consumer requires a provider that serves on a port", () => {
    const { kernel } = setup(manifests, parts);
    const api = routerApi();
    kernel("router-next").ports.serve("router", api);
    kernel("legacy-consumer").services.require<{ navigate(path: string): void }>("router-next").navigate("/y");
    expect(api.navigate).toHaveBeenCalledWith("/y");
  });

  it("a plugin with ports keeps working through its 1.x calls, on its ports and under its needs", () => {
    const { ports, kernel } = setup(manifests, { ...parts, bindings: { "graph:router": "router-next:router" } });
    const api = routerApi();
    kernel("router-next").ports.serve("router", api);
    const router = kernel("graph").services.require<ReturnType<typeof routerApi>>("router-next");
    router.navigate("/z");
    expect(api.navigate).toHaveBeenCalledWith("/z");
    expect(() => router.current()).toThrow(ContractViolationError);
    // Its legacy `contribute` lands on its declared port, and so takes the wired seat.
    kernel("folders").extensions.contribute("sidebar.panel", { id: "tree", title: "Folders" });
    expect(kernel("shell-ui").ports.collect<{ id: string }>("sidebar").entries()[0]).toMatchObject({ port: "tree" });
    ports.removePlugin("folders");
    expect(kernel("shell-ui").ports.collect("sidebar").get()).toEqual([]);
  });
});
