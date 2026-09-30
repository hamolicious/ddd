/**
 * The body of a `modal` (and so of `confirm`): fields in a column, buttons in a row.
 *
 * **A form**, so Enter in a text field presses the default button the way it does in any
 * other dialog; the default button is the form's only `type="submit"`. Validation runs
 * when a non-dismiss button is chosen, marks each field it rejects, and moves focus to
 * the first of them; nothing resolves until every field passes.
 */

import { useRef, useState } from "react";
import type { ReactElement } from "react";

import type {
  ConfirmRequest,
  ModalButton,
  ModalField,
  ModalRequest,
  ModalResult,
  ModalValue,
} from "./api.js";

const OK: readonly ModalButton[] = [{ id: "ok", label: "OK", tone: "primary" }];

const INPUT =
  "ctxmenu:tap-h ctxmenu:w-full ctxmenu:rounded ctxmenu:border ctxmenu:border-border ctxmenu:bg-bg ctxmenu:px-2 ctxmenu:text-base ctxmenu:text-text ctxmenu:aria-invalid:border-danger";

// Important: the app styles every `button[type=submit]` in the accent colour, unlayered,
// and the default button here is the form's submit.
const TONES = {
  plain: "ctxmenu:border-border! ctxmenu:bg-bg-subtle! ctxmenu:text-text!",
  primary: "ctxmenu:border-accent! ctxmenu:bg-accent! ctxmenu:text-accent-text!",
  danger: "ctxmenu:border-danger! ctxmenu:bg-danger! ctxmenu:text-danger-text!",
} as const;

/** `confirm`'s request, as the modal it is. */
export function confirmModal(request: ConfirmRequest): ModalRequest {
  const typed = request.typeToConfirm;
  return {
    title: request.title,
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.anchor ? { anchor: request.anchor } : {}),
    ...(typed === undefined
      ? {}
      : {
          fields: [
            {
              kind: "text",
              id: "typed",
              label: `Type ${typed} to confirm`,
              validate: (value) => (value === typed ? undefined : `Type ${typed} exactly.`),
            },
          ],
        }),
    buttons: [
      { id: "cancel", label: request.cancelLabel ?? "Cancel", dismiss: true, autoFocus: request.danger === true },
      {
        id: "confirm",
        label: request.confirmLabel ?? (request.danger ? "Delete" : "Confirm"),
        tone: request.danger ? "danger" : "primary",
        default: true,
      },
    ],
  };
}

export function ModalForm({
  request,
  settle,
  close,
}: {
  readonly request: ModalRequest;
  readonly settle: (result: ModalResult) => void;
  readonly close: () => void;
}): ReactElement {
  const fields = request.fields ?? [];
  const buttons = request.buttons?.length ? request.buttons : OK;
  const fallback = [...buttons].reverse().find((button) => !button.dismiss);
  const primary = buttons.find((button) => button.default && !button.dismiss) ?? fallback;
  const focusButton = fields.length > 0 ? undefined : (buttons.find((button) => button.autoFocus) ?? primary);

  const [values, setValues] = useState<Record<string, ModalValue>>(() => initialValues(fields));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const form = useRef<HTMLFormElement | null>(null);

  const choose = (button: ModalButton): void => {
    if (button.dismiss) {
      close();
      return;
    }
    const found = check(fields, values);
    const first = fields.find((field) => found[field.id] !== undefined);
    if (first) {
      setErrors(found);
      form.current?.querySelector<HTMLElement>(`[name="${CSS.escape(first.id)}"]`)?.focus();
      return;
    }
    settle({ button: button.id, values: { ...values } });
    close();
  };

  const change = (id: string, value: ModalValue): void => {
    setValues((current) => ({ ...current, [id]: value }));
    if (errors[id] !== undefined) {
      setErrors((current) => {
        const { [id]: _cleared, ...rest } = current;
        return rest;
      });
    }
  };

  return (
    <form
      ref={form}
      noValidate
      className="ctxmenu:flex ctxmenu:flex-col ctxmenu:gap-3 ctxmenu:px-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (primary) choose(primary);
      }}
    >
      {fields.map((field, index) => (
        <Field
          key={field.id}
          field={field}
          value={values[field.id]}
          error={errors[field.id]}
          autoFocus={index === 0}
          onChange={(value) => change(field.id, value)}
        />
      ))}
      <div className="ctxmenu:flex ctxmenu:flex-wrap ctxmenu:justify-end ctxmenu:gap-2">
        {buttons.map((button) => (
          <button
            key={button.id}
            type={button === primary ? "submit" : "button"}
            data-autofocus={button === focusButton ? "" : undefined}
            className={`ctxmenu:tap-h ctxmenu:flex-1 ctxmenu:cursor-pointer ctxmenu:rounded ctxmenu:border ctxmenu:px-3 ctxmenu:sm:flex-none ${TONES[button.tone ?? "plain"]}`}
            onClick={button === primary ? undefined : () => choose(button)}
          >
            {button.label}
          </button>
        ))}
      </div>
    </form>
  );
}

function Field({
  field,
  value,
  error,
  autoFocus,
  onChange,
}: {
  readonly field: ModalField;
  readonly value: ModalValue | undefined;
  readonly error: string | undefined;
  readonly autoFocus: boolean;
  readonly onChange: (value: ModalValue) => void;
}): ReactElement {
  const id = `ctxmenu-field-${field.id}`;
  const note = error ?? field.hint;
  const described = note === undefined ? {} : { "aria-describedby": `${id}-note` };
  const common = {
    id,
    name: field.id,
    "aria-invalid": error === undefined ? undefined : true,
    "data-autofocus": autoFocus ? "" : undefined,
    ...described,
  };

  const control =
    field.kind === "checkbox" ? (
      <input
        {...common}
        type="checkbox"
        className="ctxmenu:size-6 ctxmenu:shrink-0 ctxmenu:accent-accent"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    ) : field.kind === "select" ? (
      <select {...common} className={INPUT} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : field.kind === "textarea" ? (
      <textarea
        {...common}
        className={`${INPUT} ctxmenu:min-h-24 ctxmenu:py-1`}
        value={String(value ?? "")}
        placeholder={field.placeholder}
        required={field.required}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : (
      <input
        {...common}
        type={field.type ?? "text"}
        className={INPUT}
        value={String(value ?? "")}
        placeholder={field.placeholder}
        required={field.required}
        onChange={(event) => onChange(event.target.value)}
      />
    );

  return (
    <div className="ctxmenu:flex ctxmenu:flex-col ctxmenu:gap-1">
      {field.kind === "checkbox" ? (
        <label htmlFor={id} className="ctxmenu:tap-h ctxmenu:flex ctxmenu:items-center ctxmenu:gap-2">
          {control}
          <span>{field.label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={id} className="ctxmenu:text-sm ctxmenu:text-text-muted">
            {field.label}
          </label>
          {control}
        </>
      )}
      {note === undefined ? null : (
        <small id={`${id}-note`} className={error === undefined ? "ctxmenu:text-text-muted" : "ctxmenu:text-danger"}>
          {note}
        </small>
      )}
    </div>
  );
}

function initialValues(fields: readonly ModalField[]): Record<string, ModalValue> {
  const values: Record<string, ModalValue> = {};
  for (const field of fields) {
    values[field.id] =
      field.kind === "checkbox"
        ? field.value === true
        : field.kind === "select"
          ? (field.value ?? field.options[0]?.value ?? "")
          : (field.value ?? "");
  }
  return values;
}

/** Each rejected field's message, by id. */
export function check(
  fields: readonly ModalField[],
  values: Readonly<Record<string, ModalValue>>,
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind !== "text" && field.kind !== "textarea") continue;
    const value = String(values[field.id] ?? "");
    const message =
      field.required && value.trim() === "" ? "Required." : field.validate?.(value, values);
    if (message !== undefined) found[field.id] = message;
  }
  return found;
}
