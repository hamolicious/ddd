import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- TypeScript resolves this import from this plugin directory.
import { build } from "vite";

// @ts-expect-error -- the reference config is an author-facing .mjs file.
import { pluginConfig } from "./vite.plugin-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Tailwind plugin packaging", () => {
  it("emits unlayered, token-aware utilities without preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "ddd-tailwind-plugin-"));
    roots.push(root);
    const src = join(root, "src");
    const outDir = join(root, "dist");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(src));
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      id: "tailwind-fixture",
      version: "1.0.0",
      "x-tailwind": { prefix: "fixture" },
      frontend: { module: "frontend/index.mjs", style: "frontend/style.css" },
    }));
    writeFileSync(join(src, "index.tsx"), "export default function activate() {}\n");
    writeFileSync(join(src, "view.tsx"), [
      "export const View = () => <button className=\"fixture:flex fixture:gap-2 fixture:rounded-lg fixture:bg-accent fixture:p-4 fixture:tap fixture:compact:tap-h hidden\" />;",
    ].join("\n"));
    writeFileSync(join(src, "style.css"), ".fixture-root { color: var(--ddd-text); }\n");

    await build(pluginConfig({ root, outDir, tailwind: true, resolveFrom: join(process.cwd(), "web") }));

    const css = readFileSync(join(outDir, "frontend/style.css"), "utf8");
    expect(css).not.toContain("@layer");
    expect(css).not.toMatch(/(^|[,{\s])button\s*[{,:]/m);
    expect(css).toContain("var(--ddd-accent)");
    expect(css).toMatch(/\.fixture\\:p-4\s*\{\s*padding:\s*calc\(calc\(var\(--ddd-space\)\s*\*\s*0?\.5\)\s*\*\s*4\)/);
    expect(css).toContain(".fixture\\:tap");
    expect(css).not.toMatch(/(^|[},\s])\.hidden\s*\{/);
    const rootBlocks = css.match(/:root[^{}]*\{[^}]*\}/g) ?? [];
    expect(rootBlocks.join("\n").match(/--[^:]+:/g)?.length ?? 0).toBeLessThan(10);
  });
});
