import { useEffect, useState, type ReactNode } from "react";

import { asPluginSync, type KernelHost } from "@kernel/runtime/index.js";

import { serverBaseUrl, shellInfo } from "./shell.js";

export const ABOUT_SECTION_ID = "about";

interface SettingsModule {
  readonly addSection?: (section: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
    readonly component: () => ReactNode;
  }) => () => void;
}

const APP_NAMES: Readonly<Record<string, string>> = {
  android: "Android app",
  linux: "Desktop app",
  windows: "Desktop app",
  macos: "Desktop app",
};

export async function contributeAboutSection(host: KernelHost): Promise<void> {
  if (!host.plugins.active("settings")) return;
  const specifier = "plugin:settings";
  const settings = (await import(/* @vite-ignore */ specifier)) as SettingsModule;
  asPluginSync("kernel", () =>
    settings.addSection?.({
      id: ABOUT_SECTION_ID,
      title: "About",
      description: "The versions of ddd you are running.",
      order: 100000,
      component: () => <AboutSection host={host} />,
    }),
  );
}

export async function fetchServerVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetcher(`${serverBaseUrl() ?? ""}/version`, { credentials: "omit" });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { readonly version?: unknown };
  return typeof body.version === "string" && body.version.length > 0 ? body.version : undefined;
}

function AboutSection({ host }: { readonly host: KernelHost }): ReactNode {
  const shell = shellInfo();
  const [server, setServer] = useState<string | "unavailable" | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetchServerVersion().then(
      (version) => {
        if (live) setServer(version ?? "unavailable");
      },
      () => {
        if (live) setServer("unavailable");
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <dl className="ddd-shell-facts ddd-about">
      <Fact label="Server" value={server === undefined ? "checking…" : server === "unavailable" ? "unavailable offline" : server} />
      <Fact label="Web app" value={host.info.bundleVersion} />
      {shell ? (
        <Fact
          label={APP_NAMES[shell.platform ?? ""] ?? "App"}
          value={shell.appVersion ?? "development build"}
        />
      ) : null}
      <Fact label="Plugin API" value={host.info.apiVersion} />
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
