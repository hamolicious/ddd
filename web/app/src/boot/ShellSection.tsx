import { useEffect, useState, type ReactNode } from "react";

import { asPluginSync, type KernelHost } from "@kernel/runtime/index.js";

import { inShell, readShellManifest, shellInfo, type ShellManifestInfo } from "./shell.js";

export const SHELL_SECTION_ID = "shell";

interface SettingsModule {
  readonly addSection?: (section: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
    readonly component: () => ReactNode;
  }) => () => void;
}

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
  const needsNewerShell =
    manifest?.minBridgeVersion !== undefined &&
    info.bridgeVersion !== undefined &&
    manifest.minBridgeVersion > info.bridgeVersion;

  return (
    <dl className="ddd-shell-facts">
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
