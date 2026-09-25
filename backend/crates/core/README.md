# `life-manager-core` — the shared core

Everything in this crate runs **identically on the server and in the client
kernel** (compiled to `wasm32`). Parity between offline and online behaviour is by
construction: one implementation, two build targets (SPEC §2, §3.4, §4.2).
`corpus/` is the regression net that keeps it honest.

Three build shapes:

```
cargo test  -p life-manager-core                        # native, `mongo` feature on
cargo check -p life-manager-core --no-default-features  # the Wasm shape (no bson)
mise run wasm                                           # wasm32 + wasm-bindgen + smoke test
```

`bson` is only reachable from `filter::mongo`, behind the `mongo` feature.

## The client ABI (`src/wasm.rs`, feature `wasm`)

`mise run wasm` builds this crate for `wasm32-unknown-unknown` and runs
wasm-bindgen over it, writing `web/kernel/src/wasm/pkg/`. Five exports, JSON in and
out:

| Export | Returns |
|---|---|
| `parse_document(text)` | `{ title, fm, plugins, fm_parse_error }` as a JSON string |
| `evaluate_filter(filter_json, doc_json)` | `bool` — `false` for bad input *and* for an evaluation error, matching what the server's compiled query does with such a row |
| `core_semantics_version()` | `CORE_SEMANTICS_VERSION`, compared against the sync handshake |
| `normalize_date(input)` | the canonical date form, so client-side sorting matches |
| `resolve_title(text)` | the resolved title without a full parse round trip |

**Filter compilation is deliberately absent**: compiling to Mongo needs `bson` and
belongs to the server (SPEC §4.2). The TypeScript half of the contract is
`web/kernel/src/wasm/core-wasm.d.ts`; the two change together. JSON strings rather
than `JsValue` trees keep the boundary loggable and drop a dependency.

Three properties every function here holds to:

- **Total.** Any input, however malformed, produces an answer. Parsing never
  errors; it drops the offending line and records a `Diagnostic`.
- **Deterministic.** The same bytes give the same result on both sides, always.
  No locale, no clock, no hashing that varies by target.
- **Stateless per line.** Frontmatter and `%%%` bodies are parsed one line at a
  time, with no indentation state and no look-behind, so a mid-edit broken quote
  can never make client and server disagree about the *rest* of the block.

---

## 1. Document layout

A document is one string with three regions (SPEC §3.1):

```markdown
---
title: Groceries
path: home/lists
---

# Groceries

- [ ] milk

%%% calendar
source-uid: abc123@google.com
%%%
```

`document::parse_document` returns all three, plus everything materialized from
them: `fm`, `plugins`, `title`, `fm_parse_error`, `diagnostics`.

### Normalization

Before anything else (`document::normalize_input`): a leading UTF-8 BOM is
stripped, `\r\n` and lone `\r` become `\n`. Nothing else is touched. Spans in a
`ParsedDocument` are byte offsets into the **normalized** text.

### Frontmatter fences — byte-exact

- Opens only if the literal first line is `---`. Not `--- `, not a blank line
  first, not a BOM-less variant after normalization.
- Closes at the next line that is exactly `---`.
- Never closed ⇒ **there is no frontmatter at all**; an `unterminated_fence`
  diagnostic is recorded and `fm_parse_error` is set.
- `outer` covers both fence lines; `inner` covers the lines between them.

### Machine-section fences — byte-exact

- Opening fence: exactly `%%% ` followed by a plugin id matching
  `^[A-Za-z0-9_-]{1,64}$` and nothing else. Closing fence: exactly `%%%`.
  Trailing whitespace on a fence line means it is **not** a fence.
- Only the **last contiguous run** of fences at the end of the document counts.
  Everything before it is body text — including earlier, well-formed-looking
  fences.
- Blank lines are tolerated between sections of the run and after the final
  closing fence; they belong to the run region, not to the body.
- A closing fence with no opening fence before it ends the run (everything
  further up is body).
- Two sections with the same plugin id merge into one `plugins` entry, the later
  section winning per key; `Sections::get` returns the later one, and that is
  what a splice writes to.

### Title resolution

`fm.title` (a non-empty **string** after trimming) → first ATX heading → first
non-empty body line → `"Untitled"`.

- An ATX heading is `#`…`######` at column 0 followed by a space or tab; a
  trailing `#` closing sequence is stripped; an empty heading is skipped.
- Both body-derived sources are truncated to 120 characters. `fm.title` is used
  verbatim — it is already bounded by the 8 KB string cap.
- A non-string `fm.title` (e.g. `title: 2026`, which types as an integer) falls
  through to the body.

---

## 2. The strict YAML subset

Supported: a **block mapping of top-level `key: value` lines**, with scalars and
**flow** collections as values.

```yaml
title: Groceries          # string
count: 3                  # int
ratio: 1.5                # float (1e3 is a float too)
done: true                # bool  (true/True/TRUE, false/False/FALSE)
owner: null               # null  (null/Null/NULL, ~, or an empty value)
tags: [work, home]        # flow sequence
meta: {a: 1, b: [x, y]}   # flow mapping
quoted: "12"              # string, not an int
apostrophe: 'it''s'       # single quotes: '' is a literal '
```

Explicitly **not** supported (each is a dropped line plus a diagnostic):

| Construct | Example | Diagnostic |
|---|---|---|
| Indented / nested block mappings | `  sub: 1` | `malformed_line` |
| Block sequences | `- item` | `unsupported_feature` |
| Anchors / aliases / tags | `&a`, `*a`, `!!str` | `unsupported_feature` |
| Block scalars | `key: \|`, `key: >` | `unsupported_feature` |
| Merge keys | `<<: other` | `unsupported_feature` |
| Multi-document markers | `---`, `...` inside a block | `unsupported_feature` |
| `key:value` without a space | `title:X` | `malformed_line` |
| Unterminated quote or bracket | `a: "half`, `a: [1, 2` | `invalid_value` |

**Nesting comes from flow collections, not indentation.** That is what makes the
parser genuinely per-line and stateless, and it is why `MAX_NESTING_DEPTH`
applies to `[...]` / `{...}` nesting.

Other line rules:

- A line whose first non-space character is `#` is a comment and is skipped
  silently. In an unquoted value, ` #` starts a trailing comment; inside quotes
  `#` is literal.
- Keys must match `^[A-Za-z0-9_-]{1,64}$`. A non-conforming key is **dropped
  from `fm`, and the text is left untouched** — `fm_parse_error` is set.
- **Duplicate keys: last occurrence wins.** This is a defined resolution rule
  (it is how per-key LWW is reconstructed on plain text, SPEC §3.3), so it emits
  a `duplicate_key` diagnostic but does **not** set `fm_parse_error`.

### Hardening caps (`limits.rs`)

| Cap | Value | On breach |
|---|---|---|
| `MAX_FRONTMATTER_BYTES` | 64 KiB | the whole block is skipped; `fm` empty |
| `MAX_FRONTMATTER_KEYS` | 200 | further **new** keys are dropped |
| `MAX_NESTING_DEPTH` | 5 | the line is dropped |
| `MAX_ARRAY_ITEMS` | 1000 | the line is dropped |
| `MAX_STRING_VALUE_BYTES` | 8 KiB | the line is dropped |
| `MAX_MACHINE_SECTIONS` | 64 | later sections are dropped |
| `MAX_SECTION_BYTES` | 64 KiB | that section materializes no keys |
| `MAX_SECTION_KEYS` | 200 | further **new** keys are dropped |
| `MAX_DOCUMENT_BYTES` | 1 MiB | splices refuse with `DocumentTooLarge` |

Every breach is a `limit_exceeded` diagnostic. The document **text** is never
modified by a cap — only what gets materialized.

---

## 3. Dates

ISO-8601, normalized to canonical form **at materialization** so lexicographic
sort is correct (SPEC §3.4). There are exactly two canonical shapes:

```
YYYY-MM-DD                    DatePrecision::Date
YYYY-MM-DDTHH:MM:SS.sssZ      DatePrecision::DateTime   (always UTC, always 3 fraction digits)
```

`Date::parse` accepts a little more and normalizes it: `T`, `t` or a space as
the separator; seconds optional; `Z`, `±HH:MM`, `±HHMM`, `±HH` or nothing (= UTC)
as the offset; fractional seconds of 1–9 digits, **truncated** to milliseconds.
Calendar validity is enforced (`2026-02-30` does not parse). Range:
`0000-01-01` … `9999-12-31`.

Any frontmatter or section string that parses as a date is rewritten to its
canonical form in `fm` / `plugins`. **The document text is never rewritten.**

Both canonical shapes are fixed-width and UTC-normalized, so:

> byte-wise lexicographic order over canonical text **==** chronological order

That single property is what lets Mongo compare stored date strings and still
agree with the in-memory evaluator. `Ord for Date` is `(epoch, precision)`,
which is the same order.

---

## 4. The filter DSL

Ours, not Mongo's (SPEC §4.2): same-type comparisons only, explicit
`contains`/`any` for arrays, explicit `missing` vs `null`, an explicit date type.

- `filter::evaluator::evaluate` runs it over a projection `Row` — on the client
  over IndexedDB rows, on the server over rows read from Mongo.
- `filter::mongo::compile` turns it into a Mongo `find` query.
- **The contract: those two return the same rows.** `corpus/filters.json` runs
  every case through both — the compiled query against a miniature Mongo
  interpreter in `tests/common/mod.rs` that reproduces the behaviours the
  compiler has to defend against.

### Wire form

Tagged JSON, one object per node; it is exactly what `serde` produces for the
`Filter` enum, so `to_json` / `from_json` round-trip.

```json
{"and": [
  {"cmp": {"field": "fm.status", "op": "eq", "value": {"str": "open"}}},
  {"contains": {"field": "fm.tags", "value": {"str": "work"}}},
  {"cmp": {"field": "updated_at", "op": "gte", "value": {"date": "2026-01-01"}}},
  {"not": {"missing": {"field": "fm.due"}}}
]}
```

**Nodes**

| Node | Shape | Meaning |
|---|---|---|
| `"all"` | string | every row |
| `"none"` | string | no row |
| `and` / `or` | `[Filter, …]` | conjunction / disjunction (`and: []` = all, `or: []` = none) |
| `not` | `Filter` | complement |
| `cmp` | `{field, op, value}` | scalar comparison |
| `in` | `{field, values: [Literal, …]}` | `eq` against any of them |
| `contains` | `{field, value}` | the field is a list containing this scalar |
| `any` | `{field, op, value}` | some element of the list compares true |
| `every` | `{field, op, value}` | every element does (vacuously true on `[]`) |
| `missing` | `{field}` | the field is absent |
| `is_null` | `{field}` | the field is present and null |
| `exists` | `{field}` | the field is present (null included) |
| `text` | `{field, mode, value}` | case-insensitive `contains` / `starts_with` / `ends_with` |

`op` ∈ `eq`, `ne`, `lt`, `lte`, `gt`, `gte`. `mode` ∈ `contains`, `starts_with`,
`ends_with`.

**Literals** are tagged: `{"bool": true}`, `{"int": 3}`, `{"float": 1.5}`,
`{"str": "x"}`, `{"date": "2026-01-01"}`, and the bare string `"null"`. A date
literal must parse, or the filter is rejected.

**Field paths** are dotted:

| Root | Type | Stored as |
|---|---|---|
| `id` | string | `_id` |
| `title`, `content` | string | same name |
| `created_at`, `updated_at` | date | same name, a BSON date |
| `deleted_at` | date | same name, a BSON date — **absent** on a live document |
| `deleted` | bool | derived from `deleted_at` |
| `fm.<key>[.<key>…]` | dynamic | `fm.…` |
| `plugins.<plugin-id>[.<key>…]` | dynamic | `plugins.…` |

Fixed roots take exactly one segment; `fm` / `plugins` take at least two, each
further segment matching the key regex, at most 7 segments total. Anything else
is a parse error — which is also why a field path can never inject Mongo
operator syntax.

Limits: depth ≤ 16, nodes ≤ 256, `in` literals all of one type family.

### Semantics, precisely

**Type families.** `null`, `bool`, `number` (int **and** float together), `str`,
`date`, `list`, `map`. "Same-type comparison" means same *family*, which is why
`fm.n > 1` matches both `1.5` and `2`. This matches Mongo's comparison
bracketing, which is what makes the two implementations agree.

**Missing never matches.** Not `eq`, not `ne`, not `lt`. Only `missing` matches
an absent field. `null` is a present value and is matched by `is_null`,
`exists` and `eq null` — never by `missing`.

**`ne` is "present and not `eq`".** So `fm.status != "open"` matches a row whose
`fm.status` is `5` (present, not equal), and does not match a row with no
`fm.status` at all.

**No implicit array matching, ever.** `cmp` against a list field is false, in
both directions; use `contains` / `any` / `every`. Conversely `contains` against
a non-list field is false. The compiler adds `{$not: {$type: "array"}}` to every
scalar comparison to suppress Mongo's implicit traversal.

**Dynamic fields never error; fixed columns do.** A value under `fm`/`plugins`
whose type differs from the literal's simply does not match — heterogeneous
workspaces are normal, and one odd row must not fail a whole query. But
`title`/`id`/`content` are strings, `deleted` is a bool and
`created_at`/`updated_at`/`deleted_at` are dates by schema, so a mismatch there is a query
bug: `EvalError::TypeMismatch` in the evaluator and `CompileError::Unsupported`
in the compiler (→ 400). Both sides refuse the same filters, so the result sets
still agree.

Also refused by both sides: an ordering operator (`lt`/`lte`/`gt`/`gte`) against
a `null` or `bool` literal, and a list operator or `text` against a non-string
column.

**Dates.** A date literal against `created_at`/`updated_at`/`deleted_at` compares **instants**
(they are BSON dates). Against `fm`/`plugins` it compares **canonical text**,
and only values already in canonical shape participate — the evaluator tests the
shape directly, the compiler emits the equivalent regex guard, and
`corpus/dates.json` asserts the two agree entry by entry. Consequences worth
knowing:

- `eq` on a `fm` date is precision-sensitive: `{"date": "2026-09-23"}` does not
  equal a stored `2026-09-23T00:00:00.000Z`. Prefer range comparisons.
- A string that is canonically *shaped* but not a real date (`2026-02-30`)
  participates in comparisons. Materialization never produces one, and both
  sides treat it identically, so it is harmless — and pinned by the corpus.

**Sorting.** `compare_rows` puts missing values **last in both directions** and
always tiebreaks on `id` ascending — the same tiebreaker the query layer appends
to the Mongo sort, so client and server order rows identically. `content` and
`deleted` are not sortable.

### Known residual divergence

`text` matching is case-insensitive on both sides, but the folding differs for
non-ASCII: the evaluator uses Rust's Unicode lowercasing, the server uses
Mongo's `i` regex option. ASCII behaves identically. Full-text search is a
separate mechanism (SPEC §4.2) and is not affected.

---

## 5. Splices

`splice` computes **edits only** — applying them is the caller's job (server:
the per-document actor; client: the kernel splice helper). No function here ever
parses and re-serializes a block (SPEC §3.3 forbids the round-trip: it destroys
comments and formatting and corrupts under concurrent edits).

```rust
set_frontmatter_value(text, key, &value)?   // replaces only the value span
remove_frontmatter_key(text, key)?          // removes every occurrence
splice_section(text, plugin_id, &edits)?    // one line per changed key
remove_section(text, plugin_id)?            // the whole section, every copy
apply(text, &edits)                         // reference implementation
```

- Returned edits are **disjoint and sorted by `range.start` descending**, so
  they apply in order without re-offsetting. `apply` re-sorts defensively.
- `set_frontmatter_value` creates the block when there is none, and the key line
  when the block exists without it (inserted just before the closing fence). It
  targets the **last** occurrence of a duplicated key.
- `splice_section` creates the section — and the trailing run — when needed,
  appends new keys just before the closing fence, and removes earlier duplicate
  lines of any key it writes ("the next write cleans up", SPEC §3.3). A `None`
  value removes the key's line; `Some(Value::Null)` writes `key: null`.
- Values are serialized with `Value::to_yaml_inline`, which quotes anything that
  would otherwise re-parse as a different type or break the line/flow form.
- A key that could never be parsed back (failing the key regex) is
  `CoreError::SpliceTargetMissing`; text over `MAX_DOCUMENT_BYTES` is
  `CoreError::DocumentTooLarge`.
- Span lookups are CRLF-tolerant, so splices work against un-normalized text.

---

## 6. The conformance corpus

`corpus/*.json` is **data, not code** — deliberately, because the same files are
fed to this crate compiled to `wasm32` and the answers must match.
The only Rust is the harness in `tests/conformance.rs` and
`tests/common/mod.rs`.

| File | Covers |
|---|---|
| `documents.json` | fences, CRLF/BOM, typed scalars, flow collections, duplicate keys, invalid keys, unsupported YAML, broken quotes and brackets mid-edit, comments, date normalization, title resolution, section runs and their edge cases |
| `dates.json` | canonical forms, tolerated input shapes, calendar validity, epoch values, chronological == lexicographic order, the canonical-shape participation test |
| `splices.json` | every splice path plus its exact edit count and replaced slices, including CRLF text |
| `filters.json` | rows + filter cases (evaluated **and** compiled), refused filters, rejected wire forms, sort orders, compiled sort documents |

Plus, in `tests/conformance.rs`: the hardening caps at and just over the
boundary, the `edit_affects_metadata` short-circuit, and a determinism check on
every document case.

Adding a rule means adding a corpus case in the same commit.
