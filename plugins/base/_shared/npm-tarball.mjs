import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    execFileSync("npm", ["pack", spec, "--json", "--pack-destination", cache], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  )[0].filename;
  const packedFile = join(cache, packed.replace(/^@/, "").replace(/\//g, "-"));
  if (packedFile !== file) copyFileSync(packedFile, file);
  if (!matches()) throw new Error(`${spec}: the tarball does not match the integrity pinned in ${pinnedIn}`);
  return file;
}

export function extract(tarball, path) {
  try {
    return execFileSync("tar", ["-xzOf", tarball, `package/${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`${tarball}: has no ${path}`);
  }
}
