import { describe, expect, it } from "vitest";

import type { Route } from "./api.js";

import {
  buildPath,
  compareSpecificity,
  fullPath,
  matchPath,
  matchRoutes,
  normalizePath,
  pathQuery,
} from "./match.js";

const route = (path: string, view: string, order?: number): Route =>
  order === undefined ? { path, view } : { path, view, order };

describe("normalizePath", () => {
  it("treats the hash, a bare path and a trailing slash as one path", () => {
    expect(normalizePath("#/doc/abc")).toBe("/doc/abc");
    expect(normalizePath("/doc/abc")).toBe("/doc/abc");
    expect(normalizePath("doc/abc/")).toBe("/doc/abc");
    expect(normalizePath("#//doc///abc//")).toBe("/doc/abc");
  });

  it("maps every spelling of nothing to the root", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("#")).toBe("/");
    expect(normalizePath("#/")).toBe("/");
  });

  it("drops the query and a nested fragment", () => {
    expect(normalizePath("#/search?q=cake")).toBe("/search");
    expect(pathQuery("#/search?q=cake")).toBe("?q=cake");
    expect(pathQuery("#/search")).toBe("");
  });
});

describe("fullPath", () => {
  it("keeps the query, because it is part of the address", () => {
    expect(fullPath("#/folder?path=home%2Flists")).toBe("/folder?path=home%2Flists");
    expect(fullPath("folder/?path=a")).toBe("/folder?path=a");
    expect(fullPath("#/doc/1")).toBe("/doc/1");
    expect(fullPath("")).toBe("/");
  });

  it("distinguishes two addresses that match the same route", () => {
    expect(fullPath("#/folder?path=a")).not.toBe(fullPath("#/folder?path=b"));
    expect(matchRoutes([{ path: "/folder", view: "folders" }], "#/folder?path=a")?.view).toBe(
      "folders",
    );
  });
});

describe("matchPath", () => {
  it("matches literal segments exactly, case included", () => {
    expect(matchPath("/settings", "/settings")).toEqual({});
    expect(matchPath("/settings", "/Settings")).toBeUndefined();
  });

  it("captures one segment per `:name`, percent-decoded", () => {
    expect(matchPath("/doc/:id", "/doc/01JABC")).toEqual({ id: "01JABC" });
    expect(matchPath("/folder/:path", "/folder/home%2Flists")).toEqual({ path: "home/lists" });
  });

  it("survives a half-typed percent escape", () => {
    expect(matchPath("/doc/:id", "/doc/100%")).toEqual({ id: "100%" });
  });

  it("requires the segment counts to agree", () => {
    expect(matchPath("/doc/:id", "/doc/a/b")).toBeUndefined();
    expect(matchPath("/doc/:id", "/doc")).toBeUndefined();
    expect(matchPath("/", "/doc")).toBeUndefined();
    expect(matchPath("/", "")).toEqual({});
  });

  it("captures the rest of the path with a trailing `*`", () => {
    expect(matchPath("/trash/*", "/trash")).toEqual({ rest: "" });
    expect(matchPath("/trash/*", "/trash/a/b")).toEqual({ rest: "a/b" });
  });
});

describe("matchRoutes", () => {
  const routes: readonly Route[] = [
    route("/", "home"),
    route("/settings/:section", "settings"),
    route("/settings/keys", "keybindings"),
    route("/doc/:id", "document"),
    route("/*", "catch-all", 900),
  ];

  it("resolves a literal segment over a parameter", () => {
    expect(matchRoutes(routes, "/settings/keys")?.view).toBe("keybindings");
    expect(matchRoutes(routes, "/settings/themes")?.view).toBe("settings");
  });

  it("passes the captured params through", () => {
    expect(matchRoutes(routes, "#/doc/01JX")).toEqual({
      view: "document",
      params: { id: "01JX" },
      pattern: "/doc/:id",
    });
  });

  it("uses a wildcard only as a last resort", () => {
    expect(matchRoutes(routes, "/doc/01JX")?.view).toBe("document");
    expect(matchRoutes(routes, "/nowhere/at/all")?.view).toBe("catch-all");
  });

  it("reports no match rather than guessing", () => {
    expect(matchRoutes([route("/doc/:id", "document")], "/settings")).toBeUndefined();
    expect(matchRoutes([], "/")).toBeUndefined();
  });

  it("breaks a tie between equally specific patterns by list order, not `order`", () => {
    const tie: readonly Route[] = [
      route("/x/:a", "first", 200),
      route("/x/:a", "second", 10),
    ];
    expect(matchRoutes(tie, "/x/1")?.view).toBe("first");
    expect(compareSpecificity(tie[0]!, tie[1]!)).toBe(0);
  });

  it("still lets specificity beat list order", () => {
    const routes: readonly Route[] = [route("/x/:a", "generic"), route("/x/1", "exact")];
    expect(matchRoutes(routes, "/x/1")?.view).toBe("exact");
  });

  it("matches the root", () => {
    expect(matchRoutes(routes, "")?.view).toBe("home");
    expect(matchRoutes(routes, "#/")?.view).toBe("home");
  });
});

describe("buildPath", () => {
  it("fills and percent-encodes the slots", () => {
    expect(buildPath("/doc/:id", { id: "01JX" })).toBe("/doc/01JX");
    expect(buildPath("/folder/:path", { path: "home/lists" })).toBe("/folder/home%2Flists");
    expect(buildPath("/settings")).toBe("/settings");
  });

  it("refuses to build a path with a hole in it", () => {
    expect(() => buildPath("/doc/:id")).toThrow(/no value for ":id"/);
    expect(() => buildPath("/doc/:id", { id: "" })).toThrow();
  });

  it("round-trips through matchPath", () => {
    const built = buildPath("/doc/:id", { id: "a b/c" });
    expect(matchPath("/doc/:id", built)).toEqual({ id: "a b/c" });
  });
});
