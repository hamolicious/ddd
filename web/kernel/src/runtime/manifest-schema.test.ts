import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KERNEL_API_VERSION, validateManifest } from "@kernel";

import { MANIFEST_KERNEL_VERSION } from "../../../kernel-api/src/manifest.generated.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface Fixture {
  readonly name: string;
  readonly manifest: unknown;
  readonly problems: readonly string[];
}

describe("the manifest schema", () => {
  it("passes the shared fixture corpus", () => {
    const fixtures = JSON.parse(readFileSync(join(repo, "schema/fixtures/manifests.json"), "utf8")) as Fixture[];
    expect(fixtures.length).toBeGreaterThan(10);
    for (const fixture of fixtures) {
      const got = validateManifest(fixture.manifest).map((problem) => problem.field).sort();
      expect(got, fixture.name).toEqual([...fixture.problems].sort());
    }
  });

  it("accepts every base and example manifest", () => {
    for (const tree of ["plugins/base", "plugins/examples"]) {
      for (const id of readdirSync(join(repo, tree))) {
        const path = join(repo, tree, id, "manifest.json");
        if (!existsSync(path)) continue;
        const problems = validateManifest(JSON.parse(readFileSync(path, "utf8")));
        expect(problems, path).toEqual([]);
      }
    }
  });

  it("generated the kernel version the bundle reports", () => {
    expect(KERNEL_API_VERSION).toBe(MANIFEST_KERNEL_VERSION);
  });

  it("has up-to-date generated files", () => {
    execFileSync(process.execPath, [join(repo, "web/scripts/gen-manifest.mjs"), "--check"], { stdio: "pipe" });
  });
});
