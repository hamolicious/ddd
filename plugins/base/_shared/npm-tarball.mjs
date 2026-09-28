/**
 * npm packages as build inputs, without installing them.
 *
 * A plugin's `build.mjs` that ships files out of an npm package (grammars, icon data) pins
 * the package's version and `integrity` in a JSON file of its own, and gets the tarball
 * from here: `npm pack`, so no install script runs, checked against the pin, and kept in
 * `node_modules/.cache` so a rebuild does not touch the network.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The tarball of `spec` (`name@version`) in `cache`, packed unless one with the pinned
 * integrity is already there. `pinnedIn` names the file the pin lives in, for the errors.
 */
export function fetchTarball(spec, integrity, cache, pinnedIn) {
  const [algorithm, expected] = String(integrity ?? "").split("-", 2);
  if (!algorithm || !expected) throw new Error(`${spec}: ${pinnedIn} pins no integrity`);
  mkdirSync(cache, { recursive: true });
  const name = `${spec.replace(/^@/, "").replace(/[/@]/g, "-")}.tgz`;
  const file = join(cache, name);
  const matches = () =>
    existsSync(file) && createHash(algorithm).update(readFileSync(file)).digest("base64") === expected;
  if (matches()) return file;

  const packed = JSON.parse(
    // `--json` lists every file in the package: megabytes for an icon set.
    execFileSync("npm", ["pack", spec, "--json", "--pack-destination", cache], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  )[0].filename;
  // npm names scoped tarballs `scope-name-version.tgz`; ours is the same shape, but be exact.
  const packedFile = join(cache, packed.replace(/^@/, "").replace(/\//g, "-"));
  if (packedFile !== file) copyFileSync(packedFile, file);
  if (!matches()) throw new Error(`${spec}: the tarball does not match the integrity pinned in ${pinnedIn}`);
  return file;
}

/** One file out of an npm tarball. */
export function extract(tarball, path) {
  try {
    return execFileSync("tar", ["-xzOf", tarball, `package/${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`${tarball}: has no ${path}`);
  }
}
