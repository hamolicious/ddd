import { useId } from "react";
import type { ReactElement } from "react";

import type { SetupProps } from "plugin:admin";

import { DEFAULT_INSTANCE, readSettings, writeSettings, type GitLabSettings, type TokenKind } from "./gitlab.js";

const TOKEN_KINDS: readonly { readonly value: TokenKind; readonly label: string }[] = [
  { value: "access", label: "Access token (personal, project or group)" },
  { value: "deploy", label: "Deploy token" },
  { value: "job", label: "CI job token" },
  { value: "none", label: "No token (public project)" },
];

const SELECT_CLASSES =
  "gitlabpackages:tap-h gitlabpackages:rounded gitlabpackages:border gitlabpackages:border-border gitlabpackages:bg-bg gitlabpackages:px-2 gitlabpackages:text-base gitlabpackages:text-text";

export function GitLabSetup({ value, onChange, disabled }: SetupProps): ReactElement {
  const id = useId();
  const settings = readSettings(value);
  const change = (patch: Partial<GitLabSettings>): void => onChange(writeSettings({ ...settings, ...patch }));

  const field = (
    key: keyof GitLabSettings,
    label: string,
    extra: { readonly placeholder?: string; readonly type?: string; readonly autoComplete?: string } = {},
  ): ReactElement => (
    <label className="admin-field" htmlFor={`${id}-${key}`}>
      {label}
      <input
        id={`${id}-${key}`}
        type={extra.type ?? "text"}
        value={settings[key]}
        placeholder={extra.placeholder}
        autoComplete={extra.autoComplete ?? "off"}
        disabled={disabled}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </label>
  );

  return (
    <div className="admin-form">
      <div className="admin-inline-form">
        {field("instance", "GitLab address", { placeholder: DEFAULT_INSTANCE })}
        {field("project", "Project ID or path", { placeholder: "group/project" })}
      </div>
      <div className="admin-inline-form">
        <div className="admin-field">
          <label htmlFor={`${id}-kind`}>Token</label>
          <select
            id={`${id}-kind`}
            className={SELECT_CLASSES}
            value={settings.tokenKind}
            disabled={disabled}
            onChange={(event) => change({ tokenKind: event.target.value as TokenKind })}
          >
            {TOKEN_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
        {settings.tokenKind !== "none" && field("token", "Token value", { type: "password", autoComplete: "new-password" })}
      </div>
      <p className="admin-hint">
        Packages are the project's generic packages; each one's newest <code>.zip</code> is
        offered. A token needs the <code>read_package_registry</code> scope. It is stored
        encrypted on the server and used by admins' browsers.
      </p>
    </div>
  );
}
