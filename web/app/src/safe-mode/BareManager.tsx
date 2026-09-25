/**
 * `?safe=bare` — the **minimal built-in plugin manager** of SPEC §6.1.
 *
 * The last line of the recovery story: no plugins are loaded, so nothing a plugin
 * did can affect this screen. It lists what is installed, shows why each entry would
 * or would not load in a normal boot (the same `resolveOrder` the loader uses, run
 * without activating anything), and offers the two exits.
 *
 * It does **not** enable or disable plugins: that is a server-side, admin-approved
 * action (SPEC §6.2) and M4 owns the endpoint. Until then this screen is honest
 * about being read-only, and points at `DISABLE_PLUGINS=1` for the case where a
 * plugin is so broken that no client can get far enough to click anything.
 */

import { useEffect, useState, type ReactNode } from "react";

import { KERNEL_API_VERSION, type InstalledPlugin } from "@kernel";

import { installedPlugins } from "../boot/api.js";
import { safeModeUrl } from "../boot/safe-mode.js";
import { resolveOrder, type SkippedPlugin } from "../loader/order.js";

export function BareManager({ token }: { readonly token?: string }): ReactNode {
  const [plugins, setPlugins] = useState<readonly InstalledPlugin[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    installedPlugins(token)
      .then((response) => setPlugins(response.plugins))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [token]);

  const resolved = plugins ? resolveOrder(plugins, { kernelVersion: KERNEL_API_VERSION }) : undefined;
  const skipReason = new Map<string, SkippedPlugin>(
    (resolved?.skipped ?? []).map((entry) => [entry.pluginId, entry]),
  );

  return (
    <div className="lm-bare">
      <header>
        <h1>Plugin manager (safe mode)</h1>
        <p>No plugins are loaded.</p>
        <p>
          <a href={safeModeUrl("off")}>Normal boot</a> ·{" "}
          <a href={safeModeUrl("base")}>Base plugins only</a>
        </p>
      </header>

      {error ? <p role="alert">Could not read the plugin list: {error}</p> : null}
      {!plugins && !error ? <p>Loading the installed plugin list…</p> : null}

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
                  const skipped = skipReason.get(plugin.manifest.id);
                  return (
                    <tr key={plugin.manifest.id}>
                      <th scope="row">{plugin.manifest.id}</th>
                      <td data-label="Version">{plugin.manifest.version}</td>
                      <td data-label="Kernel">
                        <code>{plugin.manifest.kernel}</code>
                      </td>
                      <td data-label="Base">{plugin.base ? "yes" : "no"}</td>
                      <td data-label="Would load">
                        {skipped ? `no — ${skipped.detail}` : "yes"}
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
