# Plugin architecture review

**Date:** 2026-09-27  
**Scope:** Read-only review of the plugin structure, contracts, loader, extension registry,
installation flow, and backend host.  
**Goal:** Assess how well the current design supports a large, independently developed
plugin ecosystem and identify the highest-leverage improvements.

## Executive summary

The plugin system is a strong microkernel design. It should be evolved rather than
redesigned.

Plugins are real architectural units rather than feature folders: the visible base
application is assembled from replaceable plugins, the kernel treats extension-point
names as opaque, dependencies activate deterministically, activation failures are
contained, and the backend half runs behind a capability-gated Wasm ABI. The installation
and recovery model is also unusually mature for this stage: packages are validated before
extraction, assets are version-scoped, approvals can narrow capabilities, and safe modes
remain available when plugins fail.

The main limit on external extensibility is not the runtime model. It is contract
distribution and drift. The manifest has separate Rust and TypeScript representations
that already disagree, while the base extension-point contracts live in a private shared
source file that third-party authors must copy. Fixing those two boundaries would turn an
already sound internal architecture into a substantially safer external ecosystem.

## Architectural shape

The system has several distinct plugin-facing layers:

1. The package manifest declares identity, compatibility, dependencies, shared runtime
   libraries, frontend assets, backend assets, configuration, and requested capabilities.
2. The server validates packages, resolves dependency and peer-library ranges, records
   approval state, and serves immutable versioned assets.
3. The browser loader revalidates compatibility, activates plugins in topological order,
   publishes returned services, and contains activation failures.
4. The extension registry lets plugins define and contribute to runtime-validated points
   without teaching the kernel what a navbar, document mode, or markdown renderer is.
5. The frontend kernel gives each plugin an attributed view of documents, settings,
   events, services, UI, sync, and other shared facilities.
6. The backend host runs Wasm modules behind declared capabilities, resource limits,
   hooks, cron, routes, and a typed ABI.

This separation is appropriate. In particular, extension points and service dependencies
solve different problems: extension points support open-ended contribution, while services
support explicit API consumption from a declared dependency.

## What is working well

### The base application proves the plugin model

The base distribution is made of the same kind of plugin as external additions and has no
special kernel privilege. The examples go further by exercising replacement of the editor,
adding document modes, extending markdown task states, and hosting a backend-only Wasm
fixture. This is stronger evidence than a nominal plugin API that the main application
does not itself use.

See [`plugins/base/README.md`](../../plugins/base/README.md) and
[`plugins/examples/README.md`](../../plugins/examples/README.md).

### The extension registry is carefully designed

[`web/kernel/src/runtime/registry.ts`](../../web/kernel/src/runtime/registry.ts) provides:

- contributions that buffer before their point is defined;
- validation when the owning point becomes available;
- stable ordering;
- duplicate-key detection;
- isolated subscriber failures;
- live reads and subscriptions;
- attribution of failures to the responsible plugin; and
- complete retraction of both contributions and points when a plugin fails.

Releasing points owned by a failed plugin is especially important. Without it, a failed
owner would permanently reserve the point name and prevent a replacement from defining it
later in the session.

### Dependency behavior is deterministic and failure-aware

The browser and server both resolve explicit semver dependencies. Activation uses a stable
topological order, and a failed activation retracts partial registrations and skips all
transitive dependents. Service APIs are available only to declared dependents, preventing
accidental coupling to whichever plugin happened to load first.

See [`web/app/src/loader/loader.ts`](../../web/app/src/loader/loader.ts),
[`web/app/src/loader/order.ts`](../../web/app/src/loader/order.ts), and
[`web/kernel/src/runtime/services.ts`](../../web/kernel/src/runtime/services.ts).

### Frontend and backend compatibility form one declared contract

One `kernel` semver covers both `@kernel` and the Wasm host ABI. The server checks the
range during installation and the browser checks again during boot, so a stale offline
client skips a plugin it cannot implement instead of activating it partially.

The backend host also has a clear niche and boundary: background jobs, outbound HTTP,
webhooks, events, and machine-owned documents. Undeclared host functions remain linked as
erroring stubs, which permits graceful capability probing without turning missing grants
into module-instantiation failures.

See [`dev-docs/resolved/KERNEL-API.md`](../resolved/KERNEL-API.md) and
[`backend/HOST-ABI.md`](../../backend/HOST-ABI.md).

### Installation and recovery are first-class

The design accounts for archive hardening, capability approval, versioned assets,
dependency resolution, enable/disable state, safe-mode boot, and data preservation during
ordinary uninstall. These operational details are part of plugin architecture, not an
afterthought.

## Priority findings

### P0: Establish one generated manifest contract

The manifest currently has independent Rust and TypeScript definitions. They already
disagree:

- TypeScript config fields allow `string`, `number`, and `boolean`; Rust additionally
  supports `select`.
- Rust supports config `default` and `options`; the public TypeScript interface does not.
- Rust backend declarations support `routes` and `events`; the TypeScript interface exposes
  only `module`, `hooks`, and `cron`.

Compare [`web/kernel-api/src/manifest.ts`](../../web/kernel-api/src/manifest.ts) with
[`backend/crates/server/src/plugins.rs`](../../backend/crates/server/src/plugins.rs).

The shared kernel version is also synchronized manually. The Rust source explicitly notes
that it must equal the TypeScript API version but that no build step checks it.

#### Recommendation

Define one machine-readable manifest schema and generate or verify all derived forms:

- Rust types and validation;
- TypeScript types and validation;
- JSON Schema for editor completion and diagnostics;
- compatibility fixtures shared by both implementations; and
- an automated assertion that the frontend API and backend ABI versions agree.

This should be the first change because every later manifest feature otherwise increases
the drift surface.

### P1: Publish versioned extension-point contracts

The most important frontend ecosystem contract currently lives in
[`plugins/base/_shared/points.ts`](../../plugins/base/_shared/points.ts). It intentionally is
not part of `@kernel`, which preserves the microkernel boundary, but the documented external
authoring path is to copy a type or submit an untyped object with the expected fields.

That is adequate inside one repository but fragile for independently versioned plugins.
An author needs stable access to the point name, payload type, semantics, and sometimes the
validator without importing the implementation plugin.

#### Recommendation

Keep domain-specific points out of `@kernel`, but publish versioned contract packages owned
by the plugin that defines them. For example:

- `@life-manager/shell-ui-contract`;
- `@life-manager/document-surface-contract`;
- `@life-manager/markdown-contract`.

Each package should expose point names and payload types. Reusable validators may also be
appropriate, provided the defining plugin remains the runtime authority. This preserves
replaceability while giving third-party authors a compile-time contract they do not need to
copy.

### P1: Diagnose unresolved contributions

Buffering contributions until a point is defined is excellent for decoupling activation
order. Its failure mode is that a misspelled or obsolete point can remain buffered forever.
The registry exposes `pending()`, but there is no production boot diagnostic consuming it.

The manifests contain informational `x-defines` fields, but the server deliberately passes
unknown fields through and these declarations are not tied to runtime definitions. There is
no corresponding declaration of contributed points.

#### Recommendation

At the end of activation, report contributions whose points were never defined. The report
should include the contributing plugin and point name and should appear in the existing
aggregated plugin notice/admin diagnostics.

Consider adding an `x-contributes` declaration beside `x-defines`. Initially it can remain
diagnostic rather than load-bearing. It would enable package-time typo detection and useful
ecosystem tooling without forcing extension points into the kernel.

### P2: Add optional dependencies

`services.get()` and `services.has()` appear suitable for optional integration, but service
access is restricted to declared dependencies and declared dependencies are hard: if one is
missing or disabled, the dependent plugin is skipped.

This leaves no direct way to say, "integrate with this service when installed, but continue
without it." Some current cross-plugin coordination uses events or extension points to avoid
introducing an impossible dependency direction.

#### Recommendation

Add `optionalDependencies` with these semantics:

- if an optional dependency is installed and enabled, it activates first;
- its service API is accessible to the declaring plugin;
- if it is missing, disabled, incompatible, or fails, the declaring plugin may still
  activate; and
- optional-edge cycles receive explicit deterministic handling rather than silently
  influencing order.

Extension points should remain the preferred mechanism for many-to-one contributions;
optional dependencies are for genuine optional service consumption.

### P2: Keep the shared peer-library set deliberately small

The server selects one version of every blessed peer library for the entire active plugin
set. This is necessary for identity-sensitive libraries such as React and can avoid subtle
cross-boundary failures. At ecosystem scale, however, global range intersection becomes a
source of unrelated installation conflicts.

#### Recommendation

Reserve peer libraries for dependencies that genuinely require shared identity across
plugin boundaries. Explicitly permit plugins to bundle private implementation dependencies
where identity does not cross the boundary. Longer term, document which libraries are
blessed, why each must be shared, and which ranges the current runtime bundle actually
provides.

### P2: Make the frontend trust boundary an explicit ecosystem decision

Frontend plugins run unsandboxed with access to the DOM, workspace, and user session.
Manifest capabilities gate backend host functions and native bridge operations; they do not
sandbox browser code. This is clearly documented in
[`plugins/base/README.md`](../../plugins/base/README.md#trust-stated-plainly) and the admin UI.

That is a coherent choice for administrator-approved or curated plugins. It becomes the
primary constraint if the intended ecosystem includes arbitrary community packages.

#### Recommendation

Choose and document one product-level trust model:

- **Curated/full-trust:** retain the current architecture, strengthen signing, provenance,
  review, and approval UX.
- **Open/untrusted:** plan a separate isolated frontend plugin class using workers,
  sandboxed frames, message-based APIs, or another capability boundary. Do not present the
  current manifest capabilities as browser isolation.

An isolated plugin class would likely expose a smaller UI model than full React component
contribution. It should complement rather than silently constrain existing full-trust
plugins.

## Secondary observations

### Unknown manifest fields trade typo detection for forward compatibility

Rust flattens unknown manifest fields into an `extra` map so older servers can carry newer
metadata. This is useful for forward compatibility and `x-*` extensions, but it also means a
misspelled known field can be accepted as inert metadata.

A generated schema could distinguish namespaced extension keys from suspicious near-misses
while retaining a deliberate forward-compatibility policy.

### Reload-only activation is currently a strength

Plugins activate once, in dependency order, and installation or enablement requires a
reload. This keeps lifecycle semantics, import maps, service publication, stylesheet
handling, and failure recovery tractable.

Hot activation is not required for architectural extensibility. It should be added only
when there is a concrete product need and after every public surface has an explicit
disposal contract. The current reload-only model is a reasonable simplification, not a
design deficiency.

### Conflict policy may eventually need richer intent

Duplicate keyed contributions currently use first registration wins, with deterministic
activation making the outcome stable. At larger scale, replacements and overrides may need
an explicit policy rather than relying on exclusion of the replaced plugin or activation
order. Any future override mechanism should be declarative and visible to administrators;
silent priority contests would weaken the current predictability.

## Suggested sequence

1. Generate and cross-check the manifest contract.
2. Extract and publish versioned extension-point contract packages.
3. Surface unresolved contributions and manifest declaration mismatches.
4. Add optional dependencies with deterministic resolution rules.
5. Formalize the blessed peer-library policy.
6. Decide whether the ecosystem is curated/full-trust or needs a second isolated frontend
   plugin class.

## Conclusion

The core structure is already highly extensible. Its best qualities are the separation of
kernel facilities from domain extension points, deterministic dependency behavior, strong
failure containment, and a capable backend sandbox. The next stage is chiefly about making
those contracts independently consumable and impossible to drift.

The two highest-leverage changes are therefore:

1. one generated manifest schema across Rust and TypeScript; and
2. published, versioned contracts for extension points owned outside the kernel.

Those changes preserve the current architecture while making it far safer for plugins to
be authored, released, and upgraded independently.
