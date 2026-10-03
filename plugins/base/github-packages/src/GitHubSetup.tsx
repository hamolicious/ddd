import { useId } from "react";
import type { ReactElement } from "react";

import type { SetupProps } from "plugin:admin";

import { readSettings, writeSettings, type GitHubSettings } from "./github.js";

export function GitHubSetup({ value, onChange, disabled }: SetupProps): ReactElement {
  const id = useId();
  const settings = readSettings(value);
  const change = (patch: Partial<GitHubSettings>): void => onChange(writeSettings({ ...settings, ...patch }));

  return (
    <div className="admin-form">
      <div className="admin-inline-form">
        <label className="admin-field" htmlFor={`${id}-repo`}>
          Repository
          <input
            id={`${id}-repo`}
            type="text"
            value={settings.repo}
            placeholder="owner/name"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => change({ repo: event.target.value })}
          />
        </label>
        <label className="admin-field" htmlFor={`${id}-token`}>
          Token (optional)
          <input
            id={`${id}-token`}
            type="password"
            value={settings.token}
            autoComplete="new-password"
            disabled={disabled}
            onChange={(event) => change({ token: event.target.value })}
          />
        </label>
      </div>
      <p className="admin-hint">
        Every published release is read, and the newest <code>.zip</code> asset of each plugin is
        offered. Name assets <code>plugin-id-1.2.3.zip</code>, or name them after the plugin and tag
        the release with its version. A public repository needs no token; for a private one, use a
        token that can read the repository's contents. It is stored encrypted on the server.
      </p>
    </div>
  );
}
