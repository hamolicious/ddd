import { describe, expect, it } from "vitest";

import { defaultFileName, normalizeInstance, normalizeProject, packageRequest, type GenericPackage } from "./gitlab.js";

const base: GenericPackage = {
  instance: "https://gitlab.example.com",
  project: "tools/ddd-plugins",
  name: "extra-task-states",
  version: "1.2.0",
  file: "",
  tokenKind: "access",
  token: "glpat-abc",
};

describe("packageRequest", () => {
  it("builds the generic package download URL with an encoded project path", () => {
    const request = packageRequest(base);
    expect(request.url).toBe(
      "https://gitlab.example.com/api/v4/projects/tools%2Fddd-plugins/packages/generic/extra-task-states/1.2.0/extra-task-states-1.2.0.zip",
    );
    expect(request.headers).toEqual({ "PRIVATE-TOKEN": "glpat-abc" });
    expect(request.label).toBe("extra-task-states 1.2.0 from tools/ddd-plugins");
  });

  it("uses the header GitLab expects for each kind of token", () => {
    expect(packageRequest({ ...base, tokenKind: "deploy" }).headers).toEqual({ "Deploy-Token": "glpat-abc" });
    expect(packageRequest({ ...base, tokenKind: "job" }).headers).toEqual({ "JOB-TOKEN": "glpat-abc" });
    expect(packageRequest({ ...base, tokenKind: "none", token: "ignored" }).headers).toEqual({});
  });

  it("keeps an explicit file name and a numeric project ID", () => {
    const request = packageRequest({ ...base, project: "42", file: "bundle.zip" });
    expect(request.url).toBe(
      "https://gitlab.example.com/api/v4/projects/42/packages/generic/extra-task-states/1.2.0/bundle.zip",
    );
  });

  it("refuses incomplete input with a message the form can show", () => {
    expect(() => packageRequest({ ...base, name: " " })).toThrow(/name is missing/);
    expect(() => packageRequest({ ...base, version: "" })).toThrow(/version is missing/);
    expect(() => packageRequest({ ...base, token: "" })).toThrow(/token/);
    expect(() => packageRequest({ ...base, file: "a/b.zip" })).toThrow(/cannot contain/);
    expect(() => packageRequest({ ...base, project: "" })).toThrow(/project/);
  });
});

describe("normalizeInstance", () => {
  it("adds https, drops a trailing slash and keeps a path prefix", () => {
    expect(normalizeInstance("gitlab.example.com/")).toBe("https://gitlab.example.com");
    expect(normalizeInstance("")).toBe("https://gitlab.com");
    expect(normalizeInstance("http://10.0.0.5:8080/gitlab/")).toBe("http://10.0.0.5:8080/gitlab");
    expect(() => normalizeInstance("ftp://gitlab.example.com")).toThrow(/https/);
  });
});

describe("normalizeProject", () => {
  it("accepts a pasted project URL", () => {
    const instance = "https://gitlab.example.com";
    expect(normalizeProject("https://gitlab.example.com/tools/ddd-plugins", instance)).toBe("tools/ddd-plugins");
    expect(normalizeProject("https://gitlab.example.com/tools/ddd-plugins/-/packages", instance)).toBe("tools/ddd-plugins");
    expect(normalizeProject("/tools/ddd-plugins.git", instance)).toBe("tools/ddd-plugins");
  });
});

describe("defaultFileName", () => {
  it("follows the name-version.zip convention, or stays empty", () => {
    expect(defaultFileName("tasks", "1.0.0")).toBe("tasks-1.0.0.zip");
    expect(defaultFileName("tasks", "")).toBe("");
  });
});
