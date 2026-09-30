/**
 * Binding resolution: contributed defaults + the user's overrides → one map, plus
 * the list of conflicts nobody resolved.
 *
 * The three rules are SPEC §6.5's, and they are implemented here rather than in the
 * UI so they can be tested without a keyboard:
 *
 * 1. **Per-user configuration wins.** A plugin contributes a *suggestion*; the user's
 *    settings document is the truth. An override to the empty string means "unbound" —
 *    the user actively took the binding away, which is different from never setting one.
 * 2. **The first added wins between plugins**, in the order the registry hands defaults
 *    over (plugins activate after their dependencies). The loser is *not*
 *    silently dropped: it lands in {@link ResolvedBindings.conflicts} so the settings
 *    section can show both and let the user pick.
 * 3. **One binding, one command.** A chord that two commands claim runs the winner
 *    only. The alternative — running both — is how you delete a document by pressing
 *    the palette shortcut.
 *
 * Overrides are stored as a `list` settings value, one `command=keys` string per
 * entry, because settings are YAML lines in a `%%%` section (SPEC §3.3) and a flat
 * list of scalars is what that medium holds. It also merges well: two devices
 * rebinding two different commands produce two different lines.
 */

import { normalizeKeys } from "./keys.js";
import type { KeybindingDefault } from "./api.js";

/** Two or more claims on one chord. `winner` is the one that is actually bound. */
export interface BindingConflict {
  readonly keys: string;
  /** Every claimant, in the order they were considered; `commands[0]` is the winner. */
  readonly commands: readonly string[];
  readonly winner: string;
  /** `true` when the winner is a user override rather than a contributed default. */
  readonly userWon: boolean;
}

export interface ResolvedBindings {
  /** Effective binding per command id. Missing ⇒ the command has no binding. */
  readonly byCommand: ReadonlyMap<string, string>;
  /** Effective command per chord/sequence. */
  readonly byKeys: ReadonlyMap<string, string>;
  /** Every chord that is the *prefix* of a longer sequence, for the pending-chord state. */
  readonly prefixes: ReadonlySet<string>;
  readonly conflicts: readonly BindingConflict[];
  /** What the user set, normalized. An empty value means "explicitly unbound". */
  readonly overrides: ReadonlyMap<string, string>;
}

/**
 * Parse the stored `list` value. Tolerant on purpose: this comes out of a text
 * document a human can edit, and one bad line must not cost the user every binding.
 * An unparseable binding is dropped (the default applies again), not guessed at.
 */
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
    // `command=` is a deliberate unbind and survives; anything else must normalize.
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

/** The stored form of an override map: sorted, so the settings document is stable. */
export function serializeOverrides(overrides: ReadonlyMap<string, string>): readonly string[] {
  return [...overrides]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([command, keys]) => `${command}=${keys}`);
}

/** Every chord prefix of a sequence: `g d` contributes `g`. */
function collectPrefixes(keys: string, into: Set<string>): void {
  const chords = keys.split(" ").filter(Boolean);
  for (let index = 1; index < chords.length; index += 1) {
    into.add(chords.slice(0, index).join(" "));
  }
}

/**
 * Resolve the effective bindings.
 *
 * `defaults` must arrive in registry order — that ordering *is* rule 2, and sorting it
 * here would make "the first added wins" mean something else.
 */
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

  // The user's own bindings go first, so a rebind always beats every default —
  // including one the user's chord collides with.
  for (const [command, keys] of overrides) {
    if (keys === "") continue;
    claim(keys, command, true);
  }

  for (const entry of defaults) {
    const command = entry.command;
    // An override (a rebind *or* an unbind) replaces this plugin's suggestion whole.
    if (overrides.has(command)) continue;
    // One command keeps one binding: a second suggestion for the same command is a
    // duplicate contribution, not an alternative chord.
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
