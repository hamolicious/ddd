import { useMemo, type ReactNode } from "react";

import type { Kernel, Registry, RegistryEntry } from "@kernel";

import { useRegistry } from "../../_shared/boundary.js";

import { groupByBase, useBasePluginIds } from "./groups.js";
import type { SettingsSection } from "./sections.js";

export interface RouterService {
  readonly navigate: (path: string) => void;
  readonly url: (path: string) => string;
}

export interface SettingsViewProps {
  readonly kernel: Kernel;
  readonly router: RouterService;
  readonly sections: Registry<SettingsSection>;
  readonly params?: Readonly<Record<string, string>>;
}

export function SettingsView({ kernel, router, sections: host, params }: SettingsViewProps): ReactNode {
  const sections = useRegistry(host);

  const groups = groupByBase(sections, useBasePluginIds(kernel));
  const requested = params?.["section"];
  const chosen = sections.find((entry) => entry.value.id === requested);
  const active =
    chosen ??
    groups.base[0] ??
    groups.extensions[0];

  const list = (entries: readonly RegistryEntry<SettingsSection>[], label: string): ReactNode => (
    <ul className="settings:m-0 settings:list-none settings:p-0 settings:compact:grid settings:compact:gap-1" aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.value.id}>
          <a
            href={router.url(`/settings/${encodeURIComponent(entry.value.id)}`)}
            className="settings-nav-link settings:tap-h settings:flex settings:items-center settings:rounded settings:px-2 settings:text-inherit settings:no-underline settings:hover:bg-bg-subtle settings:aria-current:bg-accent-subtle settings:aria-current:font-semibold settings:compact:justify-between settings:compact:border settings:compact:border-border settings:compact:bg-bg-raised settings:compact:after:text-text-muted settings:compact:after:content-['›']"
            {...(entry.value.id === active?.value.id ? { "aria-current": "page" as const } : {})}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              router.navigate(`/settings/${encodeURIComponent(entry.value.id)}`);
            }}
          >
            {entry.value.title}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="settings:mx-auto settings:max-w-[62rem] settings:p-4 settings:font-sans settings:text-text settings:compact:px-[calc(var(--ddd-space)+var(--ddd-safe-right))] settings:compact:pb-[calc(var(--ddd-space)+var(--ddd-safe-bottom))] settings:compact:pl-[calc(var(--ddd-space)+var(--ddd-safe-left))] settings:compact:pt-2" data-view={chosen ? "section" : "index"}>
      <header className="settings:[&_h1]:mb-2 settings:[&_h1]:mt-0 settings:[&_h1]:text-2xl settings:compact:[&_h1]:text-xl">
        <h1>Settings</h1>
        <p className="settings:mb-4 settings:mt-0 settings:rounded settings:border-l-[3px] settings:border-warning settings:bg-bg-subtle settings:p-2 settings:text-text-muted settings:compact:mb-2 settings:compact:text-sm">
          Other people in this workspace can read your settings. Put secrets in admin
          plugin configuration, which is encrypted.
        </p>
      </header>

      {sections.length === 0 ? (
        <p className="settings:text-text-muted">No plugin has contributed any settings.</p>
      ) : (
        <div className="settings:grid settings:grid-cols-[minmax(10rem,14rem)_1fr] settings:items-start settings:gap-4 settings:compact:grid-cols-1 settings:compact:gap-2">
          <nav className={`settings:min-w-0 ${chosen ? " settings:compact:hidden" : ""}`} aria-label="Settings sections">
            {list(groups.base, "Built-in")}
            {groups.extensions.length > 0 ? (
              <>
                <hr className="settings-divider settings:my-2 settings:border-0 settings:border-t settings:border-border" />
                {list(groups.extensions, "Extensions")}
              </>
            ) : null}
          </nav>

          <div className={`settings-pane settings:min-w-0 settings:compact:overflow-x-auto ${chosen ? "" : " settings:compact:hidden"}`}>
            <a
              className="settings:mb-1 settings:hidden settings:min-h-[var(--ddd-tap-target)] settings:items-center settings:text-link settings:before:mr-1 settings:before:content-['‹'] settings:compact:inline-flex"
              href={router.url("/settings")}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                router.navigate("/settings");
              }}
            >
              All settings
            </a>
            {active ? <Section kernel={kernel} entry={active} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  kernel,
  entry,
}: {
  readonly kernel: Kernel;
  readonly entry: RegistryEntry<SettingsSection>;
}): ReactNode {
  const section = entry.value;
  const Rendered = useMemo(
    () =>
      kernel.ui.boundary(section.component, {
        point: "settings.section",
        pluginId: entry.pluginId,
      }),
    [kernel, section.component, entry.pluginId],
  );

  return (
    <section className="settings:compact:rounded-lg settings:compact:border settings:compact:border-border settings:compact:bg-bg-raised settings:compact:p-2 settings:[&>h2]:mb-3 settings:[&>h2]:mt-0 settings:[&>h2]:text-lg" aria-labelledby={`settings-${section.id}`}>
      <h2 id={`settings-${section.id}`}>{section.title}</h2>
      {section.description ? (
        <p className="settings:mb-3 settings:mt-1 settings:text-text-muted">{section.description}</p>
      ) : null}
      <Rendered />
    </section>
  );
}
