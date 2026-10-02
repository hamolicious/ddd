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

export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

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
  if ([...trimmed].length === 1) return trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  if (/^f\d{1,2}$/.test(lower)) return `F${lower.slice(1)}`;
  return trimmed;
}

function orderModifiers(found: Iterable<Modifier>): readonly Modifier[] {
  const set = new Set(found);
  return MODIFIER_ORDER.filter((modifier) => set.has(modifier));
}

export function parseChord(input: string): Chord {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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
    if (key !== "") return { modifiers: [], key: "" };
    key = canonicalKey(part);
  }
  if (key === "") return { modifiers: [], key: "" };
  return { modifiers: orderModifiers(modifiers), key };
}

export function formatChordCanonical(chord: Chord): string {
  if (chord.key === "") return "";
  return [...chord.modifiers, chord.key].join("+");
}

export function normalizeKeys(input: string): string {
  const chords = input.trim().replace(/\s*\+\s*/g, "+").split(/\s+/).filter(Boolean);
  if (chords.length === 0) return "";
  const parsed = chords.map(parseChord);
  if (parsed.some((chord) => chord.key === "")) return "";
  return parsed.map(formatChordCanonical).join(" ");
}

export function chordsOf(keys: string): readonly string[] {
  return keys.trim().split(/\s+/).filter(Boolean);
}

export function isBareChord(chord: Chord): boolean {
  return chord.modifiers.every((modifier) => modifier === "Shift");
}

export function eventChord(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & {
    readonly code?: string;
  },
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

  const raw =
    event.key === "Unidentified" || event.key === "Process" ? keyFromCode(event.code) : event.key;
  if (["Control", "Meta", "Shift", "Alt", "CapsLock", "Dead"].includes(raw)) {
    return { modifiers: orderModifiers(modifiers), key: "" };
  }
  const key = raw === " " ? "Space" : canonicalKey(raw);
  return { modifiers: orderModifiers(modifiers), key };
}

function keyFromCode(code: string | undefined): string {
  if (code === undefined || code === "") return "";
  if (code === "Space") return " ";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] as string;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1] as string;
  return code;
}

export function eventKeys(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & {
    readonly code?: string;
  },
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

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (element.isContentEditable) return true;
  return typeof element.closest === "function" && element.closest("[contenteditable=true]") !== null;
}
