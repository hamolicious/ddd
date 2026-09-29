/**
 * Writing one frontmatter scalar safely.
 *
 * Only `createDocument` uses it, and only because creating a document is the one moment
 * when authoring the whole text is correct (SPEC §3.3) — every later write is a splice.
 * But "correct" still means producing text the shared core's **strict YAML subset** reads
 * back as the string that went in, and the two ways to get that wrong are quiet:
 *
 * - `title: 2026` types as an **integer**, and a non-string `fm.title` falls through the
 *   title resolver to the body (`backend/crates/core/README.md` §1). The document would be
 *   titled by its first heading instead, which is nearly right and therefore hard to spot.
 * - `title: yes: no` is a `malformed_line`: the key is dropped and `fm_parse_error` is set.
 *
 * Single quotes are used for quoting because the subset documents exactly one escape
 * inside them — `''` is a literal `'` — so there are no backslash rules to guess at.
 *
 * **Except for control characters, where single quotes cannot help.** A single-quoted
 * scalar has no escapes at all, so a value containing a newline is not a quoted scalar —
 * it is one line with an unterminated quote followed by *another frontmatter line*. Since
 * a value written here can come from a document any workspace user can write (SPEC §2),
 * that is an injection: a value of `"home\ntitle: owned"` puts a line the user never
 * typed into the document being created. Those values are
 * double-quoted with escapes instead — the same rule as the kernel's splice serializer
 * (`core::value::to_yaml_inline`), which is the authority both sides follow.
 */

/** The reserved words the subset types as booleans or null. */
const RESERVED = /^(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/;

/** Anything the subset would parse as an int or a float (`1e3` is a float). */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/;

/** Leading characters that start a construct rather than a plain scalar. */
const LEADING = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** `true` when the value contains something no single-quoted scalar can carry. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) as number) < 0x20) return true;
  }
  return false;
}

/** `true` when the value must be quoted to survive a parse round trip. */
export function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (hasControlCharacter(value)) return true;
  if (value !== value.trim()) return true; // leading/trailing space is lost otherwise
  if (LEADING.test(value)) return true;
  if (/:\s/.test(value) || /\s#/.test(value)) return true;
  if (value.endsWith(":")) return true;
  if (RESERVED.test(value)) return true;
  if (NUMERIC.test(value)) return true;
  // A value that looks like a date is *materialized* as a date; as a title that is wrong,
  // and as any other string value it changes the value's type family for filters.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}

/**
 * One frontmatter value, quoted only when it has to be — and **never spanning a line**,
 * whatever the value contains.
 */
export function yamlScalar(value: string): string {
  if (!needsQuoting(value)) return value;
  // A single-quoted scalar has no escape for a newline or a tab, so anything carrying one
  // has to be double-quoted. `value::quote_double`, ported.
  if (hasControlCharacter(value)) {
    let out = '"';
    for (const character of value) {
      const code = character.codePointAt(0) as number;
      if (character === '"') out += '\\"';
      else if (character === "\\") out += "\\\\";
      else if (character === "\n") out += "\\n";
      else if (character === "\r") out += "\\r";
      else if (character === "\t") out += "\\t";
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += character;
    }
    return `${out}"`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}
