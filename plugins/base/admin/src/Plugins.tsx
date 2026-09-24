/**
 * The installed-plugin list. **Read-only in M3.**
 *
 * Approving a pending install, editing plugin config and enabling or disabling a plugin are
 * M4 endpoints (SPEC §6.2). Rendering controls for them now would ship buttons that 404,
 * so what this screen does instead is everything that is true today:
 *
 * - the installed set, with each plugin's version, dependencies and `peerLibraries`;
 * - its **declared capabilities**, spelled out rather than as a count, because that list is
 *   what an admin is being asked to accept;
 * - the plugin directories the server could not read (`problems`), which is the difference
 *   between "not installed" and "installed and broken";
 * - `DISABLE_PLUGINS=1`, the server-side half of safe mode;
 * - and **SPEC §6.1's trust sentence, verbatim in substance**: installing a plugin runs its
 *   frontend code unsandboxed in every user's session, with full access to the DOM, the
 *   workspace and the signed-in credentials. `capabilities` gate *server* host functions and
 *   native bridge calls only. That is the honest framing the install UI is required to give,
 *   and it belongs next to the list whether or not there is an Install button.
 */

import type { ReactElement } from "react";

import type { InstalledPlugin, PluginCapabilities } from "@kernel";

import type { AdminClient } from "./api.js";
import { useAsync } from "./hooks.js";

export function PluginsSection({ client }: { readonly client: AdminClient }): ReactElement {
  const installed = useAsync(() => client.plugins(), []);
  const plugins = installed.data?.plugins ?? [];
  const problems = installed.data?.problems ?? [];

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

      <p className="admin-note">
        This list is read-only. Uploading, approving, configuring, enabling and disabling
        plugins arrive with the backend plugin host (M4).
      </p>

      {installed.error && (
        <p className="admin-error" role="alert">
          {installed.error}
        </p>
      )}

      {installed.data?.disabled === true && (
        <p className="admin-warning" role="status">
          <code>DISABLE_PLUGINS</code> is set on the server: no plugin is being served, and
          the app is running on the kernel’s built-ins alone.
        </p>
      )}

      {installed.loading ? (
        <p role="status">Loading plugins…</p>
      ) : plugins.length === 0 ? (
        <p className="admin-empty">
          No plugins installed. If the app is rendering, it is doing so in safe mode.
        </p>
      ) : (
        <ul className="admin-plugins">
          {plugins.map((plugin) => (
            <PluginCard key={plugin.manifest.id} plugin={plugin} />
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        <>
          <h4>Directories the server could not load</h4>
          <ul className="admin-problems">
            {problems.map((problem) => (
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
    </section>
  );
}

function PluginCard({ plugin }: { readonly plugin: InstalledPlugin }): ReactElement {
  const manifest = plugin.manifest;
  const capabilities = describeCapabilities(manifest.capabilities);
  return (
    <li className="admin-plugin">
      <p className="admin-plugin-head">
        <strong>{manifest.name ?? manifest.id}</strong>
        <code>
          {manifest.id}@{manifest.version}
        </code>
        <span className={`admin-status admin-status-${plugin.state}`}>{plugin.state}</span>
        {plugin.base && <span className="admin-badge">base</span>}
      </p>

      {manifest.description && <p className="admin-plugin-description">{manifest.description}</p>}

      <dl className="admin-plugin-meta">
        <div>
          <dt>Kernel range</dt>
          <dd>
            <code>{manifest.kernel}</code>
          </dd>
        </div>
        <div>
          <dt>Served from</dt>
          <dd>
            <code>{plugin.baseUrl}</code>
          </dd>
        </div>
        {manifest.author && (
          <div>
            <dt>Author</dt>
            <dd>{manifest.author}</dd>
          </div>
        )}
        {manifest.license && (
          <div>
            <dt>License</dt>
            <dd>{manifest.license}</dd>
          </div>
        )}
        <div>
          <dt>Dependencies</dt>
          <dd>{formatRanges(manifest.dependencies)}</dd>
        </div>
        <div>
          <dt>Peer libraries</dt>
          <dd>{formatRanges(manifest.peerLibraries)}</dd>
        </div>
        <div>
          <dt>Halves</dt>
          <dd>
            {[manifest.frontend ? "frontend" : undefined, manifest.backend ? "backend" : undefined]
              .filter(Boolean)
              .join(" + ") || "none"}
          </dd>
        </div>
      </dl>

      {/* A div, not a p: the list below is a real list, and a <ul> inside a <p> is not
          valid HTML — browsers close the paragraph and the styling silently detaches. */}
      <div className="admin-plugin-capabilities">
        <strong>Capabilities:</strong>
        {capabilities.length === 0 ? (
          <span> none declared — no server host functions and no bridge calls</span>
        ) : (
          <ul>
            {capabilities.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** One readable line per declared capability. Counts hide exactly what matters here. */
export function describeCapabilities(capabilities: PluginCapabilities | undefined): readonly string[] {
  if (!capabilities) return [];
  const lines: string[] = [];
  if (capabilities.documents?.length) {
    lines.push(`documents: ${capabilities.documents.join(", ")} — the whole shared workspace`);
  }
  if (capabilities.http?.hosts.length) {
    lines.push(`outbound HTTP to ${capabilities.http.hosts.join(", ")}`);
  }
  if (capabilities.notifications === true) lines.push("notifications");
  const publicRoutes = capabilities["public-routes"];
  if (publicRoutes?.length) {
    lines.push(`unauthenticated routes: ${publicRoutes.join(", ")} — reachable without signing in`);
  }
  return lines;
}

function formatRanges(ranges: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(ranges ?? {});
  if (entries.length === 0) return "none";
  return entries.map(([name, range]) => `${name} ${range}`).join(", ");
}
