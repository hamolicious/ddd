const RESERVED = /^(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/;

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/;

const LEADING = /^[-?:,[\]{}#&*!|>'"%@`]/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) as number) < 0x20) return true;
  }
  return false;
}

export function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (hasControlCharacter(value)) return true;
  if (value !== value.trim()) return true;
  if (LEADING.test(value)) return true;
  if (/:\s/.test(value) || /\s#/.test(value)) return true;
  if (value.endsWith(":")) return true;
  if (RESERVED.test(value)) return true;
  if (NUMERIC.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}

export function yamlScalar(value: string): string {
  if (!needsQuoting(value)) return value;
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
