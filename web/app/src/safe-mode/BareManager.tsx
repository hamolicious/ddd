/**
 * `?safe=bare` — the **minimal built-in plugin manager** of SPEC §6.1.
 *
 * The last line of the recovery story: no plugins are loaded, so nothing a plugin
 * did can affect this screen. It lists what is installed, shows why each entry would
 * or would not load in a normal boot, and offers the two exits.
 *
 * **What decides "would load" is the server's resolution** (PLUGIN-PROTOCOLS §6): the
 * live wiring resolved against this list, as `GET /api/plugins` ships it, with this
 * client's own kernel-range check on top (`orderFromResolution`). A list without one — an
 * older server, or a cached list — falls back to the loader's legacy `resolveOrder` over
 * `dependencies`, so the column is never blank.
 *
 * **The write path is admin-only, and it is the way back** (PLUGIN-PROTOCOLS §7, §10): a
 * plugin that is disabled or unplugged gets a *Plug in* button, and the wiring history
 * offers *Roll back* to any earlier version. Both go through the same server routes the
 * `admin` and `wiring` plugins use, so the server's admin check is the control here too;
 * a non-admin sees the read-only list and is told who can act. Nothing is pinned: a
 * rollback is an ordinary apply with an older version's overrides, and the server refuses
 * it (409) when live has moved on in between.
 *
 * This screen needs the kernel, React and the session, and nothing else — no plugin
 * code, no plugin UI. Confirmation is `window.confirm`.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { KERNEL_API_VERSION, type InstalledPlugin, type LiveWiring, type SessionUser } from "@kernel";

import {
  ApiError,
  applyWiring,
  enablePlugin,
  installedPlugins,
  wiringHistory,
  wiringVersion,
  type PluginList,
  type WiringVersionInfo,
} from "../boot/api.js";
import { safeModeUrl } from "../boot/safe-mode.js";
import { orderFromResolution, resolveOrder, type SkippedPlugin } from "../loader/order.js";

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
  const [history, setHistory] = useState<readonly WiringVersionInfo[] | undefined>();
  const [wiringLive, setWiringLive] = useState<LiveWiring | undefined>();
  const [wiringError, setWiringError] = useState<string | undefined>();
  /** The id or version an action is running for; one at a time on a recovery screen. */
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

  useEffect(() => {
    // The history route is admin-only; asking as anyone else would only show a 403.
    if (!admin) return;
    let live = true;
    wiringHistory(token)
      .then((response) => {
        if (!live) return;
        setHistory(response.history);
        setWiringLive(response.live);
        setWiringError(undefined);
      })
      .catch((cause: unknown) => {
        if (live) setWiringError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, [admin, token, generation]);

  const plugins = list?.plugins;
  const liveWiring = wiringLive ?? list?.wiring;
  const unplugged = new Set(liveWiring?.unplugged ?? []);

  // Step 8: the server's resolution when the list carries one; the legacy resolver
  // over `dependencies` only for a list without it.
  const resolved = plugins
    ? list?.resolved
      ? orderFromResolution(plugins, list.resolved.normal, { kernelVersion: KERNEL_API_VERSION })
      : resolveOrder(plugins, { kernelVersion: KERNEL_API_VERSION })
    : undefined;
  const skipReason = new Map<string, SkippedPlugin>(
    (resolved?.skipped ?? []).map((entry) => [entry.pluginId, entry]),
  );

  const run = (key: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return;
    setBusy(key);
    setNotice(undefined);
    action()
      .then(() => reload())
      .catch((cause: unknown) => setNotice(describe(cause)))
      .finally(() => setBusy(undefined));
  };

  const plugIn = (plugin: InstalledPlugin): void =>
    run(`plug:${plugin.manifest.id}`, () => enablePlugin(plugin.manifest.id, token));

  const rollBack = (entry: WiringVersionInfo): void => {
    if (liveWiring === undefined) return;
    const base = liveWiring.version;
    const ok = window.confirm(
      `Roll back to wiring version ${entry.version}?\n\nVersion ${base} is live. Version ${entry.version} is applied again as version ${base + 1}; nothing is deleted.`,
    );
    if (!ok) return;
    run(`rollback:${entry.version}`, async () => {
      const record = await wiringVersion(entry.version, token);
      try {
        await applyWiring({ base, wiring: record.wiring, action: "rollback" }, token);
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
        // Someone applied a version in between: the reload shows it; say why nothing moved.
        const latest = await wiringHistory(token);
        throw new Error(
          `The live wiring moved on to version ${latest.live.version} in the meantime; nothing was changed. Choose again from the current list.`,
        );
      }
    });
  };

  const pluggable = (plugin: InstalledPlugin): boolean =>
    plugin.state === "disabled" || unplugged.has(plugin.manifest.id);

  return (
    <div className="lm-bare">
      <header>
        <h1>Plugin manager (safe mode)</h1>
        <p>No plugins are loaded.</p>
        {!admin && <p>An administrator can plug plugins back in and roll the wiring back here.</p>}
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
        <div className="lm-bare-scroll">
          <table className="lm-bare-table">
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
                  const skipped = skipReason.get(id);
                  return (
                    <tr key={id}>
                      <th scope="row">{id}</th>
                      <td data-label="Version">{plugin.manifest.version}</td>
                      <td data-label="Kernel">
                        <code>{plugin.manifest.kernel}</code>
                      </td>
                      <td data-label="Base">{plugin.base ? "yes" : "no"}</td>
                      <td data-label="Would load">
                        {skipped ? `no — ${skipped.detail}` : "yes"}
                        {admin && pluggable(plugin) ? (
                          <button
                            type="button"
                            aria-label={`Plug in ${id}`}
                            disabled={busy !== undefined}
                            onClick={() => plugIn(plugin)}
                          >
                            {busy === `plug:${id}` ? "Plugging in…" : "Plug in"}
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

      {admin ? (
        <section className="lm-bare-wiring" aria-labelledby="lm-bare-wiring-heading">
          <h2 id="lm-bare-wiring-heading">Wiring</h2>
          {wiringError ? <p role="alert">Could not read the wiring history: {wiringError}</p> : null}
          {!history && !wiringError ? <p>Loading the wiring history…</p> : null}
          {history && liveWiring ? (
            <>
              <p>
                Live version <strong>{liveWiring.version}</strong>
                {liveWiring.unplugged.length > 0 ? <> · {liveWiring.unplugged.length} unplugged</> : null}
              </p>
              {history.length === 0 ? (
                <p>No versions recorded yet.</p>
              ) : (
                <div className="lm-bare-scroll">
                  <table className="lm-bare-table">
                    <thead>
                      <tr>
                        <th scope="col">Version</th>
                        <th scope="col">Action</th>
                        <th scope="col">By</th>
                        <th scope="col">When</th>
                        <th scope="col">
                          <span className="lm-sr-only">Roll back</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((entry) => (
                        <tr key={entry.version} data-wiring-version={entry.version}>
                          <th scope="row">
                            {entry.version}
                            {entry.version === liveWiring.version ? " (live)" : ""}
                          </th>
                          <td data-label="Action">
                            <code>{entry.action}</code>
                            {entry.subject !== undefined ? ` ${entry.subject}` : ""}
                          </td>
                          <td data-label="By">{entry.actor ?? "—"}</td>
                          <td data-label="When">{formatWhen(entry.at)}</td>
                          <td className="lm-bare-actions">
                            {entry.version !== liveWiring.version ? (
                              <button
                                type="button"
                                aria-label={`Roll back to version ${entry.version}`}
                                disabled={busy !== undefined}
                                onClick={() => rollBack(entry)}
                              >
                                {busy === `rollback:${entry.version}` ? "Rolling back…" : "Roll back"}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </section>
      ) : null}

      <footer>
        <p>
          An administrator enables and disables plugins on the server. To stop the server
          serving plugins to every client at once, set <code>DISABLE_PLUGINS=1</code> and
          restart it.
        </p>
        <p>
          Kernel contract <code>{KERNEL_API_VERSION}</code>
          {liveWiring ? (
            <>
              {" "}
              · wiring version <code>{liveWiring.version}</code>
            </>
          ) : null}
          .
        </p>
      </footer>
    </div>
  );
}

/** A timestamp for display; the raw string when it does not parse. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
