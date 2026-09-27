# Internet security review

**Reviewed:** 2026-09-27  
**Status:** Not cleared for direct Internet exposure  
**Threat model:** A small, trusted community (friends or family). Authenticated members and
administrator-approved plugins are trusted. This review focuses on an unauthenticated Internet
attacker, plus an attacker holding only an invite or password-reset link.

## Conclusion

The application is close to an acceptable state for a small private deployment, and its
authenticated surface is generally careful. It should not, however, be placed directly on the
public Internet in its current state. Before exposure, the deployment must prevent first-user
takeover, add anonymous-request and password-hashing limits, remove monitoring endpoints from the
public listener, and protect cookie-authenticated mutations from same-site CSRF.

Once those items are fixed or explicitly mitigated at the ingress, the project is in a reasonable
state for its intended scale. This conclusion is not a claim that the application is suitable for
hostile public multi-tenancy.

## Findings

### 1. High: fresh-install administrator takeover

`POST /api/auth/register` makes the first user an administrator. The decision is made using
`count_documents(...) == 0` before the user is inserted
(`backend/crates/server/src/routes/auth.rs`). An attacker who reaches a fresh deployment before the
owner can therefore claim the workspace. The check is also not atomic: two registrations racing
the empty database can both be assigned administrator privileges.

Required mitigation:

- Never expose a database with zero users. Bind the service to loopback or firewall it, create the
  initial administrator, verify the account, and only then publish DNS/open ingress.
- Replace the count-then-insert bootstrap with an atomic database guard.
- Prefer a one-time bootstrap secret or an offline `create-admin` command so initialization is not
  an anonymous Internet endpoint.

### 2. High availability risk: anonymous login denial of service

Every login attempt performs Argon2 verification synchronously in the async HTTP handler
(`backend/crates/server/src/routes/auth.rs`). There is no global HTTP concurrency limit or global
password-hashing semaphore. An attacker can vary email addresses and submit enough parallel login
requests to consume the runtime's worker threads and CPU.

The in-process limiter is also not genuinely bounded
(`backend/crates/server/src/auth/rate_limit.rs`). At 4,096 entries it sweeps stale entries but, when
all entries are fresh, continues adding new attacker-selected account keys. Failed login records
are written to Mongo (and expire after one day), so a sustained attack also creates database and
logging load.

Required mitigation:

- Apply edge rate limits to `/api/auth/login`, `/api/auth/register`, and
  `/api/auth/password/reset`, including a coarse global ceiling in addition to per-IP limits.
- Put Argon2 work behind a small global semaphore and execute it with `spawn_blocking`.
- Give the limiter a hard cardinality bound/LRU eviction policy.
- Consider a separate, less attacker-controlled policy for unknown-account attempts.
- Add ingress connection, request and concurrency limits. Per-account backoff alone is not a DoS
  defence.

The per-account backoff also permits a targeted account lockout. An attacker who knows a member's
email can deliberately keep that account in backoff. This is secondary to the resource-exhaustion
problem but should be considered when redesigning the limiter.

### 3. Medium: monitoring endpoints are publicly exposed

`/metrics` and `/readyz` are unauthenticated. `/metrics` exposes build version, request patterns,
plugin identifiers, configured limits, and workspace/activity counters. `/readyz` exposes
operational state and performs a Mongo ping for every request. The supplied Caddy configuration
currently proxies every path, despite `telemetry.rs` documenting `/metrics` as internal-only.

Required mitigation:

- Refuse `/metrics` on the public Caddy listener, or move it to a separate internal listener.
- Prefer the same treatment for `/readyz`; it is for an orchestrator, not end users.
- `/healthz` is cheap and contains no detail, but it can also be restricted if external uptime
  probing is not required.

### 4. Medium/conditional: same-site CSRF on cookie-authenticated mutations

The session cookie is `HttpOnly`, optionally `Secure`, and `SameSite=Lax`, but ordinary HTTP
mutations have no general CSRF token or `Origin` validation. CORS does not prevent an attacker from
sending a simple form request, and `SameSite` is based on the registrable site rather than the exact
origin.

If an attacker controls another HTTPS subdomain under the deployment's parent domain, they can
submit cookie-authenticated, bodyless POST requests. Relevant endpoints include logout, password
reset issuance, pending-plugin rejection, plugin enable, and plugin disable. The response remains
unreadable, but the state change can still occur.

Required mitigation:

- For unsafe methods authenticated by a cookie, validate `Origin` (with a careful `Referer`
  fallback where appropriate) against the configured application origin.
- Alternatively/additionally use CSRF tokens.
- Consider `SameSite=Strict` and a `__Host-` cookie name if they fit the client flows.
- Host the application on a dedicated registrable domain with no untrusted sibling subdomains.
  This reduces the immediate risk but is not a replacement for request validation.

### 5. Deployment configuration must be production-specific

The repository's current local `.env` is development-shaped and must not be copied to an Internet
deployment. At review time it had:

- `COOKIE_SECURE=false`;
- `MAX_ATTACHMENT_BYTES=0` (unbounded);
- local plain-HTTP origins in `APP_ORIGIN`;
- no `PUBLIC_URL`;
- `TRUST_PROXY_HEADERS=false`.

The documented Caddy deployment is safer, but correctness depends on several values being changed
together. A production deployment must use:

- HTTPS and `COOKIE_SECURE=true`;
- an exact production `APP_ORIGIN` allowlist;
- `PUBLIC_URL=https://<real-host>`;
- a finite attachment limit;
- `TRUST_PROXY_HEADERS=true` only when a trusted proxy is the only route to the server;
- `SERVER_PORT=127.0.0.1:8080` (or an internal-only container network), so port 8080 cannot bypass
  TLS, header normalization, or ingress limits;
- a randomly generated `SESSION_SECRET`, kept outside source control;
- a separately managed `CONFIG_KEY` before storing plugin secrets, so session-secret rotation does
  not make those secrets unreadable.

The Compose Mongo port is correctly published on loopback and Mongo authentication is not required
for the documented single-host topology. It must never be changed to a public bind address.

Container hardening such as a read-only root filesystem, dropped Linux capabilities,
`no-new-privileges`, resource limits, and pinned image digests would provide useful defence in
depth. The application container already runs as a non-root user.

## What an unauthenticated outsider does not appear able to do

No obvious unauthenticated path was found to:

- read or modify documents;
- access attachments;
- open an authenticated sync socket;
- manage users, invites, resets, or plugins;
- access Mongo through the published deployment ports;
- traverse static or plugin filesystem roots;
- use the normal application API as an SSRF primitive.

The base plugin distribution had no backend routes at review time, so there was no default public
webhook surface. Future plugins can deliberately expose public routes; each such route becomes an
Internet-facing endpoint and needs its own review. This remains true even though the host supplies
body limits, per-client limiting, response hardening, and capability controls.

## Existing strengths

- Session, invite and reset tokens use 32 random bytes and only keyed hashes are stored.
- Passwords use explicitly parameterized Argon2id with random salts and timing equalization for
  unknown accounts.
- Invites and resets are single-use and consumed with conditional atomic updates.
- Authenticated and administrator-only routes consistently use typed extractors.
- Session expiry and revocation are enforced, including immediate closure of affected WebSockets.
- WebSockets have mandatory origin checks for cookie sessions, frame/message caps, socket ceilings,
  queue bounds, heartbeats, revalidation and inbound-rate controls.
- JSON, document, attachment, chunk, plugin package and plugin response sizes are bounded by
  default.
- Static and bundle paths use lexical validation plus canonicalization to contain symlinks and
  traversal.
- Uploaded/scriptable content is served with `nosniff`, safe content dispositions, and CSP
  hardening where applicable.
- Markdown does not pass raw HTML through and URL schemes are allowlisted.
- Plugin package handling rejects zip slip, symlinks, undeclared files and zip bombs.
- Plugin outbound HTTP checks declared hosts, resolves and pins addresses, blocks private/special
  ranges by default, and re-checks redirects.
- The application runtime image uses a non-root user, and Mongo is published on loopback only.

## Verification performed

The review covered router assembly, authentication/session handling, authorization extractors,
rate limiting, public/static routes, attachments and chunked uploads, WebSockets, plugin routing and
outbound HTTP, configuration, Docker/Compose/Caddy deployment, Mongo indexes, browser CSP, Markdown
rendering, and common script/secret patterns.

Tests run successfully against the local Mongo container:

- Rust: 563 tests passed, including database-backed, WebSocket, authentication, static-serving,
  upload, zip-hardening, plugin runtime, plugin route and SSRF tests.
- Frontend: 1,051 tests passed; 1 skipped.
- TypeScript: typecheck passed.

This was a source/configuration review with local test execution, not an external penetration test,
fuzzing campaign, load test, or review of the hosting provider and network.

## Outstanding dependency and supply-chain check

A live dependency-advisory scan was not completed. Registry access for `npm audit` was unavailable
to the review, and `cargo-audit` was not installed. Before release:

1. Run `npm audit --omit=dev` from `web/` and triage production findings.
2. Run `cargo audit` against `backend/Cargo.lock` and `plugins/Cargo.lock`.
3. Scan the final container image, not only manifest files.
4. Record the results and review exceptions here.
5. Pin production container images more tightly than the current major/family tags, and establish a
   rebuild/update cadence.

## Release gate

Internet deployment is approved only when all of the following are true:

- [ ] The initial administrator has been created privately, or bootstrap has been redesigned.
- [ ] Anonymous auth endpoints have edge and application-level resource limits.
- [ ] Password hashing is bounded and moved off async runtime workers.
- [ ] The rate-limiter key map has a hard bound.
- [ ] `/metrics` and `/readyz` are unavailable from the public Internet.
- [ ] Cookie-authenticated unsafe methods have CSRF/Origin protection.
- [ ] The backend is reachable only through the HTTPS ingress.
- [ ] Production cookie, origin, public URL, proxy and upload-limit settings are verified.
- [ ] The npm, Rust and final-image vulnerability scans have been reviewed.
- [ ] Backup and restore have been exercised for the production data volume.

