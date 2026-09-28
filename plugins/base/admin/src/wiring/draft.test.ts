import { describe, expect, it } from "vitest";

import { EMPTY_OVERRIDES, connect, cut, edits, moveSeat, rebase, replay, resetToAutomatic, sameOverrides, togglePlug } from "./draft.js";

const HOST = "shell-ui:sidebar";
const seats = ["folders:tree", "doc-list:list"];

describe("connect", () => {
  it("takes the open seat, seeding the host's order from its current seats", () => {
    const out = connect(EMPTY_OVERRIDES, { from: "acme:panel", to: HOST, kind: "slot", auto: true, current: seats });
    expect(out.ok && out.overrides.order[HOST]).toEqual(["folders:tree", "doc-list:list", "acme:panel"]);
    expect(out.ok && out.seat).toBe(3);
    expect(out.ok && out.overrides.add).toEqual([]);
  });

  it("records a by-shape wire in add", () => {
    const out = connect(EMPTY_OVERRIDES, { from: "acme:panel", to: HOST, kind: "slot", auto: false, current: seats });
    expect(out.ok && out.overrides.add).toEqual(["acme:panel -> shell-ui:sidebar"]);
  });

  it("refuses a source already seated", () => {
    const out = connect(EMPTY_OVERRIDES, { from: "folders:tree", to: HOST, kind: "slot", auto: true, current: seats });
    expect(out).toEqual({ ok: false, reason: "already in seat 1" });
  });

  it("restores a cut wire instead of adding it twice", () => {
    const before = { ...EMPTY_OVERRIDES, cut: ["acme:panel -> shell-ui:sidebar"] };
    const out = connect(before, { from: "acme:panel", to: HOST, kind: "slot", auto: true, current: seats });
    expect(out.ok && out.overrides.cut).toEqual([]);
  });

  it("puts the new source first on a single-seat host and benches the occupant", () => {
    const out = connect(EMPTY_OVERRIDES, { from: "acme:bar", to: "shell-ui:header", kind: "slot", auto: true, current: ["header:bar"], single: true });
    expect(out.ok && out.overrides.order["shell-ui:header"]).toEqual(["acme:bar", "header:bar"]);
    expect(out.ok && out.benched).toBe("header:bar");
  });

  it("pins a service, unless it is the automatic pick with no alternative", () => {
    const pinned = connect(EMPTY_OVERRIDES, {
      from: "acme:index",
      to: "graph:index",
      kind: "service",
      auto: true,
      current: [],
      autoChoice: { port: "indexer:index", several: true },
    });
    expect(pinned.ok && pinned.overrides.bind).toEqual({ "graph:index": "acme:index" });
    const automatic = connect(
      { ...EMPTY_OVERRIDES, bind: { "graph:index": null } },
      { from: "indexer:index", to: "graph:index", kind: "service", auto: true, current: [], autoChoice: { port: "indexer:index", several: false } },
    );
    expect(automatic.ok && automatic.overrides.bind).toEqual({});
  });

  it("wires an event without touching order", () => {
    const out = connect(EMPTY_OVERRIDES, { from: "folders:location", to: "doc-list:location", kind: "event", auto: true, current: [] });
    expect(out.ok && out.overrides.order).toEqual({});
  });
});

describe("cut", () => {
  it("cuts an automatic slot wire and drops it from the order", () => {
    const before = { ...EMPTY_OVERRIDES, order: { [HOST]: seats } };
    const out = cut(before, { from: "folders:tree", to: HOST, kind: "slot" });
    expect(out.cut).toEqual(["folders:tree -> shell-ui:sidebar"]);
    expect(out.order[HOST]).toEqual(["doc-list:list"]);
  });

  it("removes a hand-added wire rather than cutting it", () => {
    const before = { ...EMPTY_OVERRIDES, add: ["acme:panel -> shell-ui:sidebar"], order: { [HOST]: ["acme:panel"] } };
    const out = cut(before, { from: "acme:panel", to: HOST, kind: "slot" });
    expect(out.add).toEqual([]);
    expect(out.cut).toEqual([]);
    expect(out.order).toEqual({});
  });

  it("binds a service port to null", () => {
    expect(cut(EMPTY_OVERRIDES, { from: "router:router", to: "graph:router", kind: "service" }).bind).toEqual({ "graph:router": null });
  });

  it("cut and reconnect sends a source to the bottom", () => {
    const after = cut({ ...EMPTY_OVERRIDES }, { from: "folders:tree", to: HOST, kind: "slot" });
    const back = connect(after, { from: "folders:tree", to: HOST, kind: "slot", auto: true, current: ["doc-list:list"] });
    expect(back.ok && back.overrides.cut).toEqual([]);
    expect(back.ok && back.overrides.order[HOST]).toEqual(["doc-list:list", "folders:tree"]);
  });
});

describe("seats", () => {
  it("moves a seat up and down within the host's list", () => {
    const down = moveSeat(EMPTY_OVERRIDES, HOST, seats, "folders:tree", 1);
    expect(down.order[HOST]).toEqual(["doc-list:list", "folders:tree"]);
    const up = moveSeat(down, HOST, down.order[HOST] ?? [], "folders:tree", -1);
    expect(up.order[HOST]).toEqual(seats);
    expect(moveSeat(EMPTY_OVERRIDES, HOST, seats, "folders:tree", -1)).toBe(EMPTY_OVERRIDES);
  });
});

describe("unplug", () => {
  it("toggles the plugin and keeps its seats", () => {
    const before = { ...EMPTY_OVERRIDES, order: { [HOST]: seats } };
    const off = togglePlug(before, "folders");
    expect(off.unplugged).toEqual(["folders"]);
    expect(off.order[HOST]).toEqual(seats);
    expect(togglePlug(off, "folders").unplugged).toEqual([]);
  });

  it("reset to automatic keeps only the unplugged list", () => {
    const before = { unplugged: ["notices"], bind: { "graph:index": "acme:index" }, cut: ["a -> b"], add: ["c -> d"], order: { [HOST]: seats } };
    expect(resetToAutomatic(before)).toEqual({ ...EMPTY_OVERRIDES, unplugged: ["notices"] });
  });
});

describe("rebase", () => {
  const base = { unplugged: [], bind: {}, cut: [], add: [], order: { [HOST]: seats } };
  const draft = { ...base, unplugged: ["notices"], order: { [HOST]: ["doc-list:list", "folders:tree"] } };

  it("lists the draft's edits and replays them onto a clean base", () => {
    const list = edits(base, draft);
    expect(list).toEqual([
      { kind: "unplug", plugin: "notices" },
      { kind: "order", host: HOST, seats: ["doc-list:list", "folders:tree"] },
    ]);
    expect(sameOverrides(replay(base, list), draft)).toBe(true);
  });

  it("keeps the draft's edits on top of what the new live version changed", () => {
    const live = { version: 14, ...base, unplugged: ["welcome"], bind: { "graph:index": "acme:index" } };
    const out = rebase(base, draft, live);
    expect(out.draft.unplugged).toEqual(["notices", "welcome"]);
    expect(out.draft.bind).toEqual({ "graph:index": "acme:index" });
    expect(out.draft.order[HOST]).toEqual(["doc-list:list", "folders:tree"]);
    expect(out.liveChanged).toEqual(["unplug welcome", "graph:index → acme"]);
    expect(out.overlapping).toEqual([]);
  });

  it("names the edits that overlap with what live changed", () => {
    const live = { version: 14, ...base, order: { [HOST]: ["doc-list:list"] } };
    const out = rebase(base, draft, live);
    expect(out.overlapping).toEqual(["shell-ui:sidebar seats: doc-list, folders"]);
    expect(out.draft.order[HOST]).toEqual(["doc-list:list", "folders:tree"]);
  });

  it("a plug edit undoes an unplug the new live version made", () => {
    const off = { ...base, unplugged: ["notices"] };
    const back = { ...base, unplugged: [] };
    const live = { version: 14, ...base, unplugged: ["notices", "welcome"] };
    expect(rebase(off, back, live).draft.unplugged).toEqual(["welcome"]);
  });
});
