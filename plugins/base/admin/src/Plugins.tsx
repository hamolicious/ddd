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

import { useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { InstalledPlugin, PluginCapabilities } from "@kernel";

import {
  approvalProblems,
  formatBytes,
  formatWhen,
  hostPolicyNote,
  isStaleBase,
  parseHostList,
  type AdminClient,
  type PluginAdminList,
  type PluginAdminView,
  type PluginCronState,
  type WiringHistory,
  type WiringVersionInfo,
} from "./api.js";
import { AdminSectionFrame } from "./AdminView.js";
import { useAsync, useConfirm, useModal, useMutation, useWiringEditor } from "./hooks.js";
import { CheckIcon, ChevronIcon, PlayIcon, PowerIcon, TrashIcon, UploadIcon } from "./icons.js";
import { adminOfflineCopy } from "./offline.js";
import { PluginConfigForm } from "./PluginConfig.js";
import { useOfflineCopy } from "../../_shared/offline-copy.js";

export function PluginsSection({
  client,
  embedded,
}: {
  readonly client: AdminClient;
  readonly embedded?: boolean;
}): ReactElement {
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
    <AdminSectionFrame id="plugins" title="Plugins" embedded={embedded}>
      {/* Both halves always show: the recovery line is short, and it is what you need
          when something is already broken. */}
      <div className="admin-callout">
        <p className="admin:m-0">
          <strong>Installing a plugin is an act of trust.</strong> Its frontend half runs
          unsandboxed in every user’s session, with full access to the page, the whole
          workspace and the signed-in credentials. The <code>capabilities</code> below gate
          only the <em>server</em> host functions and native bridge calls — they are not a
          sandbox for the browser half.
        </p>
        <p className="admin-note">
          <strong className="admin:text-text">If a plugin breaks the app:</strong>{" "}
          <code>?safe=1</code> boots the base distribution only, <code>?safe=bare</code> a
          minimal built-in plugin manager, and <code>DISABLE_PLUGINS=1</code> on the server
          turns every plugin off for every client.
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
            <p className="admin-empty">Nothing is waiting for approval.</p>
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

          <h4>Installed ({live.length})</h4>
          {live.length === 0 ? (
            <p className="admin-empty">No plugins installed.</p>
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

          {/* Keyed on the list's data: disabling a plugin above writes a wiring version
              (unplug is disable), so the card reloads with the list. */}
          <WiringCard key={list.data.plugins.map((plugin) => `${plugin.id}:${plugin.state}`).join(",")} client={client} onApplied={() => list.reload()} />

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
    </AdminSectionFrame>
  );
}

/** The accent fill for the one button a card is for (Approve). */
const PRIMARY = "admin:border-accent! admin:bg-accent! admin:text-accent-text!";

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
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const upload = useMutation(onDone);
  const cap = list?.limits.max_package_bytes;
  const busy = upload.busy !== undefined;

  // Choosing is uploading: a package only lands pending, and approving it is the act.
  const send = (file: File | undefined): void => {
    if (!file || busy) return;
    setOutcome(undefined);
    upload.run(file.name, async () => {
      const result = await client.uploadPlugin(file);
      setOutcome(
        `${result.id} ${result.version} uploaded — ${result.state}` +
          (result.replaced != null ? `, replacing ${result.replaced}` : "") +
          (result.warnings.length > 0 ? `. Warnings: ${result.warnings.join("; ")}` : ""),
      );
    });
    if (input.current) input.current.value = "";
  };

  return (
    <div className="admin:flex admin:flex-col admin:gap-2">
      <div
        className={`admin-upload admin:flex admin:flex-wrap admin:items-center admin:gap-3 admin:rounded-lg admin:border-2 admin:border-dashed admin:p-3 ${over ? "admin:border-accent admin:bg-accent-subtle" : "admin:border-border admin:bg-bg-subtle"}`}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          send(event.dataTransfer.files[0]);
        }}
      >
        <span className="admin:flex admin:size-10 admin:shrink-0 admin:items-center admin:justify-center admin:rounded-full admin:bg-bg admin:text-text-muted admin:text-xl">
          <UploadIcon />
        </span>
        <div className="admin:flex admin:min-w-48 admin:flex-1 admin:flex-col admin:gap-0.5">
          <strong>Install or upgrade a plugin</strong>
          <span className="admin:text-sm admin:text-text-muted">
            Drop a <code>.zip</code> here or choose one. It waits for your approval; nothing
            runs until then.{cap !== undefined && <> Up to {formatBytes(cap)}.</>}
          </span>
        </div>
        <label className="admin:tap-h admin:inline-flex admin:cursor-pointer admin:items-center admin:gap-1.5 admin:rounded admin:border admin:border-accent admin:bg-accent admin:px-3 admin:text-accent-text admin:has-[:focus-visible]:outline-2 admin:has-[:focus-visible]:outline-offset-1 admin:has-[:focus-visible]:outline-focus">
          <input
            ref={input}
            className="admin:sr-only"
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => send(event.target.files?.[0])}
          />
          {busy ? `Uploading ${upload.busy}…` : "Choose a package"}
        </label>
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
    </div>
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
  const confirm = useConfirm();

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
    <li className="admin-plugin admin-plugin-pending admin:border-s-4! admin:border-s-warning!">
      <PluginHead plugin={plugin} />

      <p className="admin-warning">
        <strong>Approving this plugin runs its frontend code in every user’s session.</strong>{" "}
        The capabilities below are the <em>server-side</em> grants only. Approve nothing you did
        not obtain yourself.
      </p>

      <fieldset className="admin-capabilities admin:m-0 admin:flex admin:flex-col admin:gap-2 admin:rounded admin:border admin:border-border admin:p-2 admin:[&_legend]:px-1 admin:[&_legend]:font-semibold admin:[&_label]:tap-h admin:[&_label]:flex admin:[&_label]:items-start admin:[&_label]:gap-2 admin:[&_label_input]:size-6 admin:[&_label_input]:accent-accent">
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
              Hosts match exactly: no wildcards, no scheme, no port. This is the one field
              an approval may <em>add</em> to: a plugin whose destination you configure
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

      <label className="admin-confirm admin:tap-h admin:flex admin:items-start admin:gap-2 admin:text-[0.9em] admin:text-text admin:[&_input]:mt-[0.35em] admin:[&_input]:size-6 admin:[&_input]:flex-none admin:[&_input]:accent-accent">
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
          className={`admin-icon-button ${PRIMARY}`}
          aria-label={`Approve and enable ${plugin.id} ${plugin.version}`}
          title="Approve and enable"
          disabled={!confirmed || problems.length > 0 || mutate.busy !== undefined}
          onClick={() =>
            mutate.run("approve", () =>
              client.approvePlugin(plugin.id, plugin.version, granted),
            )
          }
        >
          <CheckIcon />
        </button>
        <button
          type="button"
          className="admin-danger admin-icon-button"
          aria-label={`Reject and delete ${plugin.id} ${plugin.version}`}
          title="Reject and delete"
          disabled={mutate.busy !== undefined}
          onClick={(event) => {
            void confirm({
              title: `Delete the pending package ${plugin.id} ${plugin.version}?`,
              confirmLabel: "Reject and delete",
              danger: true,
              anchor: event.currentTarget,
            }).then((ok) => {
              if (ok) mutate.run("reject", () => client.rejectPlugin(plugin.id, plugin.version));
            });
          }}
        >
          <TrashIcon />
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
    <ul className="admin-host-notes admin:m-0 admin:flex admin:list-none admin:flex-col admin:gap-1 admin:p-0">
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
  const [open, setOpen] = useState(false);
  const mutate = useMutation(onDone);
  const modal = useModal();
  const capabilities = describeCapabilities(plugin.capabilities_approved);
  const name = plugin.manifest.name ?? plugin.id;
  const enabled = plugin.state === "enabled";
  const toggleLabel = enabled ? "Disable" : plugin.breaker.open ? "Re-enable and clear the breaker" : "Enable";
  const detailsId = `admin-plugin-details-${plugin.id}`;

  return (
    <li className="admin-plugin admin:flex admin:flex-col admin:gap-2">
      <div className="admin:flex admin:items-start admin:gap-2">
        <div className="admin:min-w-0 admin:flex-1">
          <PluginHead plugin={plugin} />
        </div>
        <div className="admin-actions admin:shrink-0">
          <button
            type="button"
            className={`admin-icon-button ${enabled ? "" : "admin:text-text-muted"}`}
            aria-label={`${toggleLabel} ${name}`}
            aria-pressed={enabled}
            title={toggleLabel}
            disabled={mutate.busy !== undefined}
            onClick={() =>
              enabled
                ? mutate.run("disable", () => client.disablePlugin(plugin.id))
                : mutate.run("enable", () => client.enablePlugin(plugin.id))
            }
          >
            <PowerIcon />
          </button>
          <button
            type="button"
            className="admin-danger admin-icon-button"
            aria-label={`Uninstall ${name}`}
            title="Uninstall"
            disabled={mutate.busy !== undefined}
            onClick={(event) => {
              void modal({
                title: `Uninstall ${name}?`,
                description: plugin.base ? (
                  <>
                    It is part of the base app, so that part goes with it.{" "}
                    <code>?safe=bare</code> is the way back.
                  </>
                ) : undefined,
                fields: [
                  {
                    kind: "checkbox",
                    id: "purge",
                    label: "Also delete its data",
                    hint: "Its key-value store and its %%% sections in every document. This cannot be undone; without it, a reinstall picks up where it left off.",
                  },
                ],
                buttons: [
                  { id: "cancel", label: "Cancel", dismiss: true },
                  { id: "uninstall", label: "Uninstall", tone: "danger", default: true },
                ],
                anchor: event.currentTarget,
              }).then((result) => {
                if (!result) return;
                const purge = result.values["purge"] === true;
                mutate.run("uninstall", () => client.uninstallPlugin(plugin.id, purge));
              });
            }}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            className="admin-icon-button"
            aria-label={`Details for ${name}`}
            title={open ? "Hide details" : "Details"}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            <span className={`admin:inline-flex ${open ? "admin:rotate-180" : ""}`}>
              <ChevronIcon />
            </span>
          </button>
        </div>
      </div>

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
          The frontend half is still served.
        </p>
      )}
      {plugin.last_error != null && plugin.state !== "failed" && (
        <p className="admin-note">Last error: {plugin.last_error}</p>
      )}
      {mutate.error !== undefined && (
        <p className="admin-error" role="alert">
          {mutate.error}
        </p>
      )}

      {/* A class, not `hidden`: the flex utility would win over the attribute. */}
      <div
        id={detailsId}
        className={`${open ? "admin:flex" : "admin:hidden"} admin:flex-col admin:gap-3 admin:border-t admin:border-border admin:pt-2`}
      >
        {open && (
          <>
            <Facts
              rows={[
                ["Source", describeSource(plugin)],
                ["Installed", formatWhen(plugin.installed_at)],
                ["Approved", plugin.approved_at == null ? "—" : formatWhen(plugin.approved_at)],
                ["Server part", plugin.has_backend ? describeBackend(plugin) : "None; it runs in the browser only"],
                ["Kernel", <code key="kernel">{plugin.manifest.kernel}</code>],
                ["Consumes", formatConsumed(plugin.manifest.consumes)],
                ["Libraries", formatRanges(plugin.manifest.peerLibraries)],
                [
                  "Capabilities",
                  capabilities.length === 0 ? (
                    "None"
                  ) : (
                    <ul key="capabilities" className="admin:m-0 admin:pl-4">
                      {capabilities.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  ),
                ],
                ...(plugin.capabilities_differ
                  ? ([
                      [
                        "Requested",
                        `${describeCapabilities(plugin.capabilities_requested).join("; ") || "nothing"}. A narrowed plugin can fail in ways its author never tested.`,
                      ],
                    ] as const)
                  : []),
                ...(plugin.routes.length > 0
                  ? ([
                      [
                        "Routes",
                        plugin.routes
                          .map(
                            (route) =>
                              `${route.method} /api/plugins/${plugin.id}${route.path}${route.public ? " (public)" : ""}`,
                          )
                          .join(", "),
                      ],
                    ] as const)
                  : []),
                ...(plugin.has_backend ? ([["Activity", <Activity key="activity" plugin={plugin} />]] as const) : []),
              ]}
            />

            {plugin.cron.length > 0 && (
              <DetailSection title="Scheduled jobs">
                <CronTable client={client} plugin={plugin} onDone={onDone} />
              </DetailSection>
            )}

            {Object.keys(plugin.config_schema).length > 0 && (
              <DetailSection title="Configuration">
                <PluginConfigForm client={client} plugin={plugin} />
              </DetailSection>
            )}

            <DetailSection title="Recent host events">
              <PluginLogs client={client} plugin={plugin} />
            </DetailSection>
          </>
        )}
      </div>
    </li>
  );
}

/** Label on the left, value on the right; one column of labels for the whole card. */
function Facts({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): ReactElement {
  return (
    <dl className="admin:m-0 admin:grid admin:grid-cols-[minmax(6rem,9rem)_1fr] admin:gap-x-3 admin:gap-y-1.5 admin:text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="admin:contents">
          <dt className="admin:text-text-muted">{label}</dt>
          <dd className="admin:m-0 admin:min-w-0 admin:break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailSection({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return (
    <section className="admin:flex admin:flex-col admin:gap-1">
      <h5 className="admin:m-0 admin:text-xs admin:font-semibold admin:uppercase admin:tracking-[0.04em] admin:text-text-muted">
        {title}
      </h5>
      {children}
    </section>
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
    <div className="admin-plugin-cron admin:flex admin:flex-col admin:gap-1">
      <span className="admin-note">In UTC; missed runs are skipped.</span>
      {/* The one table in this plugin with no `.admin-table-scroll` parent, and six
          columns to overflow with. It is invisible in a workspace whose plugins are all
          frontend-only, which is why nothing caught it. */}
      <div className="admin-table-scroll">
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
                <th scope="row">
                  <code>{job.expression}</code>
                </th>
                <td data-label="Last run">{formatWhen(job.last_run)}</td>
                <td data-label="Status">{job.last_status ?? "—"}</td>
                <td data-label="Runs">{job.runs}</td>
                <td data-label="Failures">{job.failures}</td>
                <td className="admin-actions">
                  <button
                    type="button"
                    className="admin-icon-button"
                    aria-label={`Run ${job.expression} now`}
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
                    <PlayIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

/** A backend half's cron and host-event counts, one line. */
function Activity({ plugin }: { readonly plugin: PluginAdminView }): ReactElement {
  const metrics = plugin.metrics;
  return (
    <>
      {metrics.cron_jobs} cron job(s), {metrics.cron_runs} run(s), {metrics.cron_failures}{" "}
      failure(s)
      {metrics.last_cron_run != null && <>, last {formatWhen(metrics.last_cron_run)}</>}
      {metrics.last_cron_status != null && <> ({metrics.last_cron_status})</>}; {metrics.recent_events}{" "}
      recent host event(s). Per-call timings are on <code>/metrics</code>.
    </>
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
      <p className="admin-empty">Nothing recorded since the server started.</p>
    );
  }
  return (
    <ul className="admin-events admin:mb-0 admin:mt-2 admin:flex admin:max-h-[18rem] admin:list-none admin:flex-col admin:gap-1 admin:overflow-y-auto admin:p-0 admin:text-[0.9em] admin:compact:max-h-none">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className={`admin-event admin-event-${event.level} admin:rounded admin:bg-bg-subtle admin:px-2 admin:py-1 ${event.level === "warn" ? "admin:border-s-[3px] admin:border-s-warning" : event.level === "error" ? "admin:border-s-[3px] admin:border-s-danger" : ""}`}>
          <code>{formatWhen(event.at)}</code> {event.message}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Wiring: the live version, its history, and rollback (PLUGIN-PROTOCOLS §6c, §7)
// ---------------------------------------------------------------------------

/**
 * The way back without the graph. Every applied wiring version is kept on the server;
 * rolling back re-applies an older one **as a new version**, through the same apply
 * route the editor uses, with the live version as its base. A stale base is a 409, and
 * the answer to that is to show the newer live version, not to overwrite it.
 *
 * Offline the card shows the last loaded copy (the section's note says so) and the
 * actions are off: the server is the only place a version can be written.
 */
function WiringCard({
  client,
  onApplied,
}: {
  readonly client: AdminClient;
  /** A rollback can plug plugins back in, so the list above reloads too. */
  readonly onApplied: () => void;
}): ReactElement {
  const wiring = useAsync<WiringHistory>(() => client.wiring(), []);
  const confirm = useConfirm();
  const editor = useWiringEditor();
  const offline = useOfflineCopy(adminOfflineCopy) !== undefined;
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const mutate = useMutation(() => {
    wiring.reload();
    onApplied();
  });
  const live = wiring.data?.live;
  const busy = mutate.busy !== undefined;

  const rollBack = (entry: WiringVersionInfo, anchor: HTMLElement): void => {
    if (live === undefined) return;
    const base = live.version;
    void confirm({
      title: `Roll back to wiring version ${entry.version}?`,
      description: `Version ${base} is live. Version ${entry.version} is applied again as version ${base + 1}; nothing is deleted.`,
      confirmLabel: "Roll back",
      anchor,
    }).then((ok) => {
      if (!ok) return;
      setNotice(undefined);
      mutate.run(`rollback-${entry.version}`, async () => {
        const record = await client.wiringVersion(entry.version);
        try {
          await client.applyWiring({ base, wiring: record.wiring, action: "rollback" });
        } catch (error) {
          if (!isStaleBase(error)) throw error;
          // Someone applied a version in between. The reload shows it; say why nothing moved.
          const latest = await client.wiring();
          setNotice(
            `The live wiring moved on to version ${latest.live.version} in the meantime; nothing was changed. Choose again from the current list.`,
          );
        }
      });
    });
  };

  return (
    <section className="admin-wiring admin:flex admin:flex-col admin:gap-2" aria-labelledby="admin-wiring-heading">
      <h4 id="admin-wiring-heading">Wiring</h4>

      {wiring.error !== undefined && (
        <p className="admin-error" role="alert">
          The wiring could not be read: {wiring.error}
        </p>
      )}
      {wiring.loading && <p role="status">Loading wiring…</p>}

      {wiring.data !== undefined && live !== undefined && (
        <>
          <div className="admin:flex admin:flex-wrap admin:items-center admin:gap-2">
            <p className="admin-plugin-head admin:m-0">
              <strong>Live version {live.version}</strong>
              {live.unplugged.length > 0 && (
                <span className="admin-badge">{live.unplugged.length} unplugged</span>
              )}
            </p>
            {editor.available() && (
              <button type="button" onClick={() => editor.open()}>
                Open the graph editor
              </button>
            )}
          </div>
          <p className="admin-note">
            Rolling back applies an older version as a new one; every version is kept.
          </p>

          {wiring.data.history.length === 0 ? (
            <p className="admin-empty">No versions recorded yet.</p>
          ) : (
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Action</th>
                    <th scope="col">By</th>
                    <th scope="col">When</th>
                    <th scope="col">
                      <span className="admin:sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {wiring.data.history.map((entry) => (
                    <tr key={entry.version} data-wiring-version={entry.version}>
                      <th scope="row">
                        {entry.version}
                        {entry.version === live.version && <span className="admin-badge">live</span>}
                      </th>
                      <td data-label="Action">
                        <code>{entry.action}</code>
                        {entry.subject !== undefined && <> {entry.subject}</>}
                      </td>
                      <td data-label="By">{entry.actor ?? "—"}</td>
                      <td data-label="When">{formatWhen(entry.at)}</td>
                      <td className="admin-actions">
                        {entry.version !== live.version && (
                          <button
                            type="button"
                            aria-label={`Roll back to version ${entry.version}`}
                            title={offline ? "Not while offline" : `Apply version ${entry.version} again`}
                            disabled={offline || busy}
                            onClick={(event) => rollBack(entry, event.currentTarget)}
                          >
                            Roll back
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {mutate.error !== undefined && (
            <p className="admin-error" role="alert">
              {mutate.error}
            </p>
          )}
          {notice !== undefined && (
            <p className="admin-note" role="status">
              {notice}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function HostSummary({ list }: { readonly list: PluginAdminList }): ReactElement {
  const { host, limits } = list;
  return (
    <>
      <h4>Plugin host</h4>
      <dl className="admin-stats">
        <Stat label="Backends active" value={host.active} />
        <Stat label="Disabled" value={host.disabled} />
        <Stat label="Pooled instances" value={host.instances} />
        <Stat label="Calls in flight" value={host.calls_in_flight} />
        <Stat label="Cron jobs" value={limits.cron_enabled ? host.cron_jobs : "off"} />
        <Stat label="Hooks pending" value={host.hooks_pending} />
        <Stat label="Host ABI" value={list.abi_version} />
      </dl>
      <h4>Limits per plugin</h4>
      <dl className="admin-stats">
        <Stat label="Per call" value={`${limits.call_timeout_ms} ms`} />
        <Stat label="Per cron run" value={`${limits.cron_timeout_ms} ms`} />
        <Stat label="Memory" value={formatBytes(limits.memory_bytes)} />
        <Stat label="Instances" value={limits.max_instances} />
        <Stat label="Breaker after" value={`${limits.breaker_threshold} failures`} />
        <Stat label="Outbound timeout" value={`${limits.http_timeout_ms} ms`} />
        <Stat label="Response cap" value={formatBytes(limits.max_http_response_bytes)} />
      </dl>
    </>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: ReactNode }): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
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
            <div className="admin-plugin-capabilities admin:mb-0 admin:mt-2">
              <strong>Capabilities:</strong>
              {describeCapabilities(plugin.manifest.capabilities).length === 0 ? (
                <span> none declared</span>
              ) : (
                <ul className="admin:mb-0 admin:mt-1 admin:pl-5">
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

/** `lm/router@^1.0` on any port → `lm/router ^1.0`, each protocol once, sorted. */
function formatConsumed(ports: Readonly<Record<string, { readonly protocol: string }>> | undefined): string {
  const protocols = [...new Set(Object.values(ports ?? {}).map((port) => port.protocol.replace("@", " ")))].sort();
  return protocols.length === 0 ? "none" : protocols.join(", ");
}

function formatRanges(ranges: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(ranges ?? {});
  if (entries.length === 0) return "none";
  return entries.map(([name, range]) => `${name} ${range}`).join(", ");
}
