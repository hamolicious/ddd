/**
 * Settings → Database health: orphan files, duplicate files and duplicate notes.
 *
 * **Everything is flagged, nothing is deleted automatically** (SPEC §3.6). Each check
 * reads *materialized text*, so references held in plugins' `%%%` sections count, and a
 * trashed note still counts as using its files: restoring it must not find them gone.
 * Each duplicate copy says how many notes point at it, so the copy at "Nothing" is the one
 * that can go. A note goes to the Trash; a file is deleted for good, after a confirmation.
 */

import type { ReactElement, ReactNode } from "react";

import type { ConfirmRequest } from "plugin:context-menu";

import { formatBytes, formatWhen, usedBy, type HealthClient } from "./api.js";
import { useAsync, useMutation } from "./hooks.js";
import { RefreshIcon, ScanIcon, TrashIcon } from "./icons.js";

export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ROOT_CLASSES = "dbhealth:flex dbhealth:flex-col dbhealth:gap-4 dbhealth:font-sans dbhealth:text-text dbhealth:[&_:focus-visible]:outline-2 dbhealth:[&_:focus-visible]:outline-offset-1 dbhealth:[&_:focus-visible]:outline-focus dbhealth:[&_h3]:m-0 dbhealth:[&_h3]:text-base dbhealth:[&_h4]:m-0 dbhealth:[&_h4]:text-sm dbhealth:[&_h4]:font-semibold dbhealth:[&_button]:tap-h dbhealth:[&_button]:inline-flex dbhealth:[&_button]:min-w-[var(--ddd-tap-target)] dbhealth:[&_button]:cursor-pointer dbhealth:[&_button]:items-center dbhealth:[&_button]:justify-center dbhealth:[&_button]:rounded dbhealth:[&_button]:border dbhealth:[&_button]:border-border dbhealth:[&_button]:bg-bg-subtle dbhealth:[&_button]:text-inherit dbhealth:[&_button:disabled]:cursor-default dbhealth:[&_button:disabled]:opacity-55";
const PART = "dbhealth:flex dbhealth:flex-col dbhealth:gap-2";
const NOTE = "dbhealth:m-0 dbhealth:text-sm dbhealth:text-text-muted";
const ERROR = "dbhealth:m-0 dbhealth:rounded dbhealth:border dbhealth:border-danger dbhealth:p-2";
const ACTIONS = "dbhealth:flex dbhealth:flex-wrap dbhealth:gap-1";
const DANGER = "dbhealth:border-danger! dbhealth:text-danger!";
const SCROLL = "dbhealth:overflow-x-auto dbhealth:compact:overflow-x-visible";
const TABLE = "dbhealth:w-full dbhealth:border-collapse dbhealth:text-left dbhealth:text-sm dbhealth:[&_th]:border-b dbhealth:[&_th]:border-border dbhealth:[&_th]:p-1.5 dbhealth:[&_th]:align-top dbhealth:[&_th]:font-normal dbhealth:[&_td]:whitespace-nowrap dbhealth:[&_td]:border-b dbhealth:[&_td]:border-border dbhealth:[&_td]:p-1.5 dbhealth:[&_td]:align-top dbhealth:[&_thead_th]:text-xs dbhealth:[&_thead_th]:uppercase dbhealth:[&_thead_th]:text-text-muted dbhealth:compact:block dbhealth:compact:[&_thead]:sr-only dbhealth:compact:[&_tbody]:block dbhealth:compact:[&_tr]:mb-2 dbhealth:compact:[&_tr]:block dbhealth:compact:[&_tr]:rounded dbhealth:compact:[&_tr]:border dbhealth:compact:[&_tr]:border-border dbhealth:compact:[&_tr]:bg-bg-raised dbhealth:compact:[&_tr]:p-2 dbhealth:compact:[&_th]:block dbhealth:compact:[&_th]:border-0 dbhealth:compact:[&_th]:p-0 dbhealth:compact:[&_td]:block dbhealth:compact:[&_td]:whitespace-normal dbhealth:compact:[&_td]:border-0 dbhealth:compact:[&_td]:px-0 dbhealth:compact:[&_td]:py-0.5";
const LINK = "dbhealth:break-words dbhealth:text-link";
const HINT = "dbhealth:block dbhealth:break-words dbhealth:text-xs dbhealth:text-text-muted";

export function HealthSection({ client, confirm }: { readonly client: HealthClient; readonly confirm: Confirm }): ReactElement {
  return (
    <div className={ROOT_CLASSES}>
      <Orphans client={client} confirm={confirm} />
      <Duplicates client={client} confirm={confirm} />
    </div>
  );
}

function Orphans({ client, confirm }: { readonly client: HealthClient; readonly confirm: Confirm }): ReactElement {
  const orphans = useAsync(() => client.orphans());
  const mutation = useMutation(orphans.reload);
  const rows = orphans.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.attachment.size, 0);

  return (
    <section className={PART} aria-labelledby="dbhealth-orphans">
      <h3 id="dbhealth-orphans">Orphan files</h3>
      <p className={NOTE}>Files no note uses. A file used only by a trashed note is not an orphan.</p>
      <Failure error={orphans.error ?? mutation.error} />
      <div className={ACTIONS}>
        <button
          type="button"
          aria-label="Run the scan now"
          title="Run the scan now"
          disabled={mutation.busy === "scan"}
          onClick={() => mutation.run("scan", () => client.scanOrphans())}
        >
          <ScanIcon />
        </button>
        <button type="button" aria-label="Refresh orphan files" title="Refresh" onClick={orphans.reload}>
          <RefreshIcon />
        </button>
      </div>
      {orphans.loading ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className={NOTE}>No orphan files. Every stored file is used.</p>
      ) : (
        <>
          <p className={NOTE}>
            {rows.length} file{rows.length === 1 ? "" : "s"}, {formatBytes(total)} total.
          </p>
          <Table head={["Name", "Type", "Size", "Uploaded", "Flagged", "Actions"]}>
            {rows.map(({ attachment, flagged_at }) => (
              <tr key={attachment.id}>
                <th scope="row">
                  {/* The viewer's file page: look before deleting. */}
                  <a className={LINK} href={`#/file/${encodeURIComponent(attachment.id)}`}>
                    {attachment.name}
                  </a>
                  <span className={HINT}>{attachment.id}</span>
                </th>
                <td data-label="Type">{attachment.mime}</td>
                <td data-label="Size">{formatBytes(attachment.size)}</td>
                <td data-label="Uploaded">{formatWhen(attachment.created_at)}</td>
                <td data-label="Flagged">{formatWhen(flagged_at)}</td>
                <td>
                  <DeleteButton
                    label={`Delete ${attachment.name}`}
                    title="Delete"
                    busy={mutation.busy === attachment.id}
                    onClick={(anchor) => {
                      void confirm({
                        title: `Delete ${attachment.name} permanently?`,
                        description: "The file cannot be recovered.",
                        danger: true,
                        anchor,
                      }).then((ok) => {
                        if (ok) mutation.run(attachment.id, () => client.deleteAttachment(attachment.id));
                      });
                    }}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </section>
  );
}

function Duplicates({ client, confirm }: { readonly client: HealthClient; readonly confirm: Confirm }): ReactElement {
  const files = useAsync(() => client.duplicateFiles());
  const notes = useAsync(() => client.duplicateDocuments());
  const reload = (): void => {
    files.reload();
    notes.reload();
  };
  const mutation = useMutation(reload);
  const fileGroups = files.data ?? [];
  const noteGroups = notes.data ?? [];

  return (
    <section className={PART} aria-labelledby="dbhealth-duplicates">
      <h3 id="dbhealth-duplicates">Duplicates</h3>
      <p className={NOTE}>
        Copies under different ids: files with the same name and contents, notes with the same
        title and text. “Used by” counts the notes pointing at each copy; a copy nothing uses can
        go without breaking anything.
      </p>
      <Failure error={files.error ?? notes.error ?? mutation.error} />
      <div className={ACTIONS}>
        <button type="button" aria-label="Refresh duplicates" title="Refresh" onClick={reload}>
          <RefreshIcon />
        </button>
      </div>

      <h4>Files</h4>
      {files.loading ? (
        <p role="status">Loading…</p>
      ) : fileGroups.length === 0 ? (
        <p className={NOTE}>No duplicate files.</p>
      ) : (
        <Table head={["Name", "Size", "Uploaded", "Used by", "Actions"]}>
          {fileGroups.flatMap((group) =>
            group.files.map(({ attachment, references }, index) => (
              <tr key={attachment.id}>
                <th scope="row">
                  <a className={LINK} href={`#/file/${encodeURIComponent(attachment.id)}`}>
                    {attachment.name}
                  </a>
                  <span className={HINT}>
                    {index === 0 ? `${group.files.length} copies · ` : ""}
                    {attachment.id}
                  </span>
                </th>
                <td data-label="Size">{formatBytes(attachment.size)}</td>
                <td data-label="Uploaded">{formatWhen(attachment.created_at)}</td>
                <td data-label="Used by">{usedBy(references)}</td>
                <td>
                  <DeleteButton
                    label={`Delete this copy of ${attachment.name}`}
                    title="Delete this copy"
                    busy={mutation.busy === attachment.id}
                    onClick={(anchor) => {
                      void confirm({
                        title: `Delete this copy of ${attachment.name} permanently?`,
                        description:
                          references > 0
                            ? `${usedBy(references)} use this copy and will show a missing file. It cannot be recovered.`
                            : "Nothing uses this copy. It cannot be recovered.",
                        danger: true,
                        anchor,
                      }).then((ok) => {
                        if (ok) mutation.run(attachment.id, () => client.deleteAttachment(attachment.id));
                      });
                    }}
                  />
                </td>
              </tr>
            )),
          )}
        </Table>
      )}

      <h4>Notes</h4>
      {notes.loading ? (
        <p role="status">Loading…</p>
      ) : noteGroups.length === 0 ? (
        <p className={NOTE}>No duplicate notes.</p>
      ) : (
        <Table head={["Title", "Created", "Edited", "Linked from", "Actions"]}>
          {noteGroups.flatMap((group) =>
            group.documents.map((document, index) => {
              const title = group.title || "Untitled";
              return (
                <tr key={document.id}>
                  <th scope="row">
                    <a className={LINK} href={`#/doc/${encodeURIComponent(document.id)}`}>
                      {title}
                    </a>
                    <span className={HINT}>
                      {index === 0 ? `${group.documents.length} copies · ` : ""}
                      {document.id}
                    </span>
                  </th>
                  <td data-label="Created">{formatWhen(document.created_at)}</td>
                  <td data-label="Edited">{formatWhen(document.updated_at)}</td>
                  <td data-label="Linked from">{usedBy(document.references)}</td>
                  <td>
                    <DeleteButton
                      label={`Move this copy of ${title} to the Trash`}
                      title="Move this copy to the Trash"
                      busy={mutation.busy === document.id}
                      onClick={(anchor) => {
                        void confirm({
                          title: `Move this copy of ${title} to the Trash?`,
                          description:
                            document.references > 0
                              ? `${usedBy(document.references)} link to this copy. It can be restored from the Trash.`
                              : "Nothing links to this copy. It can be restored from the Trash.",
                          confirmLabel: "Move to Trash",
                          danger: true,
                          anchor,
                        }).then((ok) => {
                          if (ok) mutation.run(document.id, () => client.trashDocument(document.id));
                        });
                      }}
                    />
                  </td>
                </tr>
              );
            }),
          )}
        </Table>
      )}
    </section>
  );
}

function Failure({ error }: { readonly error: string | undefined }): ReactNode {
  return error ? (
    <p className={ERROR} role="alert">
      {error}
    </p>
  ) : null;
}

function Table({ head, children }: { readonly head: readonly string[]; readonly children: ReactNode }): ReactElement {
  return (
    <div className={SCROLL}>
      <table className={TABLE}>
        <thead>
          <tr>
            {head.map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function DeleteButton({
  label,
  title,
  busy,
  onClick,
}: {
  readonly label: string;
  readonly title: string;
  readonly busy: boolean;
  readonly onClick: (anchor: HTMLElement) => void;
}): ReactElement {
  return (
    <button type="button" className={DANGER} aria-label={label} title={title} disabled={busy} onClick={(event) => onClick(event.currentTarget)}>
      <TrashIcon />
    </button>
  );
}
