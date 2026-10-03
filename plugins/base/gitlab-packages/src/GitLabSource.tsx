import { useId, useState } from "react";
import type { FormEvent, ReactElement } from "react";

import type { PackageSourceProps } from "plugin:admin";

import { DEFAULT_INSTANCE, defaultFileName, packageRequest, type TokenKind } from "./gitlab.js";

const REMEMBERED_KEY = "ddd.gitlab-packages.last";

interface Remembered {
  readonly instance: string;
  readonly project: string;
  readonly tokenKind: TokenKind;
}

function recall(): Remembered | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(REMEMBERED_KEY);
    return raw ? (JSON.parse(raw) as Remembered) : undefined;
  } catch {
    return undefined;
  }
}

function remember(value: Remembered): void {
  try {
    globalThis.localStorage?.setItem(REMEMBERED_KEY, JSON.stringify(value));
  } catch {
    return;
  }
}

const TOKEN_KINDS: readonly { readonly value: TokenKind; readonly label: string }[] = [
  { value: "access", label: "Access token (personal, project or group)" },
  { value: "deploy", label: "Deploy token" },
  { value: "job", label: "CI job token" },
  { value: "none", label: "No token (public project)" },
];

const SELECT_CLASSES =
  "gitlabpackages:tap-h gitlabpackages:rounded gitlabpackages:border gitlabpackages:border-border gitlabpackages:bg-bg gitlabpackages:px-2 gitlabpackages:text-base gitlabpackages:text-text";

export function GitLabSource({ busy, installFromUrl }: PackageSourceProps): ReactElement {
  const id = useId();
  const last = recall();
  const [instance, setInstance] = useState(last?.instance ?? DEFAULT_INSTANCE);
  const [project, setProject] = useState(last?.project ?? "");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState("");
  const [tokenKind, setTokenKind] = useState<TokenKind>(last?.tokenKind ?? "access");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    let request;
    try {
      request = packageRequest({ instance, project, name, version, file, tokenKind, token });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    setProblem(undefined);
    remember({ instance, project, tokenKind });
    void installFromUrl(request).then((outcome) => {
      if (outcome) setToken("");
    });
  };

  const field = (
    key: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    extra: { placeholder?: string; type?: string; autoComplete?: string; required?: boolean } = {},
  ): ReactElement => (
    <label className="admin-field" htmlFor={`${id}-${key}`}>
      {label}
      <input
        id={`${id}-${key}`}
        type={extra.type ?? "text"}
        value={value}
        placeholder={extra.placeholder}
        autoComplete={extra.autoComplete ?? "off"}
        required={extra.required}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );

  return (
    <form className="admin-form" onSubmit={submit} aria-label="Install from GitLab">
      <div className="admin-inline-form">
        {field("instance", "GitLab address", instance, setInstance, { placeholder: DEFAULT_INSTANCE })}
        {field("project", "Project ID or path", project, setProject, {
          placeholder: "group/project",
          required: true,
        })}
      </div>
      <div className="admin-inline-form">
        {field("name", "Package name", name, setName, { required: true })}
        {field("version", "Version", version, setVersion, { placeholder: "1.0.0", required: true })}
        {field("file", "File name", file, setFile, {
          placeholder: defaultFileName(name, version) || "name-version.zip",
        })}
      </div>
      <div className="admin-inline-form">
        <div className="admin-field">
          <label htmlFor={`${id}-kind`}>Token</label>
          <select
            id={`${id}-kind`}
            className={SELECT_CLASSES}
            value={tokenKind}
            disabled={busy}
            onChange={(event) => setTokenKind(event.target.value as TokenKind)}
          >
            {TOKEN_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
        {tokenKind !== "none" &&
          field("token", "Token value", token, setToken, { type: "password", autoComplete: "new-password" })}
        <button type="submit" disabled={busy}>
          {busy ? "Downloading…" : "Download and install"}
        </button>
      </div>
      <p className="admin-hint">
        The server downloads the package; the token is sent once and never stored. A token
        needs the <code>read_package_registry</code> scope.
      </p>
      {problem !== undefined && (
        <p className="admin-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
