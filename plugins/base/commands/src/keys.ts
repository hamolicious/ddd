/**
 * Chord parsing, normalization and formatting.
 *
 * Pure functions, no React, no kernel — which is the point: the one part of
 * keybindings that is easy to get subtly wrong (is `Ctrl+k` the same binding as
 * `Mod+K`? what does `Meta` mean on Linux?) is also the one part that can be pinned
 * by unit tests without a DOM.
 *
 * **The canonical spelling.** `Mod+Shift+K`: modifiers first in a fixed order
 * (`Mod`, `Ctrl`, `Meta`, `Shift`, `Alt`), then exactly one key, joined by `+`. A
 * *sequence* is chords separated by spaces (`g d`) — Vim-style prefixes, which is
 * why the resolver has to keep a pending prefix rather than matching one event.
 *
 * **`Mod` is the portable modifier** (SPEC §6.5 / `_shared/points.ts`): Cmd on Apple
 * platforms, Ctrl everywhere else. A contribution spelling `Ctrl+K` gets literal
 * Ctrl on a Mac, which is almost never what the author meant — so `Mod` is what the
 * base distribution contributes, and `normalizeChord` keeps both spellings distinct
 * rather than quietly folding one into the other.
 */

/** Modifier order in the canonical spelling. */
const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Shift", "Alt"] as const;

export type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  mod: "Mod",
  cmdorctrl: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
};

/**
 * Key spellings that differ between `KeyboardEvent.key` and how a human writes a
 * binding. Everything not in here is passed through with its first letter upper-cased
 * for single characters and verbatim for named keys.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  plus: "+",
};

/** One parsed chord. `key` is `""` when the chord failed to parse. */
export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

/** Cmd on Apple platforms, Ctrl elsewhere. Read once per call; cheap and testable. */
export function isApplePlatform(navigatorLike?: {
  platform?: string;
  userAgent?: string;
}): boolean {
  const nav =
    navigatorLike ??
    (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  if (!nav) return false;
  return /mac|iphone|ipad|ipod/i.test(`${nav.platform ?? ""} ${nav.userAgent ?? ""}`);
}

function canonicalKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  // A single character is case-insensitive as a *binding* — `Shift` is spelled out,
  // never implied by capitalization, or `Mod+?` and `Mod+/` would be one binding on
  // some layouts and two on others.
  if ([...trimmed].length === 1) return trimmed.toUpperCase();
  // A named key (`F5`, `ArrowUp`, `AudioVolumeUp`) in whatever case it was written.
  const lower = trimmed.toLowerCase();
  if (/^f\d{1,2}$/.test(lower)) return `F${lower.slice(1)}`;
  return trimmed;
}

/** Sort and de-duplicate modifiers into the canonical order. */
function orderModifiers(found: Iterable<Modifier>): readonly Modifier[] {
  const set = new Set(found);
  return MODIFIER_ORDER.filter((modifier) => set.has(modifier));
}

/**
 * Parse one chord. Returns `{key: ""}` for anything unusable (no key, two keys, an
 * unknown modifier) — the caller treats that as "not a binding" rather than throwing,
 * because the input can come from a plugin's manifest or a user's settings document.
 */
export function parseChord(input: string): Chord {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // `Mod++` means "Mod and the + key": the split above drops the empty part, so a
  // trailing `+` in the original is re-attached here.
  if (/\+\s*$/.test(input.trimEnd()) && parts.length > 0) parts.push("+");
  if (parts.length === 0) return { modifiers: [], key: "" };

  const modifiers: Modifier[] = [];
  let key = "";
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.push(modifier);
      continue;
    }
    if (key !== "") return { modifiers: [], key: "" }; // two keys in one chord
    key = canonicalKey(part);
  }
  if (key === "") return { modifiers: [], key: "" };
  return { modifiers: orderModifiers(modifiers), key };
}

/** The canonical spelling of a chord; `""` for an unparseable one. */
export function formatChordCanonical(chord: Chord): string {
  if (chord.key === "") return "";
  return [...chord.modifiers, chord.key].join("+");
}

/**
 * Canonicalize a whole binding (chord or sequence). Returns `""` when any chord in
 * it is unusable, so an invalid binding can never half-register.
 */
export function normalizeKeys(input: string): string {
  // Whitespace separates *chords*, so `Ctrl + K` would otherwise read as a
  // three-chord sequence. Space around a `+` belongs to the `+`, not to the sequence.
  const chords = input.trim().replace(/\s*\+\s*/g, "+").split(/\s+/).filter(Boolean);
  if (chords.length === 0) return "";
  const parsed = chords.map(parseChord);
  if (parsed.some((chord) => chord.key === "")) return "";
  return parsed.map(formatChordCanonical).join(" ");
}

/** Split a canonical binding into its chords. */
export function chordsOf(keys: string): readonly string[] {
  return keys.trim().split(/\s+/).filter(Boolean);
}

/** A chord with no modifier other than Shift is a plain keystroke — see {@link isTypingTarget}. */
export function isBareChord(chord: Chord): boolean {
  return chord.modifiers.every((modifier) => modifier === "Shift");
}

/** What the event's modifier keys spell, honouring the platform's `Mod`. */
export function eventChord(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  apple = isApplePlatform(),
): Chord {
  const modifiers: Modifier[] = [];
  if (apple) {
    if (event.metaKey) modifiers.push("Mod");
    if (event.ctrlKey) modifiers.push("Ctrl");
  } else {
    if (event.ctrlKey) modifiers.push("Mod");
    if (event.metaKey) modifiers.push("Meta");
  }
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");

  const raw = event.key;
  // A modifier keydown on its own is not a chord; the resolver waits for a real key.
  if (["Control", "Meta", "Shift", "Alt", "CapsLock", "Dead"].includes(raw)) {
    return { modifiers: orderModifiers(modifiers), key: "" };
  }
  const key = raw === " " ? "Space" : canonicalKey(raw);
  return { modifiers: orderModifiers(modifiers), key };
}

/** The canonical spelling of the chord an event produced; `""` for a modifier-only event. */
export function eventKeys(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  apple = isApplePlatform(),
): string {
  return formatChordCanonical(eventChord(event, apple));
}

const APPLE_SYMBOLS: Readonly<Record<Modifier, string>> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Meta: "⌘",
  Shift: "⇧",
  Alt: "⌥",
};

const KEY_SYMBOLS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Escape: "Esc",
  Space: "Space",
};

/**
 * How a binding is shown to a human. On Apple platforms the symbols people expect;
 * everywhere else the words, because `⌃⇧K` on Windows means nothing to anybody.
 */
export function formatKeys(keys: string, apple = isApplePlatform()): string {
  const chords = chordsOf(keys);
  if (chords.length === 0) return "";
  return chords
    .map((chord) => {
      const parsed = parseChord(chord);
      if (parsed.key === "") return chord;
      const key = KEY_SYMBOLS[parsed.key] ?? parsed.key;
      if (apple) return [...parsed.modifiers.map((m) => APPLE_SYMBOLS[m]), key].join("");
      return [...parsed.modifiers.map((m) => (m === "Mod" ? "Ctrl" : m)), key].join("+");
    })
    .join(" ");
}

/**
 * Is the event happening inside something the user is typing into?
 *
 * A bare chord (nothing but Shift) must never steal a keystroke from an editor — the
 * `editor` plugin is a text surface and `N` is a letter there, not "new document".
 * Chords *with* a modifier are still delivered, which is what makes `Mod+K` work from
 * inside CodeMirror.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (element.isContentEditable) return true;
  return typeof element.closest === "function" && element.closest("[contenteditable=true]") !== null;
}
