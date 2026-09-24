/**
 * The plugin config form, generated from the manifest's `config` schema (SPEC §6.2).
 *
 * Three rules, in the order they can hurt:
 *
 * 1. **A secret is write-only.** It is never returned by a read — the server sends
 *    `••••••••` and a "set" flag — so the field renders empty with "leave blank to keep the
 *    stored value", and an untouched secret is *dropped from the submission* rather than
 *    sent back. Sending the mask back would overwrite a real credential with eight bullets,
 *    and nothing would say so until the next cron run failed to authenticate.
 * 2. **The schema is the form.** Types, labels, descriptions, defaults, `required` and
 *    `select` options all come from the manifest; this file has no per-plugin knowledge and
 *    must never grow any.
 * 3. **The server validates.** `validate_value` runs per field on write and a 400 lands in
 *    the error strip. The `required` marks and `type=number` inputs here are affordances,
 *    not a second validator that could disagree.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import {
  configSubmission,
  normalizeConfigValues,
  type AdminClient,
  type PluginAdminView,
  type PluginConfigSchemaField,
  type PluginConfigView,
} from "./api.js";
import { useAsync, useMutation } from "./hooks.js";

export function PluginConfigForm({
  client,
  plugin,
}: {
  readonly client: AdminClient;
  readonly plugin: PluginAdminView;
}): ReactElement {
  const schema = plugin.config_schema;
  const keys = useMemo(() => Object.keys(schema), [schema]);
  const loaded = useAsync<PluginConfigView>(() => client.pluginConfig(plugin.id), [plugin.id]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);
  const save = useMutation(() => {
    setSaved(true);
    loaded.reload();
  });

  const placeholder = loaded.data?.secret_placeholder ?? "••••••••";
  const current = useMemo(
    () => normalizeConfigValues(loaded.data?.values, schema, placeholder),
    [loaded.data, schema, placeholder],
  );

  // Re-seed the draft whenever the server's answer changes, and only then: re-seeding on
  // every render would fight the person typing.
  useEffect(() => {
    if (!loaded.data) return;
    const next: Record<string, unknown> = {};
    for (const key of keys) {
      const field = schema[key];
      next[key] = field?.secret === true ? "" : (current[key]?.value ?? "");
    }
    setDraft(next);
  }, [loaded.data, keys.join("|")]);

  if (keys.length === 0) {
    return <p className="admin-note">This plugin declares no configuration.</p>;
  }

  return (
    <form
      className="admin-plugin-config"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.run(plugin.id, () =>
          client.savePluginConfig(plugin.id, configSubmission(draft, schema, placeholder)),
        );
      }}
    >
      {loaded.error !== undefined && (
        <p className="admin-error" role="alert">
          {loaded.error}
        </p>
      )}
      {loaded.loading && <p role="status">Loading configuration…</p>}

      {keys.map((key) => {
        const field = schema[key] as PluginConfigSchemaField;
        const state = current[key];
        const inputId = `admin-config-${plugin.id}-${key}`;
        return (
          <div className="admin-field" key={key}>
            <label htmlFor={inputId}>
              {field.label ?? key}
              {field.required === true && <span aria-hidden="true"> *</span>}
              {field.secret === true && <span className="admin-badge">secret</span>}
            </label>
            {field.description !== undefined && (
              <p className="admin-note" id={`${inputId}-hint`}>
                {field.description}
              </p>
            )}
            {field.type === "boolean" ? (
              <input
                id={inputId}
                type="checkbox"
                checked={draft[key] === true || draft[key] === "true"}
                aria-describedby={field.description ? `${inputId}-hint` : undefined}
                onChange={(event) =>
                  setDraft((values) => ({ ...values, [key]: event.target.checked }))
                }
              />
            ) : field.type === "select" && (field.options?.length ?? 0) > 0 ? (
              <select
                id={inputId}
                value={String(draft[key] ?? "")}
                aria-describedby={field.description ? `${inputId}-hint` : undefined}
                onChange={(event) => setDraft((values) => ({ ...values, [key]: event.target.value }))}
              >
                <option value="">(not set)</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={inputId}
                type={field.secret === true ? "password" : field.type === "number" ? "number" : "text"}
                autoComplete={field.secret === true ? "new-password" : "off"}
                value={String(draft[key] ?? "")}
                placeholder={
                  field.secret === true
                    ? state?.set === true
                      ? "stored — leave blank to keep it"
                      : "not set"
                    : field.default !== undefined
                      ? `default: ${String(field.default)}`
                      : ""
                }
                aria-describedby={field.description ? `${inputId}-hint` : undefined}
                onChange={(event) => setDraft((values) => ({ ...values, [key]: event.target.value }))}
              />
            )}
          </div>
        );
      })}

      <p className="admin-note">
        Secrets are encrypted at rest and never returned by this screen. Leaving a secret blank
        keeps the stored value; clearing a stored secret means entering a new one.
      </p>

      {save.error !== undefined && (
        <p className="admin-error" role="alert">
          {save.error}
        </p>
      )}
      {saved && save.error === undefined && (
        <p className="admin-note" role="status">
          Saved.
        </p>
      )}

      <div className="admin-actions">
        <button type="submit" disabled={save.busy !== undefined || loaded.loading}>
          {save.busy !== undefined ? "Saving…" : "Save configuration"}
        </button>
      </div>
    </form>
  );
}
