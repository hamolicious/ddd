/**
 * The typed client over `/api/admin/*` and the two admin-facing corners of the document
 * and attachment APIs.
 *
 * **The server authorizes; this file only asks.** Every route here returns 403 to a
 * non-admin, so nothing in this plugin is a security control — hiding a button is a
 * courtesy to the user, and the client is written so that a 403 surfaces as an error
 * message rather than as an empty table that looks like "no users".
 *
 * Shapes mirror the Rust response types (`crates/server/src/routes/admin.rs`,
 * `attachments.rs`, `documents.rs`) and are **snake_case**, because that is what the wire
 * carries everywhere except `/api/plugins` — which is `InstalledPlugin` from
 * `kernel-api/src/manifest.ts` and camelCase, since a plugin manifest is written by hand
 * (`backend/CONTRACTS.md`, area server-static). That inconsistency is deliberate upstream,
 * so it is named here rather than smoothed over.
 *
 * Timestamps are RFC 3339 strings, never extended JSON: the server has a test that scans
 * whole response bodies for `$date`/`$oid`, so anything arriving here is a plain string.
 */

import type {
  InstalledPlugin,
  ManifestProblem,
  PluginCapabilities,
  PluginManifest,
} from "@kernel";

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly is_admin: boolean;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly last_login_at?: string;
}

export interface InviteView {
  readonly id: string;
  readonly email: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly used_by: string | null;
  readonly revoked_at: string | null;
  /** `pending` | `used` | `revoked` | `expired`, derived by the server. */
  readonly status: string;
}

export interface CreatedInvite {
  readonly invite: InviteView;
  /** Returned exactly once, at creation. */
  readonly token: string;
  /** `<PUBLIC_URL>/#/invite/<token>`; absent when the server has no `PUBLIC_URL`. */
  readonly url?: string;
}

export interface PasswordResetIssued {
  readonly user_id: string;
  readonly token: string;
  readonly expires_at: string;
  /** `<PUBLIC_URL>/#/reset/<token>`; absent when the server has no `PUBLIC_URL`. */
  readonly url?: string;
}

/**
 * A reset link at the address this app was loaded from, for a server without
 * `PUBLIC_URL`. Right in a browser; in the Android app the address is the phone's own,
 * so set `PUBLIC_URL` on a server whose admins use the app.
 */
export function resetLinkHere(token: string): string {
  return `${location.origin}${location.pathname}#/reset/${token}`;
}

/** An invite link at the address this app was loaded from; see `resetLinkHere`. */
export function inviteLinkHere(token: string): string {
  return `${location.origin}${location.pathname}#/invite/${token}`;
}

export interface AuditView {
  readonly id: string;
  readonly action: string;
  readonly actor: string | null;
  readonly target_kind: string;
  readonly target_id: string | null;
  readonly detail: unknown;
  readonly ip: string | null;
  readonly created_at: string;
}

export interface AuditPage {
  readonly entries: readonly AuditView[];
  readonly next_cursor?: string;
}

export interface AttachmentView {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly revision: number;
  readonly created_at: string;
  readonly created_by: string | null;
  readonly updated_at: string;
  readonly updated_by: string | null;
}

export interface OrphanView {
  readonly attachment: AttachmentView;
  readonly flagged_at: string;
}

export interface AdminStats {
  readonly documents: number;
  readonly trashed_documents: number;
  readonly graveyard_entries: number;
  readonly attachments: number;
  readonly attachment_bytes: number;
  readonly users: number;
  readonly schema_version: number;
  readonly oversized_documents: number;
}

export interface InstalledPluginsResponse {
  readonly plugins: readonly InstalledPlugin[];
  readonly problems: readonly { readonly path: string; readonly message: string }[];
  readonly disabled: boolean;
}

// ---------------------------------------------------------------------------
// M4: plugin management (`/api/admin/plugins/*`)
// ---------------------------------------------------------------------------

/**
 * These shapes mirror `crates/server/src/routes/plugin_api.rs` — **snake_case**, like the
 * rest of `/api/admin`, with one deliberate exception inherited from the manifest:
 * `capabilities["public-routes"]` keeps its hyphen, because that is what a plugin author
 * writes in `manifest.json` and what SPEC §6.2 froze. The manifest itself is served exactly
 * as it was written, so anything nested under `manifest` is manifest spelling
 * (`peerLibraries`), not wire spelling.
 */
export type PluginLifecycleState = "pending" | "enabled" | "disabled" | "failed";

export interface PluginCronState {
  readonly index: number;
  readonly expression: string;
  readonly last_run?: string;
  /** `"ok"`, or the error code of the last failure. */
  readonly last_status?: string;
  readonly runs: number;
  readonly failures: number;
}

/**
 * The circuit breaker, as the server can see it (SPEC §6.3).
 *
 * `open` means the host turned the plugin off after repeated failures and it stays off until
 * an admin re-enables it; `by_admin` means a person did. The distinction decides what the
 * button says, so the two are separate flags rather than one enum with a nullable reason.
 */
export interface PluginBreakerState {
  readonly open: boolean;
  readonly reason: string | null;
  readonly by_admin: boolean;
}

export interface PluginMetrics {
  readonly cron_jobs: number;
  readonly cron_runs: number;
  readonly cron_failures: number;
  readonly last_cron_run: string | null;
  readonly last_cron_status: string | null;
  readonly recent_events: number;
}

export interface PluginRouteSpec {
  readonly method: string;
  readonly path: string;
  /** Reachable without a session — the capability that deserves the loudest label. */
  readonly public: boolean;
}

/** One field of a manifest's `config` schema (SPEC §6.2). */
export interface PluginConfigSchemaField {
  readonly type: string;
  /** Write-only in this UI, encrypted at rest. */
  readonly secret?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly required?: boolean;
  /** For `select`. */
  readonly options?: readonly string[];
}

export type PluginConfigSchema = Readonly<Record<string, PluginConfigSchemaField>>;

export type PluginInstallSource =
  | { readonly kind: "upload"; readonly filename: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "base" };

export interface PluginAdminView {
  readonly id: string;
  readonly version: string;
  readonly state: PluginLifecycleState;
  readonly base: boolean;
  readonly served: boolean;
  readonly active: boolean;
  readonly manifest: PluginManifest;
  /** What the package asked for — the list an approval screen must show. */
  readonly capabilities_requested: PluginCapabilities;
  /** What an admin granted. Empty until approval. */
  readonly capabilities_approved: PluginCapabilities;
  readonly capabilities_differ: boolean;
  readonly source: PluginInstallSource;
  readonly installed_at: string;
  readonly installed_by: string | null;
  readonly approved_at: string | null;
  readonly approved_by: string | null;
  readonly last_error: string | null;
  readonly module_sha256: string | null;
  readonly has_backend: boolean;
  readonly hooks: readonly string[];
  readonly cron: readonly PluginCronState[];
  readonly routes: readonly PluginRouteSpec[];
  readonly events: readonly string[];
  readonly config_schema: PluginConfigSchema;
  readonly breaker: PluginBreakerState;
  readonly metrics: PluginMetrics;
}

export interface PluginHostStats {
  readonly active: number;
  readonly disabled: number;
  readonly instances: number;
  readonly calls_in_flight: number;
  readonly cron_jobs: number;
  readonly hooks_pending: number;
}

export interface PluginLimitsView {
  readonly call_timeout_ms: number;
  readonly cron_timeout_ms: number;
  readonly memory_bytes: number;
  readonly max_instances: number;
  readonly breaker_threshold: number;
  readonly http_timeout_ms: number;
  readonly max_http_response_bytes: number;
  readonly cron_enabled: boolean;
  readonly max_package_bytes: number;
}

export interface PluginAdminList {
  readonly plugins: readonly PluginAdminView[];
  readonly problems: readonly { readonly path: string; readonly message: string }[];
  readonly host: PluginHostStats;
  readonly limits: PluginLimitsView;
  readonly plugins_disabled: boolean;
  readonly install_lock: string | null;
  readonly abi_version: number;
  readonly pending_count: number;
  readonly secret_placeholder: string;
}

export interface PluginInstallOutcome {
  readonly id: string;
  readonly version: string;
  readonly state: PluginLifecycleState;
  readonly capabilities: PluginCapabilities;
  readonly replaced: string | null;
  readonly warnings: readonly string[];
}

export interface PluginConfigView {
  readonly plugin_id: string;
  readonly schema: PluginConfigSchema;
  /**
   * Key → stored value, every `secret: true` one replaced by {@link secret_placeholder}.
   * A key with no stored value is **absent**, which is what {@link normalizeConfigValues}
   * reads as "not set" — so this is deliberately not `Record<string, unknown>` with holes
   * filled in. Read it through that function rather than indexing it directly.
   */
  readonly values: unknown;
  /** Key → `true` when a value is stored. A masked secret looks the same either way. */
  readonly set?: Readonly<Record<string, boolean>>;
  /** Declared keys with nothing stored and no usable default. */
  readonly missing?: readonly string[];
  readonly updated_at?: string | null;
  readonly updated_by?: string | null;
  readonly secret_keys: readonly string[];
  readonly secret_placeholder: string;
}

export interface PluginEvent {
  readonly at: string;
  readonly plugin_id: string;
  readonly level: string;
  readonly message: string;
}

export interface PluginLogView {
  readonly plugin_id: string;
  readonly events: readonly PluginEvent[];
  /** The ring is per-process; the audit log is the durable record. */
  readonly ephemeral: boolean;
  readonly capacity: number;
}

export interface CronRunResult {
  readonly plugin_id: string;
  readonly index: number;
  readonly expression: string;
  readonly duration_ms: number;
  readonly writes: number;
  readonly logs: number;
  readonly value: unknown;
}

export interface AuditQuery {
  readonly action?: string;
  readonly actor?: string;
  readonly target_id?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminClient {
  stats(): Promise<AdminStats>;

  users(): Promise<readonly UserView[]>;
  updateUser(id: string, changes: { readonly is_admin?: boolean; readonly name?: string }): Promise<UserView>;
  deleteUser(id: string): Promise<void>;
  issueReset(id: string): Promise<PasswordResetIssued>;

  invites(): Promise<readonly InviteView[]>;
  createInvite(email?: string): Promise<CreatedInvite>;
  revokeInvite(id: string): Promise<void>;

  audit(query?: AuditQuery): Promise<AuditPage>;

  orphans(): Promise<readonly OrphanView[]>;
  scanOrphans(): Promise<readonly OrphanView[]>;
  deleteAttachment(id: string): Promise<void>;


  plugins(): Promise<InstalledPluginsResponse>;
  /** The zip of every document as plain markdown — the no-Mongo recovery path. */
  exportWorkspace(): Promise<Blob>;

  // ---- M4: plugin management ----
  /** Every plugin record: state, capabilities requested vs granted, cron, breaker. */
  adminPlugins(): Promise<PluginAdminList>;
  /** Upload a package. It lands **pending** — approval is a separate, explicit act. */
  uploadPlugin(file: File): Promise<PluginInstallOutcome>;
  /** Approve a pending install with a capability set (omit ⇒ exactly what was requested). */
  approvePlugin(
    id: string,
    version: string,
    capabilities?: PluginCapabilities,
  ): Promise<PluginAdminView>;
  rejectPlugin(id: string, version: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string, note?: string): Promise<void>;
  /** `purge` is SPEC §6.2's explicit checkbox: KV **and** the plugin's `%%%` sections. */
  uninstallPlugin(id: string, purge: boolean): Promise<void>;
  pluginConfig(id: string): Promise<PluginConfigView>;
  savePluginConfig(id: string, values: Readonly<Record<string, unknown>>): Promise<PluginConfigView>;
  /** Run one declared cron expression now, without moving the schedule. */
  runPluginCron(id: string, index: number): Promise<CronRunResult>;
  pluginLogs(id: string, limit?: number): Promise<PluginLogView>;
}

export function createAdminClient(fetchApi: ApiFetch): AdminClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchApi(path, init);
    return (await response.json()) as T;
  };
  const send = async (path: string, init: RequestInit): Promise<void> => {
    await fetchApi(path, init);
  };
  const postJson = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = (value: string): string => encodeURIComponent(value);

  return {
    stats: () => json<AdminStats>("/admin/stats"),

    users: () => json<readonly UserView[]>("/admin/users"),
    updateUser: (userId, changes) =>
      json<UserView>(`/admin/users/${id(userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      }),
    deleteUser: (userId) => send(`/admin/users/${id(userId)}`, { method: "DELETE" }),
    issueReset: (userId) => json<PasswordResetIssued>(`/admin/users/${id(userId)}/reset`, postJson({})),

    invites: () => json<readonly InviteView[]>("/admin/invites"),
    createInvite: (email) =>
      json<CreatedInvite>("/admin/invites", postJson(email ? { email } : {})),
    revokeInvite: (inviteId) => send(`/admin/invites/${id(inviteId)}`, { method: "DELETE" }),

    audit: (query = {}) => json<AuditPage>(`/admin/audit${auditParams(query)}`),

    orphans: () => json<readonly OrphanView[]>("/attachments/orphans"),
    scanOrphans: () => json<readonly OrphanView[]>("/attachments/orphans/scan", { method: "POST" }),
    deleteAttachment: (attachmentId) => send(`/attachments/${id(attachmentId)}`, { method: "DELETE" }),


    plugins: () => json<InstalledPluginsResponse>("/plugins"),
    exportWorkspace: async () => (await fetchApi("/admin/export")).blob(),

    adminPlugins: () => json<PluginAdminList>("/admin/plugins"),
    uploadPlugin: (file) => {
      // `FormData`, not a JSON body: a package is up to 25 MB and the server streams it to a
      // staging file. Content-Type is deliberately *not* set — the browser has to add the
      // multipart boundary, and setting it by hand is the classic way to make every upload
      // fail with "malformed multipart body".
      const body = new FormData();
      body.append("package", file, file.name);
      return json<PluginInstallOutcome>("/admin/plugins", { method: "POST", body });
    },
    approvePlugin: (pluginId, version, capabilities) =>
      json<PluginAdminView>(
        `/admin/plugins/${id(pluginId)}/${id(version)}/approve`,
        postJson(capabilities === undefined ? {} : { capabilities }),
      ),
    rejectPlugin: (pluginId, version) =>
      send(`/admin/plugins/${id(pluginId)}/${id(version)}/reject`, { method: "POST" }),
    enablePlugin: (pluginId) => send(`/admin/plugins/${id(pluginId)}/enable`, { method: "POST" }),
    disablePlugin: (pluginId, note) =>
      send(`/admin/plugins/${id(pluginId)}/disable`, postJson(note ? { note } : {})),
    uninstallPlugin: (pluginId, purge) =>
      send(`/admin/plugins/${id(pluginId)}${purge ? "?purge=true" : ""}`, { method: "DELETE" }),
    pluginConfig: (pluginId) => json<PluginConfigView>(`/admin/plugins/${id(pluginId)}/config`),
    savePluginConfig: (pluginId, values) =>
      json<PluginConfigView>(`/admin/plugins/${id(pluginId)}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      }),
    runPluginCron: (pluginId, index) =>
      json<CronRunResult>(
        `/admin/plugins/${id(pluginId)}/cron/${encodeURIComponent(String(index))}/run`,
        { method: "POST" },
      ),
    pluginLogs: (pluginId, limit) =>
      json<PluginLogView>(
        `/admin/plugins/${id(pluginId)}/logs${limit === undefined ? "" : `?limit=${limit}`}`,
      ),
  };
}

// ---------------------------------------------------------------------------
// Plugin config values
// ---------------------------------------------------------------------------

/** One config key as the form holds it. */
export interface ConfigValueState {
  /** The value to show. A secret is always the placeholder, never the real thing. */
  readonly value: unknown;
  /** `true` when the server has a value stored for this key. */
  readonly set: boolean;
}

/**
 * Read `PluginConfigView.values` into one predictable shape.
 *
 * The server hands back whatever `plugininstall::config::for_admin` produced, and the two
 * plausible spellings are `{ key: value }` and `{ key: { value, set } }`. Accepting both is
 * cheap here and the alternative is a form that silently renders `[object Object]` in every
 * field the day the other spelling ships.
 *
 * INTEGRATION (install-flow): pinning `for_admin`'s return shape in `HOST-ABI.md` — the
 * `{ value, set }` form, since "is it set" is exactly what a masked secret field has to know —
 * would let this function lose half its body. Until then it is deliberately tolerant, and
 * `api.test.ts` pins both readings.
 */
export function normalizeConfigValues(
  values: unknown,
  schema: PluginConfigSchema,
  placeholder: string,
): Readonly<Record<string, ConfigValueState>> {
  const source: Record<string, unknown> =
    typeof values === "object" && values !== null && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : {};
  const result: Record<string, ConfigValueState> = {};

  for (const key of Object.keys(schema)) {
    const field = schema[key];
    const raw = source[key];
    let value: unknown = raw;
    let set = raw !== undefined && raw !== null;

    if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "value" in raw) {
      const wrapped = raw as { value?: unknown; set?: unknown };
      value = wrapped.value;
      set = wrapped.set === true || (wrapped.set === undefined && wrapped.value !== undefined);
    }

    if (field?.secret === true) {
      // A secret is never readable, so the only honest thing to render is the mask. `set`
      // is what the UI actually needs: "leave blank to keep the stored value" only makes
      // sense when there is one.
      result[key] = { value: set ? placeholder : "", set };
      continue;
    }
    result[key] = { value: set ? value : (field?.default ?? ""), set };
  }
  return result;
}

/**
 * The values to submit: only what the admin changed, with an untouched secret dropped.
 *
 * A secret field that still holds the placeholder means "unchanged" — submitting it would
 * overwrite the real credential with `••••••••`, which is the single most likely way for this
 * screen to destroy something irrecoverable. It is therefore handled here, in a pure
 * function, and not in a component's event handler.
 */
export function configSubmission(
  draft: Readonly<Record<string, unknown>>,
  schema: PluginConfigSchema,
  placeholder: string,
): Record<string, unknown> {
  const submission: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const field = schema[key];
    if (!field) continue;
    if (field.secret === true && (raw === placeholder || raw === "")) continue;
    if (field.type === "number") {
      if (raw === "" || raw === null || raw === undefined) {
        submission[key] = null;
        continue;
      }
      const numeric = typeof raw === "number" ? raw : Number(raw);
      submission[key] = Number.isFinite(numeric) ? numeric : raw;
      continue;
    }
    if (field.type === "boolean") {
      submission[key] = raw === true || raw === "true";
      continue;
    }
    if (raw === "" && field.required !== true) {
      // An emptied optional field clears the key rather than storing an empty string.
      submission[key] = null;
      continue;
    }
    submission[key] = raw;
  }
  return submission;
}

/**
 * What an approval is allowed to change (`HOST-ABI.md` §7.2, and the server re-checks it):
 * it may **narrow** anything and may **extend only `http.hosts`**.
 *
 * Returned as messages rather than a boolean so the screen can say which field is the
 * problem before the request is sent — the server's refusal is the control, this is the
 * courtesy.
 */
export function approvalProblems(
  requested: PluginCapabilities | undefined,
  granted: PluginCapabilities,
): readonly string[] {
  const problems: string[] = [];
  const asked = requested ?? {};
  for (const right of granted.documents ?? []) {
    if (!(asked.documents ?? []).includes(right)) {
      problems.push(`the package did not request \`documents: ["${right}"]\``);
    }
  }
  if (granted.notifications === true && asked.notifications !== true) {
    problems.push("the package did not request `notifications`");
  }
  for (const route of granted["public-routes"] ?? []) {
    if (!(asked["public-routes"] ?? []).includes(route)) {
      problems.push(`the package did not declare \`${route}\` as a public route`);
    }
  }
  if (granted.http !== undefined && asked.http === undefined) {
    problems.push("the package did not request the `http` capability");
  }
  for (const host of granted.http?.hosts ?? []) {
    if (!isBareHost(host)) {
      problems.push(`\`${host}\` is not a bare host name (no scheme, no path, no port)`);
    }
  }
  return problems;
}

/** A `http.hosts` entry: a bare host name, matched exactly (`HOST-ABI.md` §3.11). */
export function isBareHost(host: string): boolean {
  const value = host.trim();
  if (value === "") return false;
  if (value.includes("://") || value.includes("/") || value.includes(":")) return false;
  if (value.includes("*")) return false;
  return /^[A-Za-z0-9.-]+$/.test(value);
}

/**
 * What the server's outbound IP policy will make of one `http.hosts` entry —
 * `undefined` when it is an ordinary public name and there is nothing to say.
 *
 * The approval screen used to print one blanket sentence, "Loopback, link-local,
 * private and metadata addresses stay blocked regardless", next to *any* added host.
 * It was wrong twice over: wrong for `example.com`, where there was nothing to warn
 * about and the sentence read as a threat; and wrong for `10.0.0.5`, because the
 * operator's `PLUGIN_HTTP_ALLOW_CIDRS` is exactly the knob that unblocks private
 * ranges (SPEC §6.2: "admin-configurable allowlist"), so "regardless" was a promise
 * the server does not keep. The one range it *does* keep is the cloud metadata
 * addresses, which `address_allowed` refuses before it consults the allowlist at all.
 *
 * This is a **hint about a literal**, deliberately, and never a verdict. The server
 * resolves the name and pins the address it got (`resolve_pinned`); a name this
 * function calls ordinary can still resolve into a refused range, and that refusal is
 * the enforcement. Nothing here gates the approve button.
 */
export type HostPolicyNote =
  | { readonly kind: "metadata"; readonly message: string }
  | { readonly kind: "loopback"; readonly message: string }
  | { readonly kind: "private"; readonly message: string }
  | { readonly kind: "internal-name"; readonly message: string };

/** The cloud metadata addresses `address_allowed` refuses ahead of the allowlist. */
const METADATA_LITERALS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);
/** Names that resolve to a metadata endpoint on the providers that publish one. */
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);

export function hostPolicyNote(host: string): HostPolicyNote | undefined {
  const value = host.trim().toLowerCase();
  if (value === "") return undefined;

  if (METADATA_LITERALS.has(value) || METADATA_NAMES.has(value)) {
    return {
      kind: "metadata",
      message:
        "a cloud metadata endpoint — the server refuses these before it consults any " +
        "allowlist, so this host can never be reached.",
    };
  }

  if (value === "localhost" || value.endsWith(".localhost") || isLoopbackLiteral(value)) {
    return {
      kind: "loopback",
      message:
        "loopback — blocked unless the operator has listed it in `PLUGIN_HTTP_ALLOW_CIDRS`. " +
        "Note that loopback here is the *server's* own machine, not the user's.",
    };
  }

  if (isPrivateLiteral(value)) {
    return {
      kind: "private",
      message:
        "a private, link-local or carrier-grade-NAT address — blocked unless the operator " +
        "has listed it in `PLUGIN_HTTP_ALLOW_CIDRS`.",
    };
  }

  if (value.endsWith(".internal") || value.endsWith(".local")) {
    return {
      kind: "internal-name",
      message:
        "an internal name. Whether it works depends on what it resolves to: a private " +
        "address is blocked unless the operator has listed it in `PLUGIN_HTTP_ALLOW_CIDRS`.",
    };
  }

  return undefined;
}

function isLoopbackLiteral(value: string): boolean {
  if (value === "::1" || value === "0.0.0.0" || value === "::") return true;
  const octets = ipv4Octets(value);
  return octets !== undefined && (octets[0] === 127 || octets[0] === 0);
}

function isPrivateLiteral(value: string): boolean {
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10), enough of them to
  // recognise what somebody would actually type.
  if (/^f[cd][0-9a-f]{0,2}:/.test(value) || /^fe[89ab][0-9a-f]?:/.test(value)) return true;
  const octets = ipv4Octets(value);
  if (octets === undefined) return false;
  const [a = 0, b = 0] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The four octets of a dotted-quad literal, or `undefined` for anything else. */
function ipv4Octets(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

/** `"a.test, b.test"` → `["a.test", "b.test"]`, blanks dropped. */
export function parseHostList(raw: string): readonly string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** Only the parameters that are set; an empty `action=` would filter on the empty string. */
export function auditParams(query: AuditQuery): string {
  const params = new URLSearchParams();
  if (query.action?.trim()) params.set("action", query.action.trim());
  if (query.actor?.trim()) params.set("actor", query.actor.trim());
  if (query.target_id?.trim()) params.set("target_id", query.target_id.trim());
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/** Human-readable bytes. Binary units, because that is what the storage numbers mean. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A timestamp for display. Never for ordering — that is `seq` and the CRDT. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Attribution that a deleted account keeps.
 *
 * Deleting a user soft-deletes the row and keeps the attribution id (SPEC §5.1), so an
 * id that no longer resolves to an active account renders as "deleted user" rather than a
 * raw ULID — and `plugin:<id>` and `system` actors are labelled as what they are.
 */
export function describeActor(actor: string | null | undefined, users: readonly UserView[]): string {
  if (!actor) return "—";
  if (actor === "system") return "system";
  if (actor.startsWith("plugin:")) return `plugin ${actor.slice("plugin:".length)}`;
  const user = users.find((candidate) => candidate.id === actor);
  if (!user) return `deleted user (${actor})`;
  return user.is_active ? user.email : `${user.email} (deleted)`;
}

/** Problems the loader found in a manifest, for the read-only plugin list. */
export type PluginManifestProblem = ManifestProblem;
