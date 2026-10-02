import { describe, expect, it, vi } from "vitest";

import type { PluginCapabilities } from "@kernel";

import {
  approvalProblems,
  auditParams,
  configSubmission,
  createAdminClient,
  describeActor,
  formatBytes,
  hostPolicyNote,
  formatWhen,
  isBareHost,
  normalizeConfigValues,
  parseHostList,
  type PluginConfigSchema,
  type UserView,
} from "./api.js";

const user = (over: Partial<UserView>): UserView => ({
  id: "u1",
  email: "a@example.com",
  name: "A",
  is_admin: false,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("auditParams", () => {
  it("omits unset and blank filters", () => {
    expect(auditParams({})).toBe("");
    expect(auditParams({ action: "   ", actor: "" })).toBe("");
  });

  it("encodes what is set", () => {
    expect(auditParams({ action: "document.delete", limit: 50 })).toBe(
      "?action=document.delete&limit=50",
    );
    expect(auditParams({ cursor: "abc=" })).toBe("?cursor=abc%3D");
  });

  it("trims, so a stray space does not filter on nothing", () => {
    expect(auditParams({ actor: " u1 " })).toBe("?actor=u1");
  });
});

describe("describeActor", () => {
  const users = [user({ id: "u1" }), user({ id: "u2", email: "gone@example.com", is_active: false })];

  it("names an active user by email", () => {
    expect(describeActor("u1", users)).toBe("a@example.com");
  });

  it("marks a soft-deleted account, keeping the attribution readable", () => {
    expect(describeActor("u2", users)).toBe("gone@example.com (deleted)");
  });

  it("does not pretend an unknown id is a person", () => {
    expect(describeActor("u9", users)).toBe("deleted user (u9)");
  });

  it("labels non-human actors", () => {
    expect(describeActor("system", users)).toBe("system");
    expect(describeActor("plugin:calendar", users)).toBe("plugin calendar");
  });

  it("handles a missing actor", () => {
    expect(describeActor(null, users)).toBe("—");
    expect(describeActor(undefined, [])).toBe("—");
  });
});

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MiB");
    expect(formatBytes(1024 * 1024 * 1024 * 20)).toBe("20 GiB");
  });

  it("refuses to invent a number", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatWhen", () => {
  it("passes through a value it cannot parse instead of showing Invalid Date", () => {
    expect(formatWhen("not a date")).toBe("not a date");
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen(undefined)).toBe("—");
  });

  it("renders a real timestamp", () => {
    expect(formatWhen("2026-09-23T10:00:00.000Z")).not.toBe("—");
  });
});

function recorder(response: unknown = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchApi = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return {
      json: async () => response,
      blob: async () => new Blob(),
    } as unknown as Response;
  });
  return { calls, client: createAdminClient(fetchApi) };
}

describe("the plugin management client", () => {
  it("reads the management listing from the admin namespace", async () => {
    const { calls, client } = recorder({ plugins: [] });
    await client.adminPlugins();
    expect(calls[0]?.path).toBe("/admin/plugins");
    expect(calls[0]?.init).toBeUndefined();
  });

  it("uploads a package as multipart, without setting content-type by hand", async () => {
    const { calls, client } = recorder({ id: "x", version: "1.0.0" });
    const file = new File(["zip bytes"], "my-plugin-1.2.0.zip", { type: "application/zip" });
    await client.uploadPlugin(file);
    const init = calls[0]?.init;
    expect(calls[0]?.path).toBe("/admin/plugins");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(init?.headers).toBeUndefined();
    const form = init?.body as FormData;
    expect((form.get("package") as File).name).toBe("my-plugin-1.2.0.zip");
  });

  it("approves with the granted capability set, and without one when none is given", async () => {
    const granted: PluginCapabilities = { documents: ["read"], http: { hosts: ["a.test"] } };
    const { calls, client } = recorder({});
    await client.approvePlugin("calendar", "1.0.0", granted);
    await client.approvePlugin("calendar", "1.0.0");
    expect(calls[0]?.path).toBe("/admin/plugins/calendar/1.0.0/approve");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ capabilities: granted });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({});
  });

  it("only asks for a purge when told to", async () => {
    const { calls, client } = recorder({});
    await client.uninstallPlugin("calendar", false);
    await client.uninstallPlugin("calendar", true);
    expect(calls[0]?.path).toBe("/admin/plugins/calendar");
    expect(calls[1]?.path).toBe("/admin/plugins/calendar?purge=true");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("encodes ids and versions rather than concatenating them", async () => {
    const { calls, client } = recorder({});
    await client.rejectPlugin("odd/id", "1.0.0+build");
    expect(calls[0]?.path).toBe("/admin/plugins/odd%2Fid/1.0.0%2Bbuild/reject");
  });

  it("sends config values wrapped, because the body has room to grow", async () => {
    const { calls, client } = recorder({});
    await client.savePluginConfig("calendar", { feed_url: "https://x.test/f.ics" });
    expect(calls[0]?.path).toBe("/admin/plugins/calendar/config");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      values: { feed_url: "https://x.test/f.ics" },
    });
  });

  it("addresses a cron job by index and a log page by limit", async () => {
    const { calls, client } = recorder({});
    await client.runPluginCron("calendar", 0);
    await client.pluginLogs("calendar", 10);
    await client.pluginLogs("calendar");
    expect(calls[0]?.path).toBe("/admin/plugins/calendar/cron/0/run");
    expect(calls[1]?.path).toBe("/admin/plugins/calendar/logs?limit=10");
    expect(calls[2]?.path).toBe("/admin/plugins/calendar/logs");
  });

  it("disables with an optional note and enables with no body", async () => {
    const { calls, client } = recorder({});
    await client.disablePlugin("calendar", "misbehaving");
    await client.disablePlugin("calendar");
    await client.enablePlugin("calendar");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ note: "misbehaving" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({});
    expect(calls[2]?.path).toBe("/admin/plugins/calendar/enable");
  });
});

const SCHEMA: PluginConfigSchema = {
  feed_url: { type: "string", required: true },
  refresh: { type: "string", default: "0 6 * * *" },
  every: { type: "number" },
  enabled: { type: "boolean" },
  auth_header: { type: "string", secret: true },
};

const MASK = "••••••••";

describe("normalizeConfigValues", () => {
  it("never renders a secret, and says whether one is stored", () => {
    const flat = normalizeConfigValues({ auth_header: MASK }, SCHEMA, MASK);
    expect(flat["auth_header"]).toEqual({ value: MASK, set: true });
    const absent = normalizeConfigValues({}, SCHEMA, MASK);
    expect(absent["auth_header"]).toEqual({ value: "", set: false });
  });

  it("reads both plausible server spellings of a value", () => {
    const flat = normalizeConfigValues({ feed_url: "https://x.test/f.ics" }, SCHEMA, MASK);
    const wrapped = normalizeConfigValues(
      { feed_url: { value: "https://x.test/f.ics", set: true } },
      SCHEMA,
      MASK,
    );
    expect(flat["feed_url"]).toEqual({ value: "https://x.test/f.ics", set: true });
    expect(wrapped["feed_url"]).toEqual({ value: "https://x.test/f.ics", set: true });
  });

  it("falls back to the declared default for an unset field", () => {
    const values = normalizeConfigValues({}, SCHEMA, MASK);
    expect(values["refresh"]).toEqual({ value: "0 6 * * *", set: false });
    expect(values["feed_url"]).toEqual({ value: "", set: false });
  });

  it("ignores keys the schema does not declare, and survives a junk body", () => {
    const values = normalizeConfigValues({ nonsense: 1 }, SCHEMA, MASK);
    expect(Object.keys(values)).toEqual(Object.keys(SCHEMA));
    expect(Object.keys(normalizeConfigValues(null, SCHEMA, MASK))).toEqual(Object.keys(SCHEMA));
    expect(Object.keys(normalizeConfigValues("nope", SCHEMA, MASK))).toEqual(Object.keys(SCHEMA));
  });
});

describe("configSubmission", () => {
  it("drops an untouched secret rather than overwriting it with the mask", () => {
    const body = configSubmission({ auth_header: MASK }, SCHEMA, MASK);
    expect(body).not.toHaveProperty("auth_header");
    expect(configSubmission({ auth_header: "" }, SCHEMA, MASK)).not.toHaveProperty("auth_header");
    expect(configSubmission({ auth_header: "Bearer x" }, SCHEMA, MASK)).toEqual({
      auth_header: "Bearer x",
    });
  });

  it("coerces by declared type", () => {
    expect(configSubmission({ every: "15" }, SCHEMA, MASK)).toEqual({ every: 15 });
    expect(configSubmission({ enabled: "true" }, SCHEMA, MASK)).toEqual({ enabled: true });
    expect(configSubmission({ enabled: false }, SCHEMA, MASK)).toEqual({ enabled: false });
  });

  it("clears an emptied optional field and keeps an emptied required one for the server to refuse", () => {
    expect(configSubmission({ refresh: "" }, SCHEMA, MASK)).toEqual({ refresh: null });
    expect(configSubmission({ every: "" }, SCHEMA, MASK)).toEqual({ every: null });
    expect(configSubmission({ feed_url: "" }, SCHEMA, MASK)).toEqual({ feed_url: "" });
  });

  it("never sends a key the manifest does not declare", () => {
    expect(configSubmission({ stray: "x" }, SCHEMA, MASK)).toEqual({});
  });
});

describe("approvalProblems — narrow anything, extend only http.hosts", () => {
  const requested: PluginCapabilities = {
    documents: ["read", "write"],
    http: { hosts: [] },
    "public-routes": ["/webhook"],
  };

  it("accepts the requested set unchanged", () => {
    expect(approvalProblems(requested, requested)).toEqual([]);
  });

  it("accepts a narrowing", () => {
    expect(approvalProblems(requested, { documents: ["read"] })).toEqual([]);
    expect(approvalProblems(requested, {})).toEqual([]);
  });

  it("accepts added hosts — the one legal widening", () => {
    expect(
      approvalProblems(requested, { http: { hosts: ["calendar.example.com"] } }),
    ).toEqual([]);
  });

  it("refuses every other widening", () => {
    expect(approvalProblems({ documents: ["read"] }, { documents: ["write"] })).toHaveLength(1);
    expect(approvalProblems({}, { notifications: true })).toHaveLength(1);
    expect(approvalProblems({}, { "public-routes": ["/hook"] })).toHaveLength(1);
    expect(approvalProblems({}, { http: { hosts: ["a.test"] } })).toHaveLength(1);
  });

  it("refuses a host that is not a bare host name", () => {
    const problems = approvalProblems(requested, {
      http: { hosts: ["https://a.test/x", "a.test:8443", "*.a.test"] },
    });
    expect(problems).toHaveLength(3);
  });

  it("treats a missing request as requesting nothing", () => {
    expect(approvalProblems(undefined, { documents: ["read"] })).toHaveLength(1);
  });
});

describe("isBareHost / parseHostList", () => {
  it("accepts a host name and nothing else", () => {
    expect(isBareHost("calendar.google.com")).toBe(true);
    expect(isBareHost(" a-b.test ")).toBe(true);
    expect(isBareHost("")).toBe(false);
    expect(isBareHost("a.test/path")).toBe(false);
    expect(isBareHost("http://a.test")).toBe(false);
    expect(isBareHost("a.test:443")).toBe(false);
    expect(isBareHost("*.a.test")).toBe(false);
    expect(isBareHost("a_b.test")).toBe(false);
  });

  it("splits a typed list on commas and whitespace", () => {
    expect(parseHostList("a.test, b.test")).toEqual(["a.test", "b.test"]);
    expect(parseHostList("  a.test \n b.test,,")).toEqual(["a.test", "b.test"]);
    expect(parseHostList("")).toEqual([]);
  });
});

describe("hostPolicyNote", () => {
  it("says nothing about an ordinary public host", () => {
    expect(hostPolicyNote("calendar.google.com")).toBeUndefined();
    expect(hostPolicyNote("feeds.example.net")).toBeUndefined();
    expect(hostPolicyNote("203.0.113.7")).toBeUndefined();
    expect(hostPolicyNote("")).toBeUndefined();
  });

  it("calls a cloud metadata endpoint unreachable whatever the configuration", () => {
    for (const host of [
      "169.254.169.254",
      "169.254.170.2",
      "100.100.100.200",
      "metadata.google.internal",
    ]) {
      const note = hostPolicyNote(host);
      expect(note?.kind).toBe("metadata");
      expect(note?.message).toContain("before it consults any allowlist");
    }
  });

  it("calls loopback and private ranges blocked *unless* the operator allowlisted them", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "::1", "0.0.0.0"]) {
      expect(hostPolicyNote(host)?.kind).toBe("loopback");
    }
    for (const host of ["10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.10", "100.72.0.1", "fd00::1", "fe80::1"]) {
      expect(hostPolicyNote(host)?.kind).toBe("private");
    }
    expect(hostPolicyNote("10.0.0.5")?.message).toContain("PLUGIN_HTTP_ALLOW_CIDRS");
    expect(hostPolicyNote("localhost")?.message).toContain("PLUGIN_HTTP_ALLOW_CIDRS");
  });

  it("leaves 172.15/172.32 alone — they are public, and the /12 boundary is easy to fumble", () => {
    expect(hostPolicyNote("172.15.0.1")).toBeUndefined();
    expect(hostPolicyNote("172.32.0.1")).toBeUndefined();
    expect(hostPolicyNote("100.63.0.1")).toBeUndefined();
    expect(hostPolicyNote("100.128.0.1")).toBeUndefined();
  });

  it("hedges on an internal name, because only resolution can settle it", () => {
    const note = hostPolicyNote("nas.local");
    expect(note?.kind).toBe("internal-name");
    expect(note?.message).toContain("depends on what it resolves to");
  });
});
