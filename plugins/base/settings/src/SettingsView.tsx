/**
 * The settings screen: a list of contributed sections and the one that is open.
 *
 * Three things it does deliberately.
 *
 * **It owns no settings.** Every section is a `settings.section` contribution rendered
 * through `kernel.ui.boundary` (SPEC §6.4), so a plugin whose settings UI throws loses
 * its own panel and nothing else.
 *
 * **The section is in the URL.** `/settings/:section` means a link to a specific
 * screen exists — which is what lets `themes` say "open the appearance settings" and
 * what makes the browser's back button work inside settings.
 *
 * **It says where settings live.** They are per-user documents in a shared workspace
 * (SPEC §6.4), so another user can read them. That sentence belongs on the screen
 * where somebody is about to type something into a settings field, not only in the
 * contract.
 *
 * **On a phone it is a list, then a section.** The eleven section names laid out in a
 * row were a 1 860 px horizontal strip inside a 374 px scroller with no scrollbar: two
 * and a half sections visible and no affordance saying the rest existed. Below the
 * compact breakpoint the list stacks and the two halves take turns — `data-view` on the
 * root is what the stylesheet reads to decide which — so a section gets the whole
 * screen and "All settings" goes back. The URL is unchanged either way, and on a wide
 * screen both halves are still side by side.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Contribution, Kernel } from "@kernel";

import { POINTS, type SettingsSection } from "../../_shared/points.js";

/**
 * The part of `router`'s API this plugin uses. Declared structurally rather than
 * imported: plugins interact through the registry only (SPEC §6.1), and importing
 * another plugin's source would bundle a second copy of it.
 */
export interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  url(path: string): string;
}

export interface SettingsViewProps {
  readonly kernel: Kernel;
  readonly router: RouterService;
  readonly params?: Readonly<Record<string, string>>;
}

export function SettingsView({ kernel, router, params }: SettingsViewProps): ReactNode {
  const [sections, setSections] = useState<readonly Contribution<SettingsSection>[]>(() =>
    kernel.extensions.entries<SettingsSection>(POINTS.settingsSection),
  );
  useEffect(
    () =>
      kernel.extensions.subscribe(POINTS.settingsSection, () => {
        setSections(kernel.extensions.entries<SettingsSection>(POINTS.settingsSection));
      }),
    [kernel],
  );

  const requested = params?.["section"];
  const chosen = sections.find((entry) => entry.value.id === requested);
  const active =
    chosen ??
    // An unknown section id falls back to the first rather than to an empty pane: the
    // id may belong to a plugin that has not activated, or has been uninstalled.
    sections[0];

  return (
    // `section` only when the URL actually named one that exists — `/settings` on its
    // own is the index, and on a wide screen both views render whichever this says.
    <div className="settings:mx-auto settings:max-w-[62rem] settings:p-4 settings:font-sans settings:text-text settings:compact:px-[calc(var(--lm-space)+var(--lm-safe-right))] settings:compact:pb-[calc(var(--lm-space)+var(--lm-safe-bottom))] settings:compact:pl-[calc(var(--lm-space)+var(--lm-safe-left))] settings:compact:pt-2" data-view={chosen ? "section" : "index"}>
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
            <ul className="settings:m-0 settings:list-none settings:p-0 settings:compact:grid settings:compact:gap-1">
              {sections.map((entry) => (
                <li key={entry.value.id}>
                  <a
                    href={router.url(`/settings/${encodeURIComponent(entry.value.id)}`)}
                    className="settings-nav-link settings:tap-h settings:flex settings:items-center settings:rounded settings:px-2 settings:text-inherit settings:no-underline settings:hover:bg-bg-subtle settings:aria-current:bg-accent-subtle settings:aria-current:font-semibold settings:compact:justify-between settings:compact:border settings:compact:border-border settings:compact:bg-bg-raised settings:compact:after:text-text-muted settings:compact:after:content-['›']"
                    {...(entry.value.id === active?.value.id
                      ? { "aria-current": "page" as const }
                      : {})}
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
          </nav>

          <div className={`settings-pane settings:min-w-0 settings:compact:overflow-x-auto ${chosen ? "" : " settings:compact:hidden"}`}>
            {/* The way back out of a drilled-in section. A real link, because it is a
                real navigation — and hidden by the stylesheet on a screen wide enough
                to show the list beside the section anyway. */}
            <a
              className="settings:mb-1 settings:hidden settings:min-h-[var(--lm-tap-target)] settings:items-center settings:text-link settings:before:mr-1 settings:before:content-['‹'] settings:compact:inline-flex"
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
  readonly entry: Contribution<SettingsSection>;
}): ReactNode {
  const section = entry.value;
  // Memoized per contribution: a new wrapper on every render is a different component
  // type to React, which remounts the section and throws away whatever the user had
  // half-typed into it.
  const Rendered = useMemo(
    () =>
      kernel.ui.boundary(section.component, {
        point: POINTS.settingsSection,
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
      {/* No "provided by <plugin>" line: which plugin owns a section is an admin
          question, and it was a second grey sentence under every heading. */}
      <Rendered />
    </section>
  );
}
