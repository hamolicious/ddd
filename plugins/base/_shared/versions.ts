function versionParts(version: string): { readonly core: readonly number[]; readonly pre: string } {
  const [main = "", pre = ""] = version.trim().replace(/^v/i, "").split("+")[0]!.split(/-(.*)/s);
  return { core: main.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}
