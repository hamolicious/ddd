/**
 * A settings section (`settings.addSection`) that exists **only inside the Flutter shell** (SPEC §7): what
 * bridge this device speaks, what it can do natively, and which bundle is running.
 *
 * Three reasons it is worth the file rather than being a console log:
 *
 * 1. **"OTA update + revert" is an M5 acceptance criterion** (SPEC §9 M5) and neither the
 *    tester nor a user can confirm it without a visible version. `adb logcat` is not an
 *    answer for someone holding a phone.
 * 2. **Capability degradation is invisible by design.** A plugin's reminder silently
 *    becomes foreground-only when the bridge lacks `schedule`; this is the one screen that
 *    says which mode this device is in, and it reads the *methods*, never the advertised
 *    `capabilities` array (`app/BRIDGE.md` §3: presence of the method is the only gate).
 * 3. **A bundle/shell mismatch is a support question.** Naming both versions turns
 *    "the app is broken" into "this bundle wants bridge 2 and the shell speaks 1".
 *
 * It is contributed by the kernel rather than by a plugin, because it describes the
 * *device*, and a device that cannot load `settings` has bigger problems than this panel.
 * A plain browser never sees it: nothing is contributed at all there (SPEC §7's
 * "degrades gracefully" applied to a UI — the absent thing is the whole section).
 */

import { useEffect, useState, type ReactNode } from "react";

import { asPluginSync, type KernelHost } from "@kernel/runtime/index.js";

import { inShell, readShellManifest, shellInfo, type ShellManifestInfo } from "./shell.js";

export const SHELL_SECTION_ID = "shell";

/** The part of `plugin:settings` this file uses; typed here so the app does not compile a plugin. */
interface SettingsModule {
  readonly addSection?: (section: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
    readonly component: () => ReactNode;
  }) => () => void;
}

/**
 * Add the section to the `settings` plugin, in the shell only, once the plugins have
 * activated. Attributed to `kernel`, so the settings screen's "provided by" line tells the
 * truth. Without an active `settings` plugin there is nowhere to put it, and nothing happens.
 *
 * The module is imported by its specifier through a variable, like the loader does: the
 * app never bundles or type-checks against a plugin, and the import map hands back the
 * very instance the settings plugin activated with.
 */
export async function contributeShellSection(host: KernelHost): Promise<void> {
  if (!inShell() || !host.plugins.active("settings")) return;
  const specifier = "plugin:settings";
  const settings = (await import(/* @vite-ignore */ specifier)) as SettingsModule;
  asPluginSync("kernel", () =>
    settings.addSection?.({
      id: SHELL_SECTION_ID,
      title: "This device",
      description: "Bridge version, native capabilities and the bundle running on this device.",
      order: 90,
      component: () => <ShellSection host={host} />,
    }),
  );
}

function ShellSection({ host }: { readonly host: KernelHost }): ReactNode {
  const info = shellInfo();
  const [served, setServed] = useState<ShellManifestInfo | "offline" | undefined>(undefined);

  useEffect(() => {
    let live = true;
    // The *server's* newest bundle, which is a different question from the one this
    // device is running — see `ShellInfo.bundleVersion`. Failing is normal (offline, or
    // a non-admin server error) and must read as "unknown", never as an error dialog.
    host.session
      .fetch("/shell/manifest")
      .then((response) => response.json() as Promise<unknown>)
      .then((manifest) => {
        if (live) setServed(readShellManifest(manifest));
      })
      .catch(() => {
        if (live) setServed("offline");
      });
    return () => {
      live = false;
    };
  }, [host]);

  if (!info) return <p>This workspace is running in a browser, not in the app shell.</p>;

  const manifest = typeof served === "object" ? served : undefined;
  // The support answer to "the app is broken": a bundle the server publishes may need a
  // newer shell than this device has (`app/BRIDGE.md` §8). The updater refuses that
  // update rather than installing it, which from the outside looks like "updates stopped
  // arriving" — so say it here in words instead.
  const needsNewerShell =
    manifest?.minBridgeVersion !== undefined &&
    info.bridgeVersion !== undefined &&
    manifest.minBridgeVersion > info.bridgeVersion;

  return (
    <dl className="lm-shell-facts">
      <Fact label="Platform" value={info.platform ?? "unknown"} />
      <Fact label="Bridge version" value={info.bridgeVersion === undefined ? "not reported" : String(info.bridgeVersion)} />
      <Fact label="Server" value={info.serverBaseUrl ?? "this page's origin"} />
      <Fact label="Bundle on this device" value={info.bundleVersion ?? "not reported by the shell"} />
      <Fact
        label="Newest bundle on the server"
        value={
          served === undefined
            ? "checking…"
            : served === "offline"
              ? "unavailable offline"
              : (manifest?.bundleVersion ?? "not published")
        }
      />
      {/*
        The one question a person actually has, and it needs **both** numbers: the
        server's manifest names the newest bundle, `window.shell.bundleVersion` names
        the one this device booted. With either missing the honest answer is silence
        rather than a guess, which is why this row appears only when both are there.
      */}
      {info.bundleVersion !== undefined && manifest?.bundleVersion !== undefined ? (
        <Fact
          label="Up to date"
          value={
            manifest.bundleVersion === info.bundleVersion
              ? "Yes"
              : "No. A newer bundle installs at the next launch."
          }
        />
      ) : null}
      {needsNewerShell ? (
        <Fact
          label="Update blocked"
          value={`The newest bundle needs bridge ${String(manifest?.minBridgeVersion)}; this app speaks ${String(info.bridgeVersion)}. Update the app itself to receive it.`}
        />
      ) : null}
      <Fact
        label="Native capabilities"
        value={info.methods.length > 0 ? info.methods.join(", ") : "none registered"}
      />
      <Fact
        label="Reminders"
        value={
          host.capabilities.notifications.supportsScheduled
            ? "Scheduled. They fire with the app closed."
            : "Foreground only. This device cannot schedule reminders."
        }
      />
      <Fact
        label="Workspace export"
        value={
          host.capabilities.filesystem.exportWorkspace
            ? "available"
            : "unavailable on this device"
        }
      />
    </dl>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
