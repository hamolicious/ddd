import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactElement } from "react";

import { useRegistry } from "../../_shared/boundary.js";

import type { AdminClient, PluginAdminView, PluginInstallOutcome, SavedSource, SourceSettings } from "./api.js";
import { ADMIN_CLASSES } from "./AdminView.js";
import { useDialog } from "./hooks.js";
import { CogIcon, PackageIcon, RefreshIcon, UploadIcon } from "./icons.js";
import {
  EMPTY_SETTINGS,
  describeOutcome,
  installFrom,
  providerOf,
  providerRegistry,
  sourceStore,
  useBoundary,
  type AvailablePackage,
  type Boundary,
  type PackageProvider,
  type SetupProps,
} from "./sources.js";
import { installedFrom, updateStore, type ReportedUpdate } from "./updates.js";
import { compareVersions } from "./versions.js";

const PRIMARY = "admin:border-accent! admin:bg-accent! admin:text-accent-text!";

function useSavedSources(): readonly SavedSource[] | undefined {
  return useSyncExternalStore(sourceStore.subscribe, sourceStore.get, sourceStore.get);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useInstaller(onDone: () => void): {
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly outcome: string | undefined;
  readonly run: (label: string, body: () => Promise<PluginInstallOutcome>, describe?: (outcome: PluginInstallOutcome) => string) => void;
} {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const run = useCallback(
    (label: string, body: () => Promise<PluginInstallOutcome>, describe = describeOutcome) => {
      setBusy(label);
      setError(undefined);
      setOutcome(undefined);
      void body()
        .then((result) => {
          setOutcome(describe(result));
          onDone();
        })
        .catch((cause: unknown) => setError(message(cause)))
        .finally(() => setBusy(undefined));
    },
    [onDone],
  );
  return { busy, error, outcome, run };
}

function Messages({ error, outcome }: { readonly error: string | undefined; readonly outcome: string | undefined }): ReactElement {
  return (
    <>
      {error !== undefined && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {outcome !== undefined && (
        <p className="admin-note" role="status">
          {outcome}
        </p>
      )}
    </>
  );
}

export function InstallRow({
  client,
  maxPackageBytes,
  onDone,
}: {
  readonly client: AdminClient;
  readonly maxPackageBytes: number | undefined;
  readonly onDone: () => void;
}): ReactElement {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const installer = useInstaller(onDone);
  const dialog = useDialog();
  const boundary = useBoundary();
  const busy = installer.busy !== undefined;

  const send = (file: File | undefined): void => {
    if (!file || busy) return;
    installer.run(file.name, () => client.uploadPlugin(file));
    if (input.current) input.current.value = "";
  };

  const openSources = (anchor: HTMLElement): void =>
    dialog({
      title: "Package sources",
      anchor,
      render: () => (
        <div className={ADMIN_CLASSES}>
          <SourcesManager client={client} boundary={boundary} />
        </div>
      ),
    });

  const openBrowser = (anchor: HTMLElement): void =>
    dialog({
      title: "Browse packages",
      size: "large",
      anchor,
      render: () => (
        <div className={`${ADMIN_CLASSES} admin:h-full`}>
          <BrowsePackages client={client} onDone={onDone} />
        </div>
      ),
    });

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
            runs until then.{maxPackageBytes !== undefined && <> Up to {formatSize(maxPackageBytes)}.</>}
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
          {busy ? "Installing…" : "Choose a package"}
        </label>
        <button
          type="button"
          className="admin:ml-auto admin:inline-flex admin:items-center admin:gap-1.5"
          onClick={(event) => openBrowser(event.currentTarget)}
        >
          <PackageIcon />
          Browse packages
        </button>
        <button
          type="button"
          className="admin-icon-button"
          aria-label="Package sources"
          title="Package sources"
          onClick={(event) => openSources(event.currentTarget)}
        >
          <CogIcon />
        </button>
      </div>
      {busy && (
        <p className="admin-note" role="status">
          Installing {installer.busy}…
        </p>
      )}
      <Messages error={installer.error} outcome={installer.outcome} />
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

type Screen =
  | { readonly kind: "list" }
  | { readonly kind: "setup"; readonly provider: PackageProvider; readonly source?: SavedSource };

export function SourcesManager({
  client,
  boundary,
}: {
  readonly client: AdminClient;
  readonly boundary: Boundary | undefined;
}): ReactElement {
  const sources = useSavedSources();
  const providers = useRegistry(providerRegistry);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });

  if (screen.kind === "setup") {
    return (
      <SourceSetup
        client={client}
        boundary={boundary}
        provider={screen.provider}
        source={screen.source}
        pluginId={providers.find((entry) => entry.value.id === screen.provider.id)?.pluginId ?? "admin"}
        onDone={() => setScreen({ kind: "list" })}
      />
    );
  }

  return (
    <div className="admin:flex admin:flex-col admin:gap-3">
      <section className="admin:flex admin:flex-col admin:gap-2" aria-labelledby="admin-saved-sources">
        <h4 id="admin-saved-sources">Your sources</h4>
        {sources === undefined ? (
          <p role="status">Loading sources…</p>
        ) : sources.length === 0 ? (
          <p className="admin-empty">No sources yet. Add one below to browse its packages.</p>
        ) : (
          <ul className="admin-plugins" aria-label="Your sources">
            {sources.map((source) => {
              const provider = providerOf(source);
              return (
                <li key={source.id} className="admin-plugin admin:flex admin:flex-wrap admin:items-center admin:gap-2">
                  <span className="admin:flex-1">
                    <strong>{source.name}</strong>{" "}
                    <span className="admin-hint">{provider?.title ?? `${source.provider} (provider not installed)`}</span>
                  </span>
                  <button
                    type="button"
                    disabled={!provider}
                    aria-label={`Edit ${source.name}`}
                    onClick={() => provider && setScreen({ kind: "setup", provider, source })}
                  >
                    Edit
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="admin:flex admin:flex-col admin:gap-2" aria-labelledby="admin-add-source">
        <h4 id="admin-add-source">Add a source</h4>
        {providers.length === 0 ? (
          <p className="admin-empty">No installed plugin provides a package source.</p>
        ) : (
          <ul className="admin-plugins" aria-label="Source types">
            {providers.map(({ value: provider }) => (
              <li key={provider.id} className="admin-plugin admin:flex admin:flex-wrap admin:items-center admin:gap-2">
                <span className="admin:flex-1">
                  <strong>{provider.title}</strong>
                  {provider.description !== undefined && <span className="admin-hint">{provider.description}</span>}
                </span>
                <button
                  type="button"
                  aria-label={`Add a ${provider.title} source`}
                  onClick={() => setScreen({ kind: "setup", provider })}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SourceSetup({
  client,
  boundary,
  provider,
  source,
  pluginId,
  onDone,
}: {
  readonly client: AdminClient;
  readonly boundary: Boundary | undefined;
  readonly provider: PackageProvider;
  readonly source: SavedSource | undefined;
  readonly pluginId: string;
  readonly onDone: () => void;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState(source?.name ?? provider.title);
  const [settings, setSettings] = useState<SourceSettings>(
    () => (source ? { config: source.config, secrets: source.secrets } : (provider.defaults?.() ?? EMPTY_SETTINGS)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const Setup = useMemo<ComponentType<SetupProps>>(
    () => (boundary ? boundary.boundary(provider.setup, { point: "admin.package-provider", pluginId }) : provider.setup),
    [boundary, provider.setup, pluginId],
  );

  const act = async (body: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await body();
      await sourceStore.load(client);
      onDone();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    const trimmed = name.trim();
    const problem = !trimmed ? "Give the source a name." : provider.validate?.(settings);
    if (problem) {
      setError(problem);
      return;
    }
    const draft = { name: trimmed, ...settings };
    void act(() => (source ? client.updatePackageSource(source.id, draft) : client.createPackageSource(provider.id, draft)));
  };

  return (
    <form
      className="admin-form"
      aria-label={source ? `Edit ${source.name}` : `New ${provider.title} source`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="admin-note">{source ? `Editing a ${provider.title} source.` : `A new ${provider.title} source.`}</p>
      <label className="admin-field" htmlFor={`${id}-name`}>
        Name
        <input
          id={`${id}-name`}
          value={name}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <Setup value={settings} onChange={setSettings} disabled={busy} />
      {error !== undefined && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="admin-actions">
        <button type="submit" className={PRIMARY} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onDone}>
          Back
        </button>
        {source !== undefined &&
          (confirming ? (
            <>
              <button
                type="button"
                className="admin-danger"
                disabled={busy}
                onClick={() => void act(() => client.deletePackageSource(source.id))}
              >
                Delete {source.name}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="admin-danger" disabled={busy} onClick={() => setConfirming(true)}>
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}

interface Listing {
  readonly loading: boolean;
  readonly packages: readonly AvailablePackage[];
  readonly error?: string;
}

interface Row {
  readonly source: SavedSource;
  readonly found: AvailablePackage;
  readonly installed: PluginAdminView | undefined;
}

export function BrowsePackages({
  client,
  onDone,
}: {
  readonly client: AdminClient;
  readonly onDone: () => void;
}): ReactElement {
  const id = useId();
  const sources = useSavedSources();
  const providers = useRegistry(providerRegistry);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [plugins, setPlugins] = useState<readonly PluginAdminView[]>([]);
  const loadPlugins = useCallback(() => {
    void client
      .adminPlugins()
      .then((list) => setPlugins(list.plugins))
      .catch(() => undefined);
  }, [client]);
  useEffect(loadPlugins, [loadPlugins]);
  const installer = useInstaller(
    useCallback(() => {
      loadPlugins();
      onDone();
    }, [loadPlugins, onDone]),
  );

  const browse = useCallback((targets: readonly SavedSource[]) => {
    for (const source of targets) {
      const provider = providerOf(source);
      setListings((current) =>
        new Map(current).set(source.id, {
          loading: provider !== undefined,
          packages: [],
          ...(provider ? {} : { error: `no installed plugin provides “${source.provider}” sources` }),
        }),
      );
      if (!provider) continue;
      void provider
        .browse(source)
        .then((packages) => setListings((current) => new Map(current).set(source.id, { loading: false, packages })))
        .catch((cause: unknown) =>
          setListings((current) => new Map(current).set(source.id, { loading: false, packages: [], error: message(cause) })),
        );
    }
  }, []);

  const sourceKey = (sources ?? []).map((source) => `${source.id}:${source.updated_at ?? ""}`).join("|");
  const providerKey = providers.map((entry) => entry.value.id).join("|");
  useEffect(() => {
    if (sources) browse(sources);
  }, [sourceKey, providerKey]);

  if (sources === undefined || sources.length === 0) {
    return (
      <p className="admin-empty">
        {sources === undefined ? "Loading sources…" : "Add a package source with the ⚙ button to browse its packages here."}
      </p>
    );
  }

  const shown = sources.filter((source) => filter === "all" || source.id === filter);
  const needle = query.trim().toLowerCase();
  const rows: Row[] = shown
    .flatMap((source) =>
      (listings.get(source.id)?.packages ?? []).map((found) => ({
        source,
        found,
        installed: plugins.find((plugin) => plugin.id === (found.plugin ?? found.name)),
      })),
    )
    .filter(({ found }) => !needle || `${found.name} ${found.description ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => a.found.name.localeCompare(b.found.name));
  const loading = shown.some((source) => listings.get(source.id)?.loading);

  const act = (row: Row): void => {
    const update = row.installed && compareVersions(row.found.version, row.installed.version) > 0 ? row.installed.id : undefined;
    installer.run(
      `${row.found.name} ${row.found.version}`,
      () => installFrom(client, row.source, row.found.url, update),
      update ? (outcome) => describeUpdate(outcome, row.installed?.version ?? "") : describeOutcome,
    );
  };

  return (
    <section className="admin:flex admin:min-h-0 admin:flex-col admin:gap-2" aria-label="Packages">
      <div className="admin:flex admin:flex-wrap admin:items-end admin:gap-2">
        <div className="admin-field">
          <label htmlFor={`${id}-source`}>Source</label>
          <select
            id={`${id}-source`}
            className="admin:tap-h admin:rounded admin:border admin:border-border admin:bg-bg admin:px-2 admin:text-base admin:text-text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All sources</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </div>
        <label className="admin-field admin:flex-1" htmlFor={`${id}-query`}>
          Filter
          <input
            id={`${id}-query`}
            type="search"
            value={query}
            placeholder="Package name"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" disabled={loading} onClick={() => browse(shown)}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {shown.map((source) => {
        const failure = listings.get(source.id)?.error;
        return failure === undefined ? null : (
          <p key={source.id} className="admin-warning" role="status">
            {source.name}: {failure}
          </p>
        );
      })}
      {rows.length === 0 ? (
        !loading && <p className="admin-empty">No packages found.</p>
      ) : (
        <ul className="admin-plugins" aria-label="Available packages">
          {rows.map((row) => {
            const newer = row.installed ? compareVersions(row.found.version, row.installed.version) > 0 : true;
            const label = !row.installed ? "Install" : newer ? "Update" : undefined;
            return (
              <li
                key={`${row.source.id}:${row.found.name}:${row.found.version}`}
                className="admin-plugin admin:flex admin:flex-wrap admin:items-center admin:gap-2"
              >
                <span className="admin:min-w-0 admin:flex-1">
                  <strong>{row.found.name}</strong> {row.found.version}
                  <span className="admin-hint">
                    {row.source.name}
                    {row.installed ? ` · installed ${row.installed.version}` : ""}
                    {row.found.description ? ` · ${row.found.description}` : ""}
                  </span>
                </span>
                {label === undefined ? (
                  <span className="admin-status admin-status-enabled">Installed</span>
                ) : (
                  <button
                    type="button"
                    className={PRIMARY}
                    disabled={installer.busy !== undefined}
                    aria-label={`${label} ${row.found.name} ${row.found.version}`}
                    onClick={() => act(row)}
                  >
                    {installer.busy === `${row.found.name} ${row.found.version}` ? "Installing…" : label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Messages error={installer.error} outcome={installer.outcome} />
    </section>
  );
}

function describeUpdate(outcome: PluginInstallOutcome, previous: string): string {
  return outcome.state === "enabled"
    ? `${outcome.id} updated to ${outcome.version}.`
    : `${outcome.id} ${outcome.version} asks for more than ${previous} was allowed; approve it under Pending installs.`;
}

export function useAvailableUpdates(plugins: readonly PluginAdminView[]): ReadonlyMap<string, ReportedUpdate> {
  const reported = useSyncExternalStore(updateStore.subscribe, updateStore.get, updateStore.get);
  return useMemo(() => {
    const available = new Map<string, ReportedUpdate>();
    for (const update of reported.values()) {
      const plugin = plugins.find((candidate) => candidate.id === update.plugin);
      if (plugin && compareVersions(update.latest, plugin.version) > 0) available.set(update.plugin, update);
    }
    return available;
  }, [reported, plugins]);
}

export function CheckUpdates({
  plugins,
  found,
}: {
  readonly plugins: readonly PluginAdminView[];
  readonly found: number;
}): ReactElement | null {
  const sources = useSavedSources();
  useRegistry(providerRegistry);
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [problems, setProblems] = useState<readonly string[]>([]);

  const checkable = (sources ?? []).filter((source) => providerOf(source)?.checkUpdates !== undefined);
  if (checkable.length === 0) return null;

  const check = async (): Promise<void> => {
    setChecking(true);
    setSummary(undefined);
    setProblems([]);
    const failures: string[] = [];
    let checked = 0;
    await Promise.all(
      checkable.map(async (source) => {
        updateStore.clear(source.id);
        const installed = installedFrom(plugins, source.id);
        if (installed.length === 0) return;
        checked += installed.length;
        try {
          await providerOf(source)?.checkUpdates?.(source, installed);
        } catch (cause) {
          failures.push(`${source.name}: ${message(cause)}`);
        }
      }),
    );
    setProblems(failures);
    setSummary(
      checked === 0
        ? "No installed plugin came from one of your sources."
        : `Checked ${checked} plugin${checked === 1 ? "" : "s"} for updates.`,
    );
    setChecking(false);
  };

  return (
    <>
      <button
        type="button"
        className="admin-icon-button"
        aria-label="Check for updates"
        title="Check for updates"
        disabled={checking}
        onClick={() => void check()}
      >
        <span className={`admin:inline-flex ${checking ? "admin:animate-spin" : ""}`}>
          <RefreshIcon />
        </span>
      </button>
      {(summary !== undefined || problems.length > 0) && (
        <div className="admin:flex admin:basis-full admin:flex-col admin:gap-1">
          {summary !== undefined && (
            <p className="admin-note" role="status">
              {found > 0 ? `${found} update${found === 1 ? "" : "s"} available. ` : "Everything is up to date. "}
              {summary}
            </p>
          )}
          {problems.map((problem) => (
            <p key={problem} className="admin-warning" role="status">
              {problem}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

export function updatePlugin(client: AdminClient, update: ReportedUpdate): Promise<PluginInstallOutcome> {
  const source = sourceStore.get()?.find((candidate) => candidate.id === update.source);
  if (!source) return Promise.reject(new Error("the source that found this update is no longer saved"));
  return installFrom(client, source, update.url, update.plugin).then((outcome) => {
    updateStore.forget(update.plugin);
    return outcome;
  });
}
