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
  const active =
    sections.find((entry) => entry.value.id === requested) ??
    // An unknown section id falls back to the first rather than to an empty pane: the
    // id may belong to a plugin that has not activated, or has been uninstalled.
    sections[0];

  return (
    <div className="settings-root">
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="settings-shared-note">
          Settings are stored as a <strong>per-user document in this shared workspace</strong>.
          They sync and work offline like everything else — and other users of this
          workspace can read them. Never put a secret here; plugin secrets belong in
          admin configuration, which is encrypted at rest.
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
      <p className="settings-section-owner">
        provided by <code>{entry.pluginId}</code>
      </p>
      <Rendered />
    </section>
  );
}
