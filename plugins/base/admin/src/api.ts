import type { InstalledPlugin, ManifestProblem, PluginCapabilities, PluginManifest } from "@kernel";

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
  readonly status: string;
}

export interface CreatedInvite {
  readonly invite: InviteView;
  readonly token: string;
  readonly url?: string;
}

export interface PasswordResetIssued {
  readonly user_id: string;
  readonly token: string;
  readonly expires_at: string;
  readonly url?: string;
}

export function resetLinkHere(token: string): string {
  return `${location.origin}${location.pathname}#/reset/${token}`;
}

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

export interface AdminStats {
  readonly documents: number;
  readonly trashed_documents: number;
  readonly graveyard_entries: number;
  readonly attachments: number;
  readonly attachment_bytes: number;
  readonly users: number;
  readonly schema_version: number;
  readonly oversized_documents: number;
  readonly large_history_bytes?: number;
  readonly history_alert_bytes?: number;
}

export type SkipReason = "missing" | "version" | "cycle" | "dependency-skipped" | "conflict";

export interface SkippedPlugin {
  readonly id: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface PluginLoadView {
  readonly normal: readonly string[];
  readonly safe: readonly string[];
  readonly skipped: readonly SkippedPlugin[];
  readonly version: string;
}

export interface InstalledPluginsResponse {
  readonly plugins: readonly InstalledPlugin[];
  readonly problems: readonly { readonly path: string; readonly message: string }[];
  readonly disabled: boolean;
  readonly load?: PluginLoadView;
}

export type PluginLifecycleState = "pending" | "enabled" | "disabled" | "failed";

export interface PluginCronState {
  readonly index: number;
  readonly expression: string;
  readonly last_run?: string;
  readonly last_status?: string;
  readonly runs: number;
  readonly failures: number;
}

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
  readonly public: boolean;
}

export interface PluginConfigSchemaField {
  readonly type: string;
  readonly secret?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly required?: boolean;
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
  readonly capabilities_requested: PluginCapabilities;
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
  readonly values: unknown;
  readonly set?: Readonly<Record<string, boolean>>;
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



  plugins(): Promise<InstalledPluginsResponse>;
  exportWorkspace(): Promise<Blob>;

  adminPlugins(): Promise<PluginAdminList>;
  uploadPlugin(file: File): Promise<PluginInstallOutcome>;
  approvePlugin(
    id: string,
    version: string,
    capabilities?: PluginCapabilities,
  ): Promise<PluginAdminView>;
  rejectPlugin(id: string, version: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string, note?: string): Promise<void>;
  uninstallPlugin(id: string, purge: boolean): Promise<void>;
  pluginConfig(id: string): Promise<PluginConfigView>;
  savePluginConfig(id: string, values: Readonly<Record<string, unknown>>): Promise<PluginConfigView>;
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



    plugins: () => json<InstalledPluginsResponse>("/plugins"),
    exportWorkspace: async () => (await fetchApi("/admin/export")).blob(),

    adminPlugins: () => json<PluginAdminList>("/admin/plugins"),
    uploadPlugin: (file) => {
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

export interface ConfigValueState {
  readonly value: unknown;
  readonly set: boolean;
}

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
      result[key] = { value: set ? placeholder : "", set };
      continue;
    }
    result[key] = { value: set ? value : (field?.default ?? ""), set };
  }
  return result;
}

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
      submission[key] = null;
      continue;
    }
    submission[key] = raw;
  }
  return submission;
}

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

export function isBareHost(host: string): boolean {
  const value = host.trim();
  if (value === "") return false;
  if (value.includes("://") || value.includes("/") || value.includes(":")) return false;
  if (value.includes("*")) return false;
  return /^[A-Za-z0-9.-]+$/.test(value);
}

export type HostPolicyNote =
  | { readonly kind: "metadata"; readonly message: string }
  | { readonly kind: "loopback"; readonly message: string }
  | { readonly kind: "private"; readonly message: string }
  | { readonly kind: "internal-name"; readonly message: string };

const METADATA_LITERALS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);
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

function ipv4Octets(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

export function parseHostList(raw: string): readonly string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

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

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function describeActor(actor: string | null | undefined, users: readonly UserView[]): string {
  if (!actor) return "—";
  if (actor === "system") return "system";
  if (actor.startsWith("plugin:")) return `plugin ${actor.slice("plugin:".length)}`;
  const user = users.find((candidate) => candidate.id === actor);
  if (!user) return `deleted user (${actor})`;
  return user.is_active ? user.email : `${user.email} (deleted)`;
}

export type PluginManifestProblem = ManifestProblem;
