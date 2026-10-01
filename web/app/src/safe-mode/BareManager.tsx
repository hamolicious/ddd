/**
 * `?safe=bare` — the **minimal built-in plugin manager** of SPEC §6.1.
 *
 * The last line of the recovery story: no plugins are loaded, so nothing a plugin
 * did can affect this screen. It lists what is installed, shows why each entry would
 * or would not load in a normal boot, and offers the two exits.
 *
 * **What decides "would load" is the server's load resolution** (`@kernel` 3.0): the
 * enabled plugins in dependency order, and what was left out and why, as `GET
 * /api/plugins` ships it (`load`), with this client's own manifest and kernel-range check
 * on top (`clientCheck`). A list without one (a server older than 3.0) cannot say, and
 * the column says that rather than guessing.
 *
 * **The write path is admin-only, and it is the way back**: a disabled plugin gets an
 * *Enable* button, through the same server route the `admin` plugin's Plugins page uses,
 * so the server's admin check is the control here too; a non-admin sees the read-only
 * list and is told who can act. Enabling a plugin reloads every open client
 * (`plugins.changed`), this one included — which lands back here, in `?safe=bare`.
 *
 * This screen needs the kernel, React and the session, and nothing else — no plugin
 * code, no plugin UI. Confirmation is `window.confirm`.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { KERNEL_API_VERSION, type InstalledPlugin, type SessionUser } from "@kernel";

import { enablePlugin, installedPlugins, type PluginList } from "../boot/api.js";
import { safeModeUrl } from "../boot/safe-mode.js";
import { clientCheck } from "../loader/loader.js";

export interface BareManagerProps {
  /** The bearer token, for shells; a browser's session is its cookie. */
  readonly token?: string;
  /** The signed-in user. Only an admin gets the write path. */
  readonly user?: SessionUser;
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function BareManager({ token, user }: BareManagerProps): ReactNode {
  const admin = user?.isAdmin === true;
  const [list, setList] = useState<PluginList | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** The id an action is running for; one at a time on a recovery screen. */
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    installedPlugins(token)
      .then((response) => {
        if (!live) return;
        setList(response);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [token, generation]);

  const plugins = list?.plugins;
  const load = list?.load;
  const loading = new Set(load?.normal ?? []);
  const serverSkipped = new Map((load?.skipped ?? []).map((entry) => [entry.id, entry.reason]));

  /** Why a plugin would not load in a normal boot, or `undefined` when it would. */
  const wouldNotLoad = (plugin: InstalledPlugin): string | undefined => {
    const id = plugin.manifest.id;
    if (plugin.state !== "enabled") return `it is ${plugin.state}`;
    const server = serverSkipped.get(id);
    if (server) return server;
    const refused = clientCheck(plugin, KERNEL_API_VERSION);
    if (refused) return refused.detail;
    if (!loading.has(id)) return "the server's load order leaves it out";
    return undefined;
  };

  const run = (key: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return;
    setBusy(key);
    setNotice(undefined);
    action()
      .then(() => reload())
      .catch((cause: unknown) => setNotice(describe(cause)))
      .finally(() => setBusy(undefined));
  };

  const enable = (plugin: InstalledPlugin): void =>
    run(`enable:${plugin.manifest.id}`, () => enablePlugin(plugin.manifest.id, token));

  const enableable = (plugin: InstalledPlugin): boolean => plugin.state === "disabled";

  return (
    <div className="ddd-bare">
      <header>
        <h1>Plugin manager (safe mode)</h1>
        <p>No plugins are loaded.</p>
        {!admin && <p>An administrator can enable plugins again here.</p>}
        <p>
          <a href={safeModeUrl("off")}>Normal boot</a> ·{" "}
          <a href={safeModeUrl("base")}>Base plugins only</a>
        </p>
      </header>

      {error ? <p role="alert">Could not read the plugin list: {error}</p> : null}
      {!plugins && !error ? <p>Loading the installed plugin list…</p> : null}
      {notice ? <p role="alert">{notice}</p> : null}

      {plugins ? (
        // `data-label` on every cell, because at the compact breakpoint the kernel
        // stylesheet drops the header row and stacks each plugin into a card.
        <div className="ddd-bare-scroll">
          <table className="ddd-bare-table">
            <thead>
              <tr>
                <th scope="col">Plugin</th>
                <th scope="col">Version</th>
                <th scope="col">Kernel</th>
                <th scope="col">Base</th>
                <th scope="col">Would load</th>
              </tr>
            </thead>
            <tbody>
              {[...plugins]
                .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
                .map((plugin) => {
                  const id = plugin.manifest.id;
                  const why = load === undefined ? undefined : wouldNotLoad(plugin);
                  return (
                    <tr key={id}>
                      <th scope="row">{id}</th>
                      <td data-label="Version">{plugin.manifest.version}</td>
                      <td data-label="Kernel">
                        <code>{plugin.manifest.kernel}</code>
                      </td>
                      <td data-label="Base">{plugin.base ? "yes" : "no"}</td>
                      <td data-label="Would load">
                        {load === undefined ? "unknown: the server sent no load order" : why ? `no — ${why}` : "yes"}
                        {admin && enableable(plugin) ? (
                          <button
                            type="button"
                            aria-label={`Enable ${id}`}
                            disabled={busy !== undefined}
                            onClick={() => enable(plugin)}
                          >
                            {busy === `enable:${id}` ? "Enabling…" : "Enable"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}

      <footer>
        <p>
          An administrator enables and disables plugins on the server. To stop the server
          serving plugins to every client at once, set <code>DISABLE_PLUGINS=1</code> and
          restart it.
        </p>
        <p>
          Kernel contract <code>{KERNEL_API_VERSION}</code>.
        </p>
      </footer>
    </div>
  );
}
