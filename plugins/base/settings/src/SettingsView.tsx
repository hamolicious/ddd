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
    <div className="settings-root" data-view={chosen ? "section" : "index"}>
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="settings-shared-note">
          Other people in this workspace can read your settings. Put secrets in admin
          plugin configuration, which is encrypted.
        </p>
      </header>

      {sections.length === 0 ? (
        <p className="settings-empty">No plugin has contributed any settings.</p>
      ) : (
        <div className="settings-panes">
          <nav className="settings-nav" aria-label="Settings sections">
            <ul>
              {sections.map((entry) => (
                <li key={entry.value.id}>
                  <a
                    href={router.url(`/settings/${encodeURIComponent(entry.value.id)}`)}
                    className="settings-nav-link"
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

          <div className="settings-pane">
            {/* The way back out of a drilled-in section. A real link, because it is a
                real navigation — and hidden by the stylesheet on a screen wide enough
                to show the list beside the section anyway. */}
            <a
              className="settings-back"
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
    <section className="settings-section" aria-labelledby={`settings-${section.id}`}>
      <h2 id={`settings-${section.id}`}>{section.title}</h2>
      {section.description ? (
        <p className="settings-section-description">{section.description}</p>
      ) : null}
      {/* No "provided by <plugin>" line: which plugin owns a section is an admin
          question, and it was a second grey sentence under every heading. */}
      <Rendered />
    </section>
  );
}
