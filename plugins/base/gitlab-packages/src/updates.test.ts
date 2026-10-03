import { describe, expect, it } from "vitest";

import type { PluginUpdate, RemoteLookupResult } from "plugin:admin";

import { chooseFile, compareVersions, newestRelease, parsePackageUrl } from "./gitlab.js";
import { checkUpdates } from "./updates.js";

const INSTANCE = "https://gitlab.example.com";
const PROJECT = "tools%2Fddd-plugins";
const installedUrl = `${INSTANCE}/api/v4/projects/${PROJECT}/packages/generic/extra-task-states/1.2.0/extra-task-states-1.2.0.zip`;
const location = parsePackageUrl(installedUrl)!;

describe("parsePackageUrl", () => {
  it("reads every part of a generic package URL", () => {
    expect(location).toEqual({
      instance: INSTANCE,
      project: "tools/ddd-plugins",
      name: "extra-task-states",
      version: "1.2.0",
      file: "extra-task-states-1.2.0.zip",
    });
    expect(parsePackageUrl("https://example.com/plugin.zip")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders numerically, with a pre-release before its release", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });
});

describe("newestRelease", () => {
  it("picks the highest finished version of the same package, newer than the installed one", () => {
    const listed = [
      { id: 1, name: "extra-task-states", version: "1.2.0" },
      { id: 2, name: "extra-task-states", version: "1.10.0", status: "default" },
      { id: 3, name: "extra-task-states", version: "2.0.0", status: "processing" },
      { id: 4, name: "extra-task-states-beta", version: "9.0.0" },
    ];
    expect(newestRelease(listed, location)?.id).toBe(2);
    expect(newestRelease([{ id: 1, name: "extra-task-states", version: "1.2.0" }], location)).toBeUndefined();
    expect(newestRelease({ message: "404" }, location)).toBeUndefined();
  });
});

describe("chooseFile", () => {
  it("prefers the installed file name with the new version, then any zip", () => {
    expect(chooseFile([{ file_name: "extra-task-states-1.3.0.zip" }], location, "1.3.0")).toBe("extra-task-states-1.3.0.zip");
    expect(chooseFile([{ file_name: "notes.txt" }, { file_name: "bundle.zip" }], location, "1.3.0")).toBe("bundle.zip");
    expect(chooseFile([{ file_name: "notes.txt" }], location, "1.3.0")).toBeUndefined();
  });
});

describe("checkUpdates", () => {
  const answers = (routes: Record<string, RemoteLookupResult>) => async (url: string): Promise<RemoteLookupResult> =>
    routes[url] ?? { status: 404, body: null };

  it("reports an update with a ready install request, and skips plugins installed with a token", async () => {
    const reported: PluginUpdate[] = [];
    const lookup = answers({
      [`${INSTANCE}/api/v4/projects/${PROJECT}/packages?package_type=generic&package_name=extra-task-states&per_page=100`]: {
        status: 200,
        body: [{ id: 7, name: "extra-task-states", version: "1.3.0" }],
      },
      [`${INSTANCE}/api/v4/projects/${PROJECT}/packages/7/package_files?per_page=100`]: {
        status: 200,
        body: [{ file_name: "extra-task-states-1.3.0.zip" }],
      },
    });
    await checkUpdates(
      {
        plugins: [
          { id: "extra-task-states", version: "1.2.0", url: installedUrl, authenticated: false },
          { id: "private-one", version: "1.0.0", url: installedUrl, authenticated: true },
        ],
        lookup,
      },
      (update) => reported.push(update),
    );
    expect(reported).toEqual([
      {
        plugin: "extra-task-states",
        source: "gitlab",
        current: "1.2.0",
        latest: "1.3.0",
        install: {
          url: `${INSTANCE}/api/v4/projects/${PROJECT}/packages/generic/extra-task-states/1.3.0/extra-task-states-1.3.0.zip`,
          label: "extra-task-states 1.3.0 from tools/ddd-plugins",
        },
      },
    ]);
  });

  it("throws what it could not check after reporting the rest", async () => {
    const reported: PluginUpdate[] = [];
    await expect(
      checkUpdates(
        { plugins: [{ id: "gone", version: "1.0.0", url: installedUrl, authenticated: false }], lookup: answers({}) },
        (update) => reported.push(update),
      ),
    ).rejects.toThrow(/gone: GitLab answered 404/);
    expect(reported).toEqual([]);
  });
});
