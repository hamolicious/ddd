/**
 * Plugin management: pending installs and their capability approval, the installed set, the
 * circuit breaker, uninstall, and the generated config form (SPEC §6.2, §6.3).
 *
 * # What this screen is for
 *
 * Installing a plugin is the most consequential thing an admin of this app can do, so the
 * screen is built around **the sentence SPEC §6.1 requires it to say**: a plugin's frontend
 * half runs unsandboxed in every user's session, with full access to the DOM, the workspace
 * and the signed-in credentials. `capabilities` gate the *server* host functions and the
 * native bridge — they are not a browser sandbox. That is not a disclaimer at the bottom; it
 * is the first thing above the approve button.
 *
 * # The five things with teeth
 *
 * - **Approval is explicit, and it is a capability decision.** Both install paths (upload
 *   here, a directory drop on the server) land *pending*, and nothing runs until an admin
 *   clicks approve. The capability list is shown in full — hosts spelled out, public routes
 *   labelled as reachable without signing in — and may be **narrowed** here. The one field
 *   that may be *extended* is `http.hosts`, because a plugin whose destination is
 *   admin-configured cannot know its host when it is packaged (`HOST-ABI.md` §7.2) — a
 *   feed importer given its URL by an operator is exactly that case.
 * - **An upgrade is an upload.** A package whose id is already installed lands pending too,
 *   so a new version goes past the capability screen rather than around it.
 * - **Uninstall keeps data by default.** KV and the plugin's in-document `%%%` sections
 *   survive, so a reinstall is lossless; the purge checkbox is the explicit, separately
 *   confirmed act that strips them.
 * - **The breaker is visible and resettable.** Five consecutive failures disable a plugin
 *   until someone looks at it (SPEC §6.3), and "re-enable" clears the counter — otherwise the
 *   next call would be refused and the button would look broken.
 * - **A secret is write-only.** See `PluginConfig.tsx`.
 *
 * The server authorizes every route underneath; hiding a button here is a courtesy.
 */

import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { InstalledPlugin, PluginCapabilities } from "@kernel";

import {
  approvalProblems,
  formatBytes,
  formatWhen,
  hostPolicyNote,
  parseHostList,
  type AdminClient,
  type PluginAdminList,
  type PluginAdminView,
  type PluginCronState,
} from "./api.js";
import { useAsync, useMutation } from "./hooks.js";
import { PluginConfigForm } from "./PluginConfig.js";

export function PluginsSection({ client }: { readonly client: AdminClient }): ReactElement {
  const list = useAsync<PluginAdminList>(() => client.adminPlugins(), []);
  // The M3 read-only view, used only as a fallback: if the management endpoint cannot answer
  // (a server without the plugin host, or one that failed to reach Mongo), an admin should
  // still be able to see what is installed rather than an error and nothing else.
  const installed = useAsync(() => client.plugins(), []);

  const pending = useMemo(
    () => (list.data?.plugins ?? []).filter((plugin) => plugin.state === "pending"),
    [list.data],
  );
  const live = useMemo(
    () => (list.data?.plugins ?? []).filter((plugin) => plugin.state !== "pending"),
    [list.data],
  );

  return (
    <section className="admin-section" aria-labelledby="admin-plugins-heading">
      <h3 id="admin-plugins-heading">Plugins</h3>

      <div className="admin-callout">
        <p>
          <strong>Installing a plugin is an act of trust.</strong> Its frontend half runs
          unsandboxed in every user’s session, with full access to the page, the whole
          workspace and the signed-in credentials. The <code>capabilities</code> below gate
          only the <em>server</em> host functions and native bridge calls — they are not a
          sandbox for the browser half.
        </p>
        <p>
          Recovery if a plugin breaks the app: <code>?safe=1</code> boots the base
          distribution only, <code>?safe=bare</code> boots a minimal built-in plugin
          manager, and <code>DISABLE_PLUGINS=1</code> on the server disables every plugin.
        </p>
      </div>

      {list.data?.plugins_disabled === true && (
        <p className="admin-warning" role="status">
          <code>DISABLE_PLUGINS</code> is set on the server: no plugin is being served, no
          backend half is loaded and no cron fires. The app is running on the kernel’s
          built-ins alone.
        </p>
      )}

      {list.data?.install_lock != null && (
        <p className="admin-warning" role="status">
          An install is in progress (held by <code>{list.data.install_lock}</code>). Installs
          are serialized, so another upload will wait.
        </p>
      )}

      <UploadPanel client={client} list={list.data} onDone={() => list.reload()} />

      {list.error !== undefined && (
        <>
          <p className="admin-error" role="alert">
            The plugin management endpoint could not answer: {list.error}
          </p>
          <ReadOnlyFallback
            plugins={installed.data?.plugins ?? []}
            loading={installed.loading}
            error={installed.error}
          />
        </>
      )}

      {list.loading && <p role="status">Loading plugins…</p>}

      {list.data !== undefined && (
        <>
          <h4>
            Pending installs{pending.length > 0 ? ` (${pending.length})` : ""}
          </h4>
          {pending.length === 0 ? (
            <p className="admin-empty">
              Nothing is waiting for approval. An uploaded package, and any package dropped
              into the server’s inbox directory, appears here until an administrator approves
              it — nothing of it runs and nothing of it is served in the meantime.
            </p>
          ) : (
            <ul className="admin-plugins">
              {pending.map((plugin) => (
                <PendingCard
                  key={`${plugin.id}@${plugin.version}`}
                  client={client}
                  plugin={plugin}
                  onDone={() => list.reload()}
                />
              ))}
            </ul>
          )}

          <h4>Installed</h4>
          {live.length === 0 ? (
            <p className="admin-empty">
              No plugins installed. If the app is rendering, it is doing so in safe mode.
            </p>
          ) : (
            <ul className="admin-plugins">
              {live.map((plugin) => (
                <InstalledCard
                  key={plugin.id}
                  client={client}
                  plugin={plugin}
                  onDone={() => list.reload()}
                />
              ))}
            </ul>
          )}

          <HostSummary list={list.data} />

          {list.data.problems.length > 0 && (
            <>
              <h4>Directories the server could not load</h4>
              <ul className="admin-problems">
                {list.data.problems.map((problem) => (
                  <li key={`${problem.path}:${problem.message}`}>
                    <code>{problem.path}</code> — {problem.message}
                  </li>
                ))}
              </ul>
              <p className="admin-note">
                A bad plugin directory is never fatal: the server logs it, serves nothing from
                it, and reports it here.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function UploadPanel({
  client,
  list,
  onDone,
}: {
  readonly client: AdminClient;
  readonly list: PluginAdminList | undefined;
  readonly onDone: () => void;
}): ReactElement {
  const [file, setFile] = useState<File | undefined>(undefined);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const upload = useMutation(onDone);
  const cap = list?.limits.max_package_bytes;

  return (
    <form
      className="admin-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file) return;
        setOutcome(undefined);
        upload.run("upload", async () => {
          const result = await client.uploadPlugin(file);
          setOutcome(
            `${result.id} ${result.version} uploaded — ${result.state}` +
              (result.replaced != null ? `, replacing ${result.replaced}` : "") +
              (result.warnings.length > 0 ? `. Warnings: ${result.warnings.join("; ")}` : ""),
          );
          setFile(undefined);
        });
      }}
    >
      <div className="admin-field">
        <label htmlFor="admin-plugin-package">Install or upgrade a plugin (.zip)</label>
        <input
          id="admin-plugin-package"
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => setFile(event.target.files?.[0] ?? undefined)}
        />
        <p className="admin-note">
          The package lands <strong>pending</strong>: its capabilities are shown for approval
          and nothing of it runs or is served until an administrator approves it. Uploading a
          version of an already-installed plugin is how an upgrade happens — it goes through
          the same approval.
          {cap !== undefined && <> Maximum package size {formatBytes(cap)}.</>}
        </p>
      </div>
      {upload.error !== undefined && (
        <p className="admin-error" role="alert">
          {upload.error}
        </p>
      )}
      {outcome !== undefined && (
        <p className="admin-note" role="status">
          {outcome}
        </p>
      )}
      <div className="admin-actions">
        <button type="submit" disabled={!file || upload.busy !== undefined}>
          {upload.busy !== undefined ? "Uploading…" : "Upload package"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pending: the approval screen
// ---------------------------------------------------------------------------

function PendingCard({
  client,
  plugin,
  onDone,
}: {
  readonly client: AdminClient;
  readonly plugin: PluginAdminView;
  readonly onDone: () => void;
}): ReactElement {
  const requested = plugin.capabilities_requested;
  const [documents, setDocuments] = useState<readonly string[]>(requested.documents ?? []);
  const [notifications, setNotifications] = useState(requested.notifications === true);
  const [routes, setRoutes] = useState<readonly string[]>(requested["public-routes"] ?? []);
  const [hosts, setHosts] = useState((requested.http?.hosts ?? []).join(", "));
  const [confirmed, setConfirmed] = useState(false);
  const mutate = useMutation(onDone);

  const granted: PluginCapabilities = useMemo(() => {
    const value: {
      documents?: readonly ("read" | "write")[];
      http?: { hosts: readonly string[] };
      notifications?: boolean;
      "public-routes"?: readonly string[];
    } = {};
    if (documents.length > 0) value.documents = documents as readonly ("read" | "write")[];
    if (requested.http !== undefined) value.http = { hosts: parseHostList(hosts) };
    if (notifications) value.notifications = true;
    if (routes.length > 0) value["public-routes"] = routes;
    return value;
  }, [documents, hosts, notifications, routes, requested.http]);

  const problems = approvalProblems(requested, granted);
  const addedHosts = (granted.http?.hosts ?? []).filter(
    (host) => !(requested.http?.hosts ?? []).includes(host),
  );

  return (
    <li className="admin-plugin admin-plugin-pending">
      <PluginHead plugin={plugin} />

      <p className="admin-warning">
        <strong>Approving this plugin runs its frontend code in every user’s session.</strong>{" "}
        The capabilities below are the <em>server-side</em> grants only. Approve nothing you did
        not obtain yourself.
      </p>

      <fieldset className="admin-capabilities">
        <legend>Capabilities requested</legend>

        {(requested.documents?.length ?? 0) > 0 ? (
          (requested.documents ?? []).map((right) => (
            <label key={right}>
              <input
                type="checkbox"
                checked={documents.includes(right)}
                onChange={(event) =>
                  setDocuments((current) =>
                    event.target.checked
                      ? [...current, right]
                      : current.filter((value) => value !== right),
                  )
                }
              />
              <code>documents: {right}</code> — the whole shared workspace, every document
              every user can see
            </label>
          ))
        ) : (
          <p className="admin-note">
            <code>documents</code>: not requested. The document host functions are linked as
            erroring stubs.
          </p>
        )}

        {requested.http !== undefined && (
          <div className="admin-field">
            <label htmlFor={`admin-hosts-${plugin.id}`}>
              <code>http</code> — outbound requests, to these hosts only
            </label>
            <input
              id={`admin-hosts-${plugin.id}`}
              type="text"
              value={hosts}
              placeholder="calendar.example.com, feeds.example.net"
              onChange={(event) => setHosts(event.target.value)}
            />
            <p className="admin-note">
              Hosts are matched exactly — no wildcards, no scheme, no port. This is the one
              field an approval may <em>add</em> to: a plugin whose destination you configure
              cannot know the host when it is packaged.
              {requested.http.hosts.length === 0 && (
                <> This package requested none, so you are naming them.</>
              )}
            </p>
            {addedHosts.length > 0 && (
              <p className="admin-warning">
                Adding {addedHosts.map((host) => <code key={host}>{host}</code>)} — hosts the
                package itself did not ask for.
              </p>
            )}
            <HostPolicyNotes hosts={granted.http?.hosts ?? []} />
          </div>
        )}

        {requested.notifications === true && (
          <label>
            <input
              type="checkbox"
              checked={notifications}
              onChange={(event) => setNotifications(event.target.checked)}
            />
            <code>notifications</code> — native notification bridge
          </label>
        )}

        {(requested["public-routes"]?.length ?? 0) > 0 && (
          <div>
            <p className="admin-warning">
              This plugin asks for <strong>unauthenticated routes</strong>: anyone who can
              reach this server can call them, with no session.
            </p>
            {(requested["public-routes"] ?? []).map((route) => (
              <label key={route}>
                <input
                  type="checkbox"
                  checked={routes.includes(route)}
                  onChange={(event) =>
                    setRoutes((current) =>
                      event.target.checked
                        ? [...current, route]
                        : current.filter((value) => value !== route),
                    )
                  }
                />
                <code>
                  /api/plugins/{plugin.id}
                  {route}
                </code>{" "}
                — reachable without signing in
              </label>
            ))}
          </div>
        )}

        {plugin.has_backend ? (
          <p className="admin-note">
            Backend half: {describeBackend(plugin)}. Module SHA-256{" "}
            <code>{plugin.module_sha256 ?? "unknown"}</code>.
          </p>
        ) : (
          <p className="admin-note">
            No backend half: nothing of this plugin runs on the server, and no capability here
            applies to its browser code.
          </p>
        )}
      </fieldset>

      {Object.keys(plugin.config_schema).length > 0 && (
        <p className="admin-note">
          Configuration keys to fill in after approval:{" "}
          {Object.entries(plugin.config_schema)
            .map(([key, field]) => `${key}${field.secret === true ? " (secret)" : ""}`)
            .join(", ")}
          .
        </p>
      )}

      {problems.length > 0 && (
        <p className="admin-error" role="alert">
          This grant is not legal: {problems.join("; ")}. An approval may narrow anything and
          may only extend <code>http.hosts</code>.
        </p>
      )}

      <label className="admin-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I understand this plugin’s code will run unsandboxed in every user’s browser session.
      </label>

      {mutate.error !== undefined && (
        <p className="admin-error" role="alert">
          {mutate.error}
        </p>
      )}

      <div className="admin-actions">
        <button
          type="button"
          disabled={!confirmed || problems.length > 0 || mutate.busy !== undefined}
          onClick={() =>
            mutate.run("approve", () =>
              client.approvePlugin(plugin.id, plugin.version, granted),
            )
          }
        >
          {mutate.busy === "approve" ? "Approving…" : "Approve and enable"}
        </button>
        <button
          type="button"
          className="admin-danger"
          disabled={mutate.busy !== undefined}
          onClick={() => {
            if (!confirm(`Delete the pending package ${plugin.id} ${plugin.version}?`)) return;
            mutate.run("reject", () => client.rejectPlugin(plugin.id, plugin.version));
          }}
        >
          Reject and delete
        </button>
      </div>
    </li>
  );
}

/**
 * What the server's outbound IP policy will make of the hosts in the box — per host,
 * and only where there is something true to say.
 *
 * It replaces a single blanket sentence ("loopback, link-local, private and metadata
 * addresses stay blocked regardless") that was printed next to every added host. That
 * sentence was noise beside `example.com` and *wrong* beside `10.0.0.5`: an operator's
 * `PLUGIN_HTTP_ALLOW_CIDRS` is exactly what unblocks private ranges (SPEC §6.2), so
 * "regardless" promised something the server does not do. The metadata endpoints are
 * the only addresses that really are refused whatever the configuration, and now they
 * are the only ones the UI says so about.
 *
 * Notes are hints about the *literal that was typed*. The server resolves the name and
 * pins the address it got, and that is the enforcement; nothing here blocks approval.
 */
function HostPolicyNotes({ hosts }: { readonly hosts: readonly string[] }): ReactElement | null {
  const notes = hosts
    .map((host) => ({ host, note: hostPolicyNote(host) }))
    .filter((entry): entry is { host: string; note: NonNullable<typeof entry.note> } =>
      entry.note !== undefined,
    );
  if (notes.length === 0) return null;

  return (
    <ul className="admin-host-notes">
      {notes.map(({ host, note }) => (
        <li
          key={host}
          className={note.kind === "metadata" ? "admin-warning" : "admin-note"}
          data-kind={note.kind}
        >
          <code>{host}</code> is {note.message}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

function InstalledCard({
  client,
  plugin,
  onDone,
}: {
  readonly client: AdminClient;
  readonly plugin: PluginAdminView;
  readonly onDone: () => void;
}): ReactElement {
  const [purge, setPurge] = useState(false);
  const mutate = useMutation(onDone);
  const capabilities = describeCapabilities(plugin.capabilities_approved);

  return (
    <li className="admin-plugin">
      <PluginHead plugin={plugin} />

      {plugin.breaker.open && (
        <p className="admin-warning" role="status">
          <strong>The circuit breaker is open.</strong> The host disabled this plugin after
          repeated failures ({plugin.breaker.reason ?? "no reason recorded"}) and no call
          reaches it until it is re-enabled. Re-enabling clears the failure counter.
        </p>
      )}
      {plugin.breaker.by_admin && (
        <p className="admin-note" role="status">
          Disabled by an administrator. Its frontend half is still served; its backend half is
          not loaded.
        </p>
      )}
      {plugin.state === "failed" && (
        <p className="admin-warning" role="status">
          The backend half could not be activated: {plugin.last_error ?? "no reason recorded"}.
          The frontend half is still served — half a plugin is usually better than none.
        </p>
      )}
      {plugin.last_error != null && plugin.state !== "failed" && (
        <p className="admin-note">Last error: {plugin.last_error}</p>
      )}

      <dl className="admin-plugin-meta">
        <div>
          <dt>Installed</dt>
          <dd>
            {formatWhen(plugin.installed_at)} ({describeSource(plugin)})
          </dd>
        </div>
        <div>
          <dt>Approved</dt>
          <dd>{plugin.approved_at == null ? "—" : formatWhen(plugin.approved_at)}</dd>
        </div>
        <div>
          <dt>Backend half</dt>
          <dd>{plugin.has_backend ? describeBackend(plugin) : "none"}</dd>
        </div>
        <div>
          <dt>Kernel range</dt>
          <dd>
            <code>{plugin.manifest.kernel}</code>
          </dd>
        </div>
        <div>
          <dt>Dependencies</dt>
          <dd>{formatRanges(plugin.manifest.dependencies)}</dd>
        </div>
        <div>
          <dt>Peer libraries</dt>
          <dd>{formatRanges(plugin.manifest.peerLibraries)}</dd>
        </div>
      </dl>

      <div className="admin-plugin-capabilities">
        <strong>Approved capabilities:</strong>
        {capabilities.length === 0 ? (
          <span> none — no server host functions and no bridge calls</span>
        ) : (
          <ul>
            {capabilities.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
        {plugin.capabilities_differ && (
          <p className="admin-note">
            This differs from what the package requested (
            {describeCapabilities(plugin.capabilities_requested).join("; ") || "nothing"}). A
            narrowed plugin can fail in ways its author never tested.
          </p>
        )}
      </div>

      {plugin.routes.length > 0 && (
        <p className="admin-note">
          Routes:{" "}
          {plugin.routes
            .map(
              (route) =>
                `${route.method} /api/plugins/${plugin.id}${route.path}${route.public ? " (public)" : ""}`,
            )
            .join(", ")}
        </p>
      )}

      {plugin.cron.length > 0 && (
        <CronTable client={client} plugin={plugin} onDone={onDone} />
      )}

      <MetricsSummary plugin={plugin} />

      {Object.keys(plugin.config_schema).length > 0 && (
        <details className="admin-details">
          <summary>Configuration</summary>
          <PluginConfigForm client={client} plugin={plugin} />
        </details>
      )}

      <details className="admin-details">
        <summary>Recent host events</summary>
        <PluginLogs client={client} plugin={plugin} />
      </details>

      {mutate.error !== undefined && (
        <p className="admin-error" role="alert">
          {mutate.error}
        </p>
      )}

      <div className="admin-actions">
        {plugin.state === "enabled" ? (
          <button
            type="button"
            disabled={mutate.busy !== undefined}
            onClick={() => mutate.run("disable", () => client.disablePlugin(plugin.id))}
          >
            {mutate.busy === "disable" ? "Disabling…" : "Disable"}
          </button>
        ) : (
          <button
            type="button"
            disabled={mutate.busy !== undefined}
            onClick={() => mutate.run("enable", () => client.enablePlugin(plugin.id))}
          >
            {mutate.busy === "enable"
              ? "Enabling…"
              : plugin.breaker.open
                ? "Re-enable and clear the breaker"
                : "Enable"}
          </button>
        )}

        <label className="admin-confirm">
          <input
            type="checkbox"
            checked={purge}
            onChange={(event) => setPurge(event.target.checked)}
          />
          also delete this plugin’s data (its key-value store and its <code>%%%</code> sections
          in every document)
        </label>
        <button
          type="button"
          className="admin-danger"
          disabled={mutate.busy !== undefined}
          onClick={() => {
            const message = purge
              ? `Uninstall ${plugin.id} AND permanently delete its stored data and its %%% sections from every document? This cannot be undone.`
              : `Uninstall ${plugin.id}? Its key-value data and its %%% sections are kept, so a reinstall picks up where it left off.`;
            if (!confirm(message)) return;
            mutate.run("uninstall", () => client.uninstallPlugin(plugin.id, purge));
          }}
        >
          {mutate.busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
        </button>
      </div>
      {plugin.base && (
        <p className="admin-note">
          This is part of the base distribution. Uninstalling it removes a part of the visible
          app — that is by design (the base set is installed like any other plugin), but
          <code>?safe=bare</code> is the way back if it was the wrong one.
        </p>
      )}
    </li>
  );
}

function CronTable({
  client,
  plugin,
  onDone,
}: {
  readonly client: AdminClient;
  readonly plugin: PluginAdminView;
  readonly onDone: () => void;
}): ReactElement {
  const [result, setResult] = useState<string | undefined>(undefined);
  const mutate = useMutation(onDone);

  return (
    <div className="admin-plugin-cron">
      <strong>Scheduled jobs</strong> <span className="admin-note">(UTC; missed runs are skipped)</span>
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Expression</th>
            <th scope="col">Last run</th>
            <th scope="col">Status</th>
            <th scope="col">Runs</th>
            <th scope="col">Failures</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {plugin.cron.map((job: PluginCronState) => (
            <tr key={job.index}>
              <td>
                <code>{job.expression}</code>
              </td>
              <td>{formatWhen(job.last_run)}</td>
              <td>{job.last_status ?? "—"}</td>
              <td>{job.runs}</td>
              <td>{job.failures}</td>
              <td>
                <button
                  type="button"
                  disabled={!plugin.active || mutate.busy !== undefined}
                  title={
                    plugin.active
                      ? "Run this job now. The schedule is not moved."
                      : "The backend half is not loaded, so there is nothing to run."
                  }
                  onClick={() => {
                    setResult(undefined);
                    mutate.run(`cron-${job.index}`, async () => {
                      const run = await client.runPluginCron(plugin.id, job.index);
                      setResult(
                        `Ran in ${run.duration_ms} ms, ${run.writes} document write(s), ${run.logs} log line(s).`,
                      );
                    });
                  }}
                >
                  {mutate.busy === `cron-${job.index}` ? "Running…" : "Run now"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mutate.error !== undefined && (
        <p className="admin-error" role="alert">
          {mutate.error}
        </p>
      )}
      {result !== undefined && (
        <p className="admin-note" role="status">
          {result}
        </p>
      )}
    </div>
  );
}

function MetricsSummary({ plugin }: { readonly plugin: PluginAdminView }): ReactElement {
  const metrics = plugin.metrics;
  return (
    <p className="admin-note">
      Cron: {metrics.cron_jobs} job(s), {metrics.cron_runs} run(s), {metrics.cron_failures}{" "}
      failure(s)
      {metrics.last_cron_run != null && <> · last {formatWhen(metrics.last_cron_run)}</>}
      {metrics.last_cron_status != null && <> ({metrics.last_cron_status})</>} ·{" "}
      {metrics.recent_events} recent host event(s). Per-call latency and failure counts are on{" "}
      <code>/metrics</code>, labelled by plugin.
    </p>
  );
}

function PluginLogs({
  client,
  plugin,
}: {
  readonly client: AdminClient;
  readonly plugin: PluginAdminView;
}): ReactElement {
  const logs = useAsync(() => client.pluginLogs(plugin.id), [plugin.id]);
  if (logs.error !== undefined) {
    return (
      <p className="admin-error" role="alert">
        {logs.error}
      </p>
    );
  }
  if (logs.loading) return <p role="status">Loading…</p>;
  const events = logs.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="admin-empty">
        Nothing recorded for this plugin since the server started. This list lives in memory;
        the audit log is the durable record.
      </p>
    );
  }
  return (
    <ul className="admin-events">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className={`admin-event admin-event-${event.level}`}>
          <code>{formatWhen(event.at)}</code> {event.message}
        </li>
      ))}
    </ul>
  );
}

function HostSummary({ list }: { readonly list: PluginAdminList }): ReactElement {
  const { host, limits } = list;
  return (
    <div className="admin-plugin-host">
      <h4>Plugin host</h4>
      <p className="admin-note">
        {host.active} backend half/halves active, {host.disabled} disabled, {host.instances}{" "}
        pooled instance(s), {host.calls_in_flight} call(s) in flight, {host.cron_jobs} cron
        job(s) scheduled, {host.hooks_pending} hook(s) pending. Host ABI version{" "}
        {list.abi_version}.
      </p>
      <p className="admin-note">
        Limits this server applies: {limits.call_timeout_ms} ms per call,{" "}
        {limits.cron_timeout_ms} ms per cron run, {formatBytes(limits.memory_bytes)} memory,{" "}
        {limits.max_instances} instance(s) per plugin, breaker after {limits.breaker_threshold}{" "}
        consecutive failures, {limits.http_timeout_ms} ms outbound timeout and{" "}
        {formatBytes(limits.max_http_response_bytes)} response cap.
        {!limits.cron_enabled && <> Cron is disabled on this server.</>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function PluginHead({ plugin }: { readonly plugin: PluginAdminView }): ReactElement {
  return (
    <>
      <p className="admin-plugin-head">
        <strong>{plugin.manifest.name ?? plugin.id}</strong>
        <code>
          {plugin.id}@{plugin.version}
        </code>
        <span className={`admin-status admin-status-${plugin.state}`}>{plugin.state}</span>
        {plugin.active && <span className="admin-badge">backend loaded</span>}
        {plugin.base && <span className="admin-badge">base</span>}
        {!plugin.served && plugin.state !== "pending" && (
          <span className="admin-badge">not served</span>
        )}
      </p>
      {plugin.manifest.description !== undefined && (
        <p className="admin-plugin-description">{plugin.manifest.description}</p>
      )}
    </>
  );
}

/** The M3 read-only list, shown only when the management endpoint fails. */
function ReadOnlyFallback({
  plugins,
  loading,
  error,
}: {
  readonly plugins: readonly InstalledPlugin[];
  readonly loading: boolean;
  readonly error: string | undefined;
}): ReactElement {
  if (loading) return <p role="status">Loading the installed set…</p>;
  if (error !== undefined) {
    return (
      <p className="admin-error" role="alert">
        {error}
      </p>
    );
  }
  return (
    <>
      <p className="admin-note">
        Showing the read-only installed set instead. Approval, configuration and enable/disable
        need the management endpoint above.
      </p>
      <ul className="admin-plugins">
        {plugins.map((plugin) => (
          <li className="admin-plugin" key={plugin.manifest.id}>
            <p className="admin-plugin-head">
              <strong>{plugin.manifest.name ?? plugin.manifest.id}</strong>
              <code>
                {plugin.manifest.id}@{plugin.manifest.version}
              </code>
              <span className={`admin-status admin-status-${plugin.state}`}>{plugin.state}</span>
              {plugin.base && <span className="admin-badge">base</span>}
            </p>
            <div className="admin-plugin-capabilities">
              <strong>Capabilities:</strong>
              {describeCapabilities(plugin.manifest.capabilities).length === 0 ? (
                <span> none declared</span>
              ) : (
                <ul>
                  {describeCapabilities(plugin.manifest.capabilities).map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One readable line per declared capability. Counts hide exactly what matters here. */
export function describeCapabilities(
  capabilities: PluginCapabilities | undefined,
): readonly string[] {
  if (!capabilities) return [];
  const lines: string[] = [];
  if (capabilities.documents?.length) {
    lines.push(`documents: ${capabilities.documents.join(", ")} — the whole shared workspace`);
  }
  if (capabilities.http?.hosts.length) {
    lines.push(`outbound HTTP to ${capabilities.http.hosts.join(", ")}`);
  } else if (capabilities.http !== undefined) {
    lines.push("outbound HTTP requested with no host approved — every request is refused");
  }
  if (capabilities.notifications === true) lines.push("notifications");
  const publicRoutes = capabilities["public-routes"];
  if (publicRoutes?.length) {
    lines.push(
      `unauthenticated routes: ${publicRoutes.join(", ")} — reachable without signing in`,
    );
  }
  return lines;
}

/** `hooks`, `cron` and `events` as one phrase. */
export function describeBackend(plugin: PluginAdminView): string {
  const parts: string[] = [];
  if (plugin.hooks.length > 0) parts.push(`hooks ${plugin.hooks.join(", ")}`);
  if (plugin.cron.length > 0) {
    parts.push(`cron ${plugin.cron.map((job) => job.expression).join(", ")}`);
  }
  if (plugin.routes.length > 0) parts.push(`${plugin.routes.length} route(s)`);
  if (plugin.events.length > 0) parts.push(`events ${plugin.events.join(", ")}`);
  return parts.length === 0 ? "loaded, no hooks, cron or routes" : parts.join("; ");
}

export function describeSource(plugin: PluginAdminView): string {
  const source = plugin.source;
  switch (source.kind) {
    case "upload":
      return `uploaded as ${source.filename}`;
    case "directory":
      return `dropped into ${source.path}`;
    default:
      return "shipped with the server";
  }
}

function formatRanges(ranges: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(ranges ?? {});
  if (entries.length === 0) return "none";
  return entries.map(([name, range]) => `${name} ${range}`).join(", ");
}
