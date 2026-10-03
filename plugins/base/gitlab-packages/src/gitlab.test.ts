import { describe, expect, it } from "vitest";

import type { PluginUpdate, SavedSource } from "plugin:admin";

import {
  browse,
  chooseFile,
  compareVersions,
  download,
  endpointOf,
  newestPerName,
  normalizeInstance,
  normalizeProject,
  parsePackageUrl,
  checkUpdates,
  validate,
  writeSettings,
  type FetchJson,
} from "./gitlab.js";

const API = "https://gitlab.example.com/api/v4/projects/tools%2Fddd-plugins";

const source = (overrides: Partial<Parameters<typeof writeSettings>[0]> = {}): SavedSource => ({
  id: "src-1",
  provider: "gitlab",
  name: "Work GitLab",
  ...writeSettings({
    instance: "https://gitlab.example.com",
    project: "tools/ddd-plugins",
    tokenKind: "access",
    token: "glpat-abc",
    ...overrides,
  }),
});

const answers =
  (routes: Record<string, unknown>): FetchJson =>
  async (url) => {
    if (!(url in routes)) throw new Error(`GitLab answered 404 for ${url}`);
    return routes[url];
  };

describe("settings", () => {
  it("turns saved settings into an endpoint with the right token header", () => {
    expect(endpointOf(source())).toEqual({
      instance: "https://gitlab.example.com",
      project: "tools/ddd-plugins",
      headers: { "PRIVATE-TOKEN": "glpat-abc" },
    });
    expect(endpointOf(source({ tokenKind: "deploy" })).headers).toEqual({ "Deploy-Token": "glpat-abc" });
    expect(endpointOf(source({ tokenKind: "none" })).headers).toEqual({});
  });

  it("keeps the token out of the settings when there is none to send", () => {
    expect(writeSettings({ instance: "x", project: "y", tokenKind: "none", token: "t" }).secrets).toEqual({});
  });

  it("validates what the setup form needs", () => {
    expect(validate(source())).toBeUndefined();
    expect(validate(source({ token: "" }))).toMatch(/token/);
    expect(validate(source({ project: "" }))).toMatch(/project/);
    expect(validate(source({ instance: "http://gitlab.internal" }))).toMatch(/https/);
    expect(validate(source({ token: "", tokenKind: "none" }))).toBeUndefined();
  });

  it("normalizes addresses and pasted project URLs", () => {
    expect(normalizeInstance("gitlab.example.com/")).toBe("https://gitlab.example.com");
    expect(normalizeInstance("")).toBe("https://gitlab.com");
    const instance = "https://gitlab.example.com";
    expect(normalizeProject("https://gitlab.example.com/tools/ddd-plugins/-/packages", instance)).toBe("tools/ddd-plugins");
    expect(normalizeProject("/tools/ddd-plugins.git", instance)).toBe("tools/ddd-plugins");
  });
});

describe("package helpers", () => {
  it("reads a generic package URL", () => {
    expect(parsePackageUrl(`${API}/packages/generic/tasks/1.2.0/tasks-1.2.0.zip`)).toEqual({
      name: "tasks",
      version: "1.2.0",
      file: "tasks-1.2.0.zip",
    });
    expect(parsePackageUrl("https://example.com/plugin.zip")).toBeUndefined();
  });

  it("orders versions numerically, a pre-release before its release", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });

  it("keeps the newest finished version of each package", () => {
    const listed = [
      { id: 1, name: "tasks", version: "1.2.0" },
      { id: 2, name: "tasks", version: "1.10.0", status: "default" },
      { id: 3, name: "tasks", version: "2.0.0", status: "processing" },
      { id: 4, name: "themes", version: "0.3.0" },
    ];
    expect(newestPerName(listed).map((found) => found.id)).toEqual([2, 4]);
    expect(newestPerName(listed, "themes").map((found) => found.id)).toEqual([4]);
    expect(newestPerName({ message: "nope" })).toEqual([]);
  });

  it("picks the zip that follows the installed file's naming, then any zip", () => {
    const previous = { name: "tasks", version: "1.2.0", file: "bundle-1.2.0.zip" };
    expect(chooseFile([{ file_name: "bundle-1.3.0.zip" }, { file_name: "tasks-1.3.0.zip" }], "tasks", "1.3.0", previous)).toBe("bundle-1.3.0.zip");
    expect(chooseFile([{ file_name: "notes.txt" }, { file_name: "other.zip" }], "tasks", "1.3.0")).toBe("other.zip");
    expect(chooseFile([{ file_name: "notes.txt" }], "tasks", "1.3.0")).toBeUndefined();
  });
});

describe("browse", () => {
  it("lists the newest zip of every package in the project", async () => {
    const found = await browse(
      source(),
      answers({
        [`${API}/packages?package_type=generic&per_page=100`]: [
          { id: 7, name: "tasks", version: "1.3.0" },
          { id: 6, name: "tasks", version: "1.2.0" },
          { id: 9, name: "docs-only", version: "1.0.0" },
        ],
        [`${API}/packages/7/package_files?per_page=100`]: [{ file_name: "tasks-1.3.0.zip" }],
        [`${API}/packages/9/package_files?per_page=100`]: [{ file_name: "README.md" }],
      }),
    );
    expect(found).toEqual([
      { name: "tasks", version: "1.3.0", plugin: "tasks", url: `${API}/packages/generic/tasks/1.3.0/tasks-1.3.0.zip` },
    ]);
  });
});

describe("download", () => {
  it("sends the token and refuses URLs on another host", async () => {
    let seen: HeadersInit | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seen = init?.headers;
      return new Response("PK");
    }) as typeof fetch;
    const blob = await download(source(), `${API}/packages/generic/tasks/1.3.0/tasks-1.3.0.zip`, fetcher);
    expect(await blob.text()).toBe("PK");
    expect(seen).toEqual({ "PRIVATE-TOKEN": "glpat-abc" });
    await expect(download(source(), "https://elsewhere.example.com/x.zip", fetcher)).rejects.toThrow(/not on/);
  });

  it("explains a network failure and a refusal", async () => {
    const url = `${API}/packages/generic/tasks/1.3.0/tasks-1.3.0.zip`;
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(download(source(), url, offline)).rejects.toThrow(/could not reach https:\/\/gitlab.example.com/);
    const refused = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(download(source(), url, refused)).rejects.toThrow(/401: the token/);
  });
});

describe("checkUpdates", () => {
  const installed = `${API}/packages/generic/tasks/1.2.0/tasks-1.2.0.zip`;

  it("reports a newer version of what this source installed", async () => {
    const reported: PluginUpdate[] = [];
    await checkUpdates(
      source(),
      [{ id: "tasks", version: "1.2.0", url: installed }],
      (update) => reported.push(update),
      answers({
        [`${API}/packages?package_type=generic&per_page=100&package_name=tasks`]: [
          { id: 7, name: "tasks", version: "1.3.0" },
          { id: 8, name: "tasks-beta", version: "9.0.0" },
        ],
        [`${API}/packages/7/package_files?per_page=100`]: [{ file_name: "tasks-1.3.0.zip" }],
      }),
    );
    expect(reported).toEqual([
      {
        plugin: "tasks",
        source: "src-1",
        current: "1.2.0",
        latest: "1.3.0",
        url: `${API}/packages/generic/tasks/1.3.0/tasks-1.3.0.zip`,
      },
    ]);
  });

  it("says nothing when up to date, and throws what it could not check", async () => {
    const reported: PluginUpdate[] = [];
    await checkUpdates(
      source(),
      [{ id: "tasks", version: "1.2.0", url: installed }],
      (update) => reported.push(update),
      answers({ [`${API}/packages?package_type=generic&per_page=100&package_name=tasks`]: [{ id: 6, name: "tasks", version: "1.2.0" }] }),
    );
    expect(reported).toEqual([]);
    await expect(
      checkUpdates(source(), [{ id: "tasks", version: "1.2.0", url: installed }], () => {}, answers({})),
    ).rejects.toThrow(/tasks: GitLab answered 404/);
  });
});
