import { describe, expect, it, vi } from "vitest";

import type { PluginUpdate, SavedSource } from "plugin:admin";

import { gitHubSource, identify, newestPerName, readSettings, refusal, writeSettings, type FetchAsset, type FetchJson, type Hosts } from "./github.js";

const HOSTS: Hosts = { site: "https://github.example.com", api: "https://api.github.example.com" };
const REPO = `${HOSTS.api}/repos/octo-org/ddd-plugins`;
const RELEASES = `${REPO}/releases?per_page=100`;

const source = (token = ""): SavedSource => ({
  id: "src-1",
  provider: "github",
  name: "Plugins",
  ...writeSettings({ repo: "octo-org/ddd-plugins", token }),
});

const answers =
  (routes: Record<string, unknown>): FetchJson =>
  async (url) => {
    if (!(url in routes)) throw new Error(`GitHub answered 404 for ${url}`);
    return routes[url];
  };

const noAsset: FetchAsset = async () => {
  throw new Error("no download expected");
};

const release = (tag: string, assets: readonly { id: number; name: string; state?: string }[], extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets,
  ...extra,
});

const LISTED = [
  release("v1.5.0", [{ id: 15, name: "tasks-1.5.0.zip", state: "uploaded" }]),
  release("v1.4.0", [
    { id: 14, name: "tasks-1.4.0.zip" },
    { id: 40, name: "kanban-extras-0.2.0.zip" },
    { id: 41, name: "notes.txt" },
  ]),
  release("v2.0.0-rc.1", [{ id: 20, name: "tasks-2.0.0-rc.1.zip" }], { prerelease: true }),
  release("v3.0.0", [{ id: 30, name: "tasks-3.0.0.zip" }], { draft: true }),
  release("v1.6.0", [{ id: 16, name: "tasks-1.6.0.zip", state: "starter" }]),
];

describe("settings", () => {
  it("keeps the token secret and leaves it out when empty", () => {
    expect(writeSettings({ repo: "octo-org/ddd-plugins", token: " ghp_abc " })).toEqual({
      config: { repo: "octo-org/ddd-plugins" },
      secrets: { token: "ghp_abc" },
    });
    expect(writeSettings({ repo: "a/b", token: "  " }).secrets).toEqual({});
    expect(readSettings(source("ghp_abc"))).toEqual({ repo: "octo-org/ddd-plugins", token: "ghp_abc" });
  });

  it("accepts a repository as owner/name or as its page address", () => {
    const github = gitHubSource(HOSTS, answers({}), noAsset);
    expect(github.normalizeRepo("octo-org/ddd-plugins")).toBe("octo-org/ddd-plugins");
    expect(github.normalizeRepo("https://github.example.com/octo-org/ddd-plugins/releases")).toBe("octo-org/ddd-plugins");
    expect(github.normalizeRepo("github.example.com/octo-org/ddd-plugins.git")).toBe("octo-org/ddd-plugins");
    expect(github.validate(writeSettings({ repo: "octo-org", token: "" }))).toMatch(/owner\/name/);
    expect(github.validate(writeSettings({ repo: "octo-org/../x", token: "" }))).toMatch(/owner\/name/);
    expect(github.validate(writeSettings({ repo: "octo-org/ddd-plugins", token: "" }))).toBeUndefined();
  });
});

describe("assets", () => {
  it("reads the plugin and version from the asset name, or the tag", () => {
    expect(identify("tasks-1.5.0.zip", "v1.5.0")).toEqual({ name: "tasks", version: "1.5.0" });
    expect(identify("extra-task-states-v1.5.0.zip", "release")).toEqual({ name: "extra-task-states", version: "1.5.0" });
    expect(identify("tasks-2.0.0-rc.1.zip", "x")).toEqual({ name: "tasks", version: "2.0.0-rc.1" });
    expect(identify("tasks.zip", "v1.2.0")).toEqual({ name: "tasks", version: "1.2.0" });
    expect(identify("tasks-1.5.0.tar.gz", "v1.5.0")).toBeUndefined();
  });

  it("offers the newest uploaded zip of each plugin from published releases", () => {
    expect(newestPerName(LISTED).map((asset) => [asset.name, asset.version, asset.id])).toEqual([
      ["tasks", "1.5.0", 15],
      ["kanban-extras", "0.2.0", 40],
    ]);
    expect(newestPerName({ message: "Not Found" })).toEqual([]);
  });
});

describe("browse", () => {
  it("lists packages with their release download links", async () => {
    const load = vi.fn(answers({ [RELEASES]: LISTED }));
    const github = gitHubSource(HOSTS, load, noAsset);
    expect(await github.browse(source("ghp_abc"))).toEqual([
      {
        name: "tasks",
        version: "1.5.0",
        plugin: "tasks",
        url: "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.5.0/tasks-1.5.0.zip",
      },
      {
        name: "kanban-extras",
        version: "0.2.0",
        plugin: "kanban-extras",
        url: "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.4.0/kanban-extras-0.2.0.zip",
      },
    ]);
    expect(load.mock.calls[0]![1]).toMatchObject({ authorization: "Bearer ghp_abc" });
  });

  it("sends no authorization without a token", async () => {
    const load = vi.fn(answers({ [RELEASES]: [] }));
    await gitHubSource(HOSTS, load, noAsset).browse(source());
    expect(load.mock.calls[0]![1]).not.toHaveProperty("authorization");
  });
});

describe("download", () => {
  const url = "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.5.0/tasks-1.5.0.zip";

  it("finds the asset by its release tag and fetches it through the server", async () => {
    const zip = new Blob(["PK"]);
    const fetchAsset = vi.fn<FetchAsset>(async () => zip);
    const github = gitHubSource(HOSTS, answers({ [`${REPO}/releases/tags/v1.5.0`]: LISTED[0] }), fetchAsset);
    expect(await github.download(source("ghp_abc"), url)).toBe(zip);
    expect(fetchAsset).toHaveBeenCalledWith({ repo: "octo-org/ddd-plugins", asset: 15, token: "ghp_abc" });
  });

  it("refuses links into another repository or site, and missing assets", async () => {
    const github = gitHubSource(HOSTS, answers({ [`${REPO}/releases/tags/v1.5.0`]: release("v1.5.0", []) }), noAsset);
    await expect(github.download(source(), url.replace("ddd-plugins", "other"))).rejects.toThrow(/not a release download/);
    await expect(github.download(source(), url.replace("github.example.com", "evil.example.com"))).rejects.toThrow(
      /not a release download/,
    );
    await expect(github.download(source(), url)).rejects.toThrow(/has no tasks-1.5.0.zip/);
  });
});

describe("checkUpdates", () => {
  it("reports a newer release of a plugin installed from this repository", async () => {
    const github = gitHubSource(HOSTS, answers({ [RELEASES]: LISTED }), noAsset);
    const reported: PluginUpdate[] = [];
    await github.checkUpdates(
      source(),
      [
        {
          id: "tasks",
          version: "1.4.0",
          url: "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.4.0/tasks-1.4.0.zip",
        },
        {
          id: "kanban-extras",
          version: "0.2.0",
          url: "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.4.0/kanban-extras-0.2.0.zip",
        },
        { id: "elsewhere", version: "0.1.0", url: "https://github.example.com/someone/else/releases/download/v1/elsewhere-0.1.0.zip" },
      ],
      (update) => reported.push(update),
    );
    expect(reported).toEqual([
      {
        plugin: "tasks",
        source: "src-1",
        current: "1.4.0",
        latest: "1.5.0",
        url: "https://github.example.com/octo-org/ddd-plugins/releases/download/v1.5.0/tasks-1.5.0.zip",
      },
    ]);
  });

  it("asks GitHub nothing when no plugin came from this repository", async () => {
    const load = vi.fn(answers({}));
    await gitHubSource(HOSTS, load, noAsset).checkUpdates(source(), [{ id: "x", version: "1.0.0", url: "upload x.zip" }], () => {});
    expect(load).not.toHaveBeenCalled();
  });
});

describe("fromLink", () => {
  const github = gitHubSource(HOSTS, answers({}), noAsset);
  const read = (link: string) => {
    const linked = github.fromLink(link);
    return linked && { name: linked.name, ...readSettings(linked.settings) };
  };
  const expected = { name: "octo-org/ddd-plugins on GitHub", repo: "octo-org/ddd-plugins", token: "" };

  it("sets a source up from a repository page, a page inside it, a clone or an API address", () => {
    expect(read("https://github.example.com/octo-org/ddd-plugins")).toEqual(expected);
    expect(read("https://github.example.com/octo-org/ddd-plugins/releases/tag/v1.5.0")).toEqual(expected);
    expect(read("github.example.com/octo-org/ddd-plugins.git")).toEqual(expected);
    expect(read("git@github.example.com:octo-org/ddd-plugins.git")).toEqual(expected);
    expect(read("https://api.github.example.com/repos/octo-org/ddd-plugins/releases")).toEqual(expected);
  });

  it("ignores other hosts and what is not a repository", () => {
    expect(read("https://gitlab.example.com/octo-org/ddd-plugins")).toBeUndefined();
    expect(read("git@gitlab.example.com:octo-org/ddd-plugins.git")).toBeUndefined();
    expect(read("https://github.example.com/octo-org")).toBeUndefined();
    expect(read("not a link at all")).toBeUndefined();
  });
});

describe("test", () => {
  it("names the repository and the packages it found", async () => {
    const github = gitHubSource(HOSTS, answers({ [REPO]: { full_name: "octo-org/ddd-plugins" }, [RELEASES]: LISTED }), noAsset);
    expect(await github.test(source())).toBe("Reached octo-org/ddd-plugins: 2 packages (tasks 1.5.0, kanban-extras 0.2.0).");
  });

  it("says so when no release has a zip yet", async () => {
    const github = gitHubSource(HOSTS, answers({ [REPO]: {}, [RELEASES]: [] }), noAsset);
    expect(await github.test(source())).toMatch(/none of its published releases has a \.zip asset/);
  });

  it("explains GitHub's refusals", () => {
    expect(refusal(404)).toMatch(/check the repository/);
    expect(refusal(403)).toMatch(/hourly limit/);
  });
});
