export interface ShapeIssue {
  readonly path: string;
  readonly expected: string;
  readonly got: string;
}

export type ShapeJson =
  | "string"
  | "number"
  | "boolean"
  | "func"
  | "promise"
  | "component"
  | "any"
  | { readonly literal: readonly (string | number | boolean)[] }
  | { readonly union: readonly ShapeJson[] }
  | { readonly array: ShapeJson }
  | { readonly record: ShapeJson }
  | { readonly object: Readonly<Record<string, ShapeJson>> }
  | { readonly optional: ShapeJson };

export interface Shape<T> {
  readonly name: string;
  check(value: unknown, path?: string): readonly ShapeIssue[];
  toJSON?(): ShapeJson;
  readonly ts?: string;
  readonly doc?: string;
}

export interface BuiltShape<T> extends Shape<T> {
  toJSON(): ShapeJson;
  readonly parts?: {
    readonly fields?: Readonly<Record<string, BuiltShape<unknown>>>;
    readonly item?: BuiltShape<unknown>;
    readonly members?: readonly BuiltShape<unknown>[];
    readonly args?: readonly BuiltShape<unknown>[];
    readonly returns?: BuiltShape<unknown>;
  };
  as(ts: string): BuiltShape<T>;
  describe(doc: string): BuiltShape<T>;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(path: string, expected: string, value: unknown): ShapeIssue {
  return { path, expected, got: typeName(value) };
}

function make<T>(
  name: string,
  check: (value: unknown, path: string) => readonly ShapeIssue[],
  json: () => ShapeJson,
  parts?: BuiltShape<T>["parts"],
  notes: { readonly ts?: string; readonly doc?: string } = {},
): BuiltShape<T> {
  return {
    name,
    check: (value, path = "") => check(value, path),
    toJSON: json,
    ...(parts ? { parts } : {}),
    ...(notes.ts !== undefined ? { ts: notes.ts } : {}),
    ...(notes.doc !== undefined ? { doc: notes.doc } : {}),
    as: (ts) => make<T>(name, check, json, parts, { ...notes, ts }),
    describe: (doc) => make<T>(name, check, json, parts, { ...notes, doc }),
  };
}

const jsonOf = (shape: Shape<unknown>): ShapeJson => shape.toJSON?.() ?? "any";

const primitive = <T>(name: string, json: ShapeJson, test: (value: unknown) => boolean): BuiltShape<T> =>
  make<T>(name, (value, path) => (test(value) ? [] : [issue(path, name, value)]), () => json);

export const anyValue = <T = unknown>(): BuiltShape<T> => make<T>("any", () => [], () => "any");
export const string = (): BuiltShape<string> => primitive("string", "string", (v) => typeof v === "string");
export const number = (): BuiltShape<number> =>
  primitive("number", "number", (v) => typeof v === "number" && Number.isFinite(v));
export const boolean = (): BuiltShape<boolean> => primitive("boolean", "boolean", (v) => typeof v === "boolean");

export const func = <F extends (...args: never[]) => unknown>(
  args?: readonly Shape<unknown>[],
  returns?: Shape<unknown>,
): BuiltShape<F> =>
  make<F>(
    "function",
    (value, path) => (typeof value === "function" ? [] : [issue(path, "function", value)]),
    () => "func",
    args !== undefined || returns !== undefined
      ? {
          ...(args !== undefined ? { args: args as readonly BuiltShape<unknown>[] } : {}),
          ...(returns !== undefined ? { returns: returns as BuiltShape<unknown> } : {}),
        }
      : undefined,
  );

const isThenable = (v: unknown): boolean =>
  (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";

export const promise = <T = unknown>(inner?: Shape<T>): BuiltShape<Promise<T>> =>
  make<Promise<T>>(
    "promise",
    (value, path) => (isThenable(value) ? [] : [issue(path, "promise", value)]),
    () => "promise",
    inner !== undefined ? { item: inner as BuiltShape<unknown> } : undefined,
  );

export const component = <P = unknown>(): BuiltShape<(props: P) => unknown> =>
  primitive("component", "component", (v) => typeof v === "function" || (typeof v === "object" && v !== null));

export const literal = <const V extends string | number | boolean>(...allowed: readonly V[]): BuiltShape<V> =>
  make<V>(
    allowed.map((v) => JSON.stringify(v)).join(" | "),
    (value, path) =>
      allowed.includes(value as V)
        ? []
        : [{ path, expected: allowed.map((v) => JSON.stringify(v)).join(" | "), got: JSON.stringify(value) ?? typeName(value) }],
    () => ({ literal: [...allowed] }),
  );

export const array = <T>(item: Shape<T>): BuiltShape<readonly T[]> =>
  make<readonly T[]>(
    `${item.name}[]`,
    (value, path) => {
      if (!Array.isArray(value)) return [issue(path, "array", value)];
      return value.flatMap((entry, index) => item.check(entry, `${path}[${index}]`));
    },
    () => ({ array: jsonOf(item) }),
    { item: item as BuiltShape<unknown> },
  );

export const optional = <T>(inner: Shape<T>): BuiltShape<T | undefined> =>
  make<T | undefined>(
    `${inner.name}?`,
    (value, path) => (value === undefined ? [] : inner.check(value, path)),
    () => ({ optional: jsonOf(inner) }),
    { item: inner as BuiltShape<unknown> },
  );

export const union = <T>(...members: readonly Shape<unknown>[]): BuiltShape<T> =>
  make<T>(
    members.map((m) => m.name).join(" | "),
    (value, path) =>
      members.some((member) => member.check(value, path).length === 0)
        ? []
        : [issue(path, members.map((m) => m.name).join(" | "), value)],
    () => ({ union: members.map(jsonOf) }),
    { members: members as readonly BuiltShape<unknown>[] },
  );

export const record = <T>(value: Shape<T>): BuiltShape<Readonly<Record<string, T>>> =>
  make<Readonly<Record<string, T>>>(
    `record<${value.name}>`,
    (candidate, path) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return [issue(path, "object", candidate)];
      }
      return Object.entries(candidate).flatMap(([key, entry]) =>
        value.check(entry, path === "" ? key : `${path}.${key}`),
      );
    },
    () => ({ record: jsonOf(value) }),
    { item: value as BuiltShape<unknown> },
  );

type FieldsOf<F extends Record<string, Shape<unknown>>> = {
  -readonly [K in keyof F]: F[K] extends Shape<infer T> ? T : never;
};

export const object = <F extends Record<string, Shape<unknown>>>(fields: F): BuiltShape<FieldsOf<F>> =>
  make<FieldsOf<F>>(
    `{ ${Object.keys(fields).join(", ")} }`,
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [issue(path, "object", value)];
      }
      const bag = value as Record<string, unknown>;
      return Object.entries(fields).flatMap(([key, field]) =>
        field.check(bag[key], path === "" ? key : `${path}.${key}`),
      );
    },
    () => ({ object: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, jsonOf(field)])) }),
    { fields: fields as unknown as Readonly<Record<string, BuiltShape<unknown>>> },
  );

export const s = {
  any: anyValue,
  string,
  number,
  boolean,
  func,
  fn: func,
  promise,
  component,
  literal,
  array,
  optional,
  union,
  record,
  object,
} as const;

export function shapeFromJSON(json: ShapeJson): BuiltShape<unknown> {
  if (typeof json === "string") {
    switch (json) {
      case "string":
        return string();
      case "number":
        return number();
      case "boolean":
        return boolean();
      case "func":
        return func();
      case "promise":
        return promise();
      case "component":
        return component();
      default:
        return anyValue();
    }
  }
  if ("literal" in json) return literal(...json.literal);
  if ("union" in json) return union(...json.union.map(shapeFromJSON));
  if ("array" in json) return array(shapeFromJSON(json.array)) as BuiltShape<unknown>;
  if ("record" in json) return record(shapeFromJSON(json.record)) as BuiltShape<unknown>;
  if ("optional" in json) return optional(shapeFromJSON(json.optional));
  if ("object" in json) {
    return object(Object.fromEntries(Object.entries(json.object).map(([key, field]) => [key, shapeFromJSON(field)]))) as BuiltShape<unknown>;
  }
  return anyValue();
}

export function validate<T>(shape: Shape<T>, value: unknown): readonly ShapeIssue[] {
  return shape.check(value, "");
}

export function formatIssues(issues: readonly ShapeIssue[]): string {
  return issues
    .map((i) => `${i.path === "" ? "value" : i.path}: expected ${i.expected}, got ${i.got}`)
    .join("; ");
}
