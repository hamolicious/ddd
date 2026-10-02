import { normalizeKeys } from "./keys.js";
import type { KeybindingDefault } from "./api.js";

export interface BindingConflict {
  readonly keys: string;
  readonly commands: readonly string[];
  readonly winner: string;
  readonly userWon: boolean;
}

export interface ResolvedBindings {
  readonly byCommand: ReadonlyMap<string, string>;
  readonly byKeys: ReadonlyMap<string, string>;
  readonly prefixes: ReadonlySet<string>;
  readonly conflicts: readonly BindingConflict[];
  readonly overrides: ReadonlyMap<string, string>;
}

export function parseOverrides(raw: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const command = item.slice(0, index).trim();
    const spelling = item.slice(index + 1).trim();
    if (command === "") continue;
    if (spelling === "") {
      entries.set(command, "");
      continue;
    }
    const keys = normalizeKeys(spelling);
    if (keys === "") continue;
    entries.set(command, keys);
  }
  return entries;
}

export function serializeOverrides(overrides: ReadonlyMap<string, string>): readonly string[] {
  return [...overrides]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([command, keys]) => `${command}=${keys}`);
}

function collectPrefixes(keys: string, into: Set<string>): void {
  const chords = keys.split(" ").filter(Boolean);
  for (let index = 1; index < chords.length; index += 1) {
    into.add(chords.slice(0, index).join(" "));
  }
}

export function resolveBindings(
  defaults: readonly KeybindingDefault[],
  overrides: ReadonlyMap<string, string>,
): ResolvedBindings {
  const byCommand = new Map<string, string>();
  const byKeys = new Map<string, string>();
  const claims = new Map<string, string[]>();
  const userWinners = new Set<string>();
  const prefixes = new Set<string>();

  const claim = (keys: string, command: string, fromUser: boolean): void => {
    const existing = claims.get(keys);
    if (existing) {
      if (!existing.includes(command)) existing.push(command);
      return;
    }
    claims.set(keys, [command]);
    byKeys.set(keys, command);
    byCommand.set(command, keys);
    collectPrefixes(keys, prefixes);
    if (fromUser) userWinners.add(keys);
  };

  for (const [command, keys] of overrides) {
    if (keys === "") continue;
    claim(keys, command, true);
  }

  for (const entry of defaults) {
    const command = entry.command;
    if (overrides.has(command)) continue;
    if (byCommand.has(command)) continue;
    const keys = normalizeKeys(entry.keys);
    if (keys === "") continue;
    claim(keys, command, false);
  }

  const conflicts: BindingConflict[] = [];
  for (const [keys, commands] of claims) {
    if (commands.length < 2) continue;
    const winner = commands[0] as string;
    conflicts.push({ keys, commands, winner, userWon: userWinners.has(keys) });
  }
  conflicts.sort((a, b) => (a.keys < b.keys ? -1 : a.keys > b.keys ? 1 : 0));

  return { byCommand, byKeys, prefixes, conflicts, overrides };
}
