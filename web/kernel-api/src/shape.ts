/**
 * Minimal runtime shape validation for extension points (SPEC §6.4: "schema =
 * minimal runtime shape validation, rejects loudly").
 *
 * Deliberately not a schema library. It answers one question — "does this
 * contribution have the fields the point promised?" — with a path and an
 * expectation per failure, and it costs no dependency and no bundle weight. It
 * validates *shape*, never semantics: a `navbar.item` with an `id` of `""` is
 * shape-valid and the shell's problem.
 *
 * **FROZEN.**
 */

export interface ShapeIssue {
  /** Dotted path into the contributed value; `""` is the value itself. */
  readonly path: string;
  readonly expected: string;
  readonly got: string;
}

/**
 * A shape check for values of `T`.
 *
 * `T` is documentation and the type `definePoint` binds — there is deliberately no
 * phantom field carrying it, so a `Shape` built with `s.object({ icon: s.any() })`
 * can still be handed to a point whose type says `icon?: ReactNode`. Validation is a
 * runtime floor (SPEC §6.4: *minimal* shape validation); the compiler's opinion of a
 * contribution comes from the point's own type, not from the validator.
 */
export interface Shape<T> {
  readonly name: string;
  /** Empty array ⇒ valid. */
  check(value: unknown, path?: string): readonly ShapeIssue[];
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(path: string, expected: string, value: unknown): ShapeIssue {
  return { path, expected, got: typeName(value) };
}

function make<T>(name: string, check: (value: unknown, path: string) => readonly ShapeIssue[]): Shape<T> {
  return { name, check: (value, path = "") => check(value, path) };
}

const primitive = <T>(name: string, test: (value: unknown) => boolean): Shape<T> =>
  make<T>(name, (value, path) => (test(value) ? [] : [issue(path, name, value)]));

export const anyValue = <T = unknown>(): Shape<T> => make<T>("any", () => []);
export const string = (): Shape<string> => primitive("string", (v) => typeof v === "string");
export const number = (): Shape<number> =>
  primitive("number", (v) => typeof v === "number" && Number.isFinite(v));
export const boolean = (): Shape<boolean> => primitive("boolean", (v) => typeof v === "boolean");

export const func = <F extends (...args: never[]) => unknown>(): Shape<F> =>
  primitive("function", (v) => typeof v === "function");

/**
 * A React component: a function, or an object produced by `memo`/`forwardRef`/
 * `lazy`. Checked structurally so the kernel never imports React at runtime.
 */
export const component = <P = unknown>(): Shape<(props: P) => unknown> =>
  primitive("component", (v) => typeof v === "function" || (typeof v === "object" && v !== null));

export const literal = <const V extends string | number | boolean>(...allowed: readonly V[]): Shape<V> =>
  make<V>(
    allowed.map((v) => JSON.stringify(v)).join(" | "),
    (value, path) =>
      allowed.includes(value as V)
        ? []
        : [{ path, expected: allowed.map((v) => JSON.stringify(v)).join(" | "), got: JSON.stringify(value) ?? typeName(value) }],
  );

export const array = <T>(item: Shape<T>): Shape<readonly T[]> =>
  make<readonly T[]>(`${item.name}[]`, (value, path) => {
    if (!Array.isArray(value)) return [issue(path, "array", value)];
    return value.flatMap((entry, index) => item.check(entry, `${path}[${index}]`));
  });

export const optional = <T>(inner: Shape<T>): Shape<T | undefined> =>
  make<T | undefined>(`${inner.name}?`, (value, path) =>
    value === undefined ? [] : inner.check(value, path),
  );

export const union = <T>(...members: readonly Shape<unknown>[]): Shape<T> =>
  make<T>(
    members.map((m) => m.name).join(" | "),
    (value, path) =>
      members.some((member) => member.check(value, path).length === 0)
        ? []
        : [issue(path, members.map((m) => m.name).join(" | "), value)],
  );

export const record = <T>(value: Shape<T>): Shape<Readonly<Record<string, T>>> =>
  make<Readonly<Record<string, T>>>(`record<${value.name}>`, (candidate, path) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return [issue(path, "object", candidate)];
    }
    return Object.entries(candidate).flatMap(([key, entry]) =>
      value.check(entry, path === "" ? key : `${path}.${key}`),
    );
  });

type FieldsOf<F extends Record<string, Shape<unknown>>> = {
  -readonly [K in keyof F]: F[K] extends Shape<infer T> ? T : never;
};

/**
 * An object with the named fields. **Unknown keys are allowed** — a plugin may
 * carry its own extra data on a contribution, and a point that rejected extras
 * would make every point addition a breaking change for contributors.
 */
export const object = <F extends Record<string, Shape<unknown>>>(fields: F): Shape<FieldsOf<F>> =>
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
  );

/** Convenience: the namespace spelling base plugins use (`s.object({ … })`). */
export const s = {
  any: anyValue,
  string,
  number,
  boolean,
  func,
  component,
  literal,
  array,
  optional,
  union,
  record,
  object,
} as const;

export function validate<T>(shape: Shape<T>, value: unknown): readonly ShapeIssue[] {
  return shape.check(value, "");
}

/** One human-readable line per issue, for the error the kernel throws. */
export function formatIssues(issues: readonly ShapeIssue[]): string {
  return issues
    .map((i) => `${i.path === "" ? "value" : i.path}: expected ${i.expected}, got ${i.got}`)
    .join("; ");
}
