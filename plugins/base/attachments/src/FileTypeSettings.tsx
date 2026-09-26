/**
 * Settings → Attachments: one row per file type. Pasted as Preview or Link, and, when
 * more than one viewer claims the type, which one shows it.
 *
 * The list is every type that has a paste setting (declared, or pasted since) or a
 * viewer. Live, because a first paste, a newly installed viewer, or a change on another
 * device can land while this screen is open.
 */

import type { Kernel, SettingsValue } from "@kernel";
import { useEffect, useState, type ReactNode } from "react";

import { PASTE_AS, knownExtensions, pasteAs, settingKey, viewKey, type PasteAs } from "./kinds.js";
import type { Viewers } from "./view.js";

const LABELS: Readonly<Record<PasteAs, string>> = { preview: "Preview", link: "Link" };

const CONTROL =
  "attachments:tap-h attachments:cursor-pointer attachments:text-sm attachments:focus-visible:outline-2 attachments:focus-visible:outline-focus";

export function FileTypeSettings({
  kernel,
  viewers,
}: {
  readonly kernel: Kernel;
  readonly viewers: Viewers;
}): ReactNode {
  const read = (): Readonly<Record<string, SettingsValue>> => {
    try {
      return kernel.settings.all();
    } catch {
      return {};
    }
  };
  const [values, setValues] = useState(read);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // A viewer installed or removed while this screen is open changes the rows.
  const [, setViewerVersion] = useState(0);
  useEffect(() => viewers.subscribe(() => setViewerVersion((n) => n + 1)), [viewers]);
  useEffect(() => {
    try {
      return kernel.settings.subscribe(() => setValues(read()));
    } catch (error: unknown) {
      kernel.log.warn("settings changes will not be followed on this screen", error);
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  const write = (key: string, value: string): void => {
    const previous = values;
    setValues({ ...values, [key]: value });
    setProblem(undefined);
    kernel.settings.set(key, value).catch((error: unknown) => {
      setValues(previous);
      setProblem(`That could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const extensions = [...new Set([...knownExtensions(values), ...viewers.extensions()])].sort();

  return (
    <div className="attachments:flex attachments:max-w-[60ch] attachments:flex-col attachments:gap-3 attachments:font-sans attachments:text-text">
      <p className="attachments:m-0 attachments:text-sm attachments:leading-[1.5] attachments:text-text-muted">
        A file pasted into a document is uploaded and put in as a preview or a link. A
        preview is shown by a viewer for its type; with no viewer it shows as a link. A
        new file type is added here the first time you paste one.
      </p>

      <ul className="attachments:m-0 attachments:flex attachments:list-none attachments:flex-col attachments:gap-2 attachments:p-0">
        {extensions.map((extension) => {
          const current = pasteAs(values[settingKey(extension)]);
          const candidates = viewers.candidates(extension);
          const shown = viewers.resolve(extension)?.viewer;
          return (
            <li
              key={extension}
              className="attachments:flex attachments:flex-wrap attachments:items-center attachments:gap-x-3 attachments:gap-y-1 attachments:border-b attachments:border-border attachments:pb-2"
            >
              <span className="attachments:min-w-[5ch] attachments:font-mono attachments:text-sm">.{extension}</span>
              <span
                role="radiogroup"
                aria-label={`Pasted .${extension} files`}
                className="attachments:inline-flex attachments:overflow-hidden attachments:rounded attachments:border attachments:border-border-strong"
              >
                {PASTE_AS.map((as) => (
                  <button
                    key={as}
                    type="button"
                    role="radio"
                    aria-checked={current === as}
                    className={`${CONTROL} attachments:border-0 attachments:px-3 attachments:focus-visible:-outline-offset-2 ${
                      current === as
                        ? "attachments:bg-accent attachments:text-accent-text"
                        : "attachments:bg-bg-raised attachments:text-text"
                    }`}
                    onClick={() => write(settingKey(extension), as)}
                  >
                    {LABELS[as]}
                  </button>
                ))}
              </span>
              {candidates.length > 1 ? (
                <label className="attachments:flex attachments:min-w-0 attachments:flex-1 attachments:items-center attachments:gap-2 attachments:text-sm">
                  <span className="attachments:text-text-muted">Shown with</span>
                  <select
                    className={`${CONTROL} attachments:min-w-0 attachments:flex-1 attachments:rounded attachments:border attachments:border-border-strong attachments:bg-bg-raised attachments:px-2 attachments:text-text attachments:focus-visible:outline-offset-2`}
                    value={shown?.id ?? ""}
                    onChange={(event) => write(viewKey(extension), event.target.value)}
                  >
                    {candidates.map((viewer) => (
                      <option key={viewer.id} value={viewer.id}>
                        {viewer.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="attachments:text-sm attachments:text-text-muted">
                  {shown ? `Shown with ${shown.label}` : "No viewer: shown as a link"}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {problem ? (
        <p className="attachments:m-0 attachments:text-sm attachments:text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
