/**
 * Settings → Database health: orphan files, duplicate files and duplicate notes.
 *
 * **Everything is flagged, nothing is deleted automatically** (SPEC §3.6). Each check
 * reads *materialized text*, so references held in plugins' `%%%` sections count, and a
 * trashed note still counts as using its files: restoring it must not find them gone.
 * Each duplicate copy names the notes that use it. A bulk removal keeps one copy of every
 * group by a chosen rule (`cleanup.ts`) and previews, row by row, what it takes; only
 * "unused" cannot break a note. A note goes to the Trash; a file is deleted for good,
 * after a confirmation.
 */

import { useState, type ReactElement, type ReactNode } from "react";

import type { ConfirmRequest } from "plugin:context-menu";

import {
  formatBytes,
  formatWhen,
  usedBy,
  type HealthClient,
  type NoteRef,
} from "./api.js";
import { STRATEGIES, allToRemove, copiesToRemove, type Strategy } from "./cleanup.js";
import { useAsync, useMutation } from "./hooks.js";
import { RefreshIcon, ScanIcon, TrashIcon } from "./icons.js";

export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ROOT_CLASSES =
  "dbhealth:flex dbhealth:flex-col dbhealth:gap-4 dbhealth:font-sans dbhealth:text-text dbhealth:[&_:focus-visible]:outline-2 dbhealth:[&_:focus-visible]:outline-offset-1 dbhealth:[&_:focus-visible]:outline-focus dbhealth:[&_h3]:m-0 dbhealth:[&_h3]:text-base dbhealth:[&_h4]:m-0 dbhealth:[&_h4]:text-sm dbhealth:[&_h4]:font-semibold dbhealth:[&_button]:tap-h dbhealth:[&_button]:inline-flex dbhealth:[&_button]:min-w-[var(--ddd-tap-target)] dbhealth:[&_button]:cursor-pointer dbhealth:[&_button]:items-center dbhealth:[&_button]:justify-center dbhealth:[&_button]:rounded dbhealth:[&_button]:border dbhealth:[&_button]:border-border dbhealth:[&_button]:bg-bg-subtle dbhealth:[&_button]:text-inherit dbhealth:[&_button:disabled]:cursor-default dbhealth:[&_button:disabled]:opacity-55";
const PART = "dbhealth:flex dbhealth:flex-col dbhealth:gap-2";
const NOTE = "dbhealth:m-0 dbhealth:text-sm dbhealth:text-text-muted";
const ERROR =
  "dbhealth:m-0 dbhealth:rounded dbhealth:border dbhealth:border-danger dbhealth:p-2";
const ACTIONS = "dbhealth:flex dbhealth:flex-wrap dbhealth:gap-1";
const DANGER = "dbhealth:border-danger! dbhealth:text-danger!";
const SCROLL = "dbhealth:overflow-x-auto dbhealth:compact:overflow-x-visible";
const TABLE =
  "dbhealth:w-full dbhealth:border-collapse dbhealth:text-left dbhealth:text-sm dbhealth:[&_th]:border-b dbhealth:[&_th]:border-border dbhealth:[&_th]:p-1.5 dbhealth:[&_th]:align-top dbhealth:[&_th]:font-normal dbhealth:[&_td]:whitespace-nowrap dbhealth:[&_td]:border-b dbhealth:[&_td]:border-border dbhealth:[&_td]:p-1.5 dbhealth:[&_td]:align-top dbhealth:[&_td:last-child]:w-px dbhealth:[&_td:last-child]:text-right dbhealth:[&_thead_th:last-child]:text-right dbhealth:[&_thead_th]:text-xs dbhealth:[&_thead_th]:uppercase dbhealth:[&_thead_th]:text-text-muted dbhealth:compact:block dbhealth:compact:[&_thead]:sr-only dbhealth:compact:[&_tbody]:block dbhealth:compact:[&_tr]:mb-2 dbhealth:compact:[&_tr]:block dbhealth:compact:[&_tr]:rounded dbhealth:compact:[&_tr]:border dbhealth:compact:[&_tr]:border-border dbhealth:compact:[&_tr]:bg-bg-raised dbhealth:compact:[&_tr]:p-2 dbhealth:compact:[&_th]:block dbhealth:compact:[&_th]:border-0 dbhealth:compact:[&_th]:p-0 dbhealth:compact:[&_td]:block dbhealth:compact:[&_td]:whitespace-normal dbhealth:compact:[&_td]:border-0 dbhealth:compact:[&_td]:px-0 dbhealth:compact:[&_td]:py-0.5";
const LINK = "dbhealth:break-words dbhealth:text-link";
const HINT =
  "dbhealth:block dbhealth:break-words dbhealth:text-xs dbhealth:text-text-muted";
const TEXT_BUTTON = "dbhealth:px-2!";
const GROUP =
  "dbhealth:[&>tr:first-child>th]:bg-bg-subtle dbhealth:[&>tr:first-child>th]:pt-3 dbhealth:[&>tr:not(:first-child)>th]:pl-4 dbhealth:compact:mb-3 dbhealth:compact:block";
const GROUP_HEAD =
  "dbhealth:flex dbhealth:flex-wrap dbhealth:items-center dbhealth:justify-between dbhealth:gap-2";
const SAFE =
  "dbhealth:mt-0.5 dbhealth:block dbhealth:w-fit dbhealth:rounded dbhealth:bg-accent-subtle dbhealth:px-1 dbhealth:text-xs";
const AT_RISK =
  "dbhealth:mt-0.5 dbhealth:block dbhealth:w-fit dbhealth:rounded dbhealth:border dbhealth:border-danger dbhealth:px-1 dbhealth:text-xs dbhealth:text-danger";
const FIELD =
  "dbhealth:flex dbhealth:items-center dbhealth:gap-1 dbhealth:text-sm dbhealth:[&_select]:tap-h dbhealth:[&_select]:rounded dbhealth:[&_select]:border dbhealth:[&_select]:border-border dbhealth:[&_select]:bg-bg dbhealth:[&_select]:px-1 dbhealth:[&_select]:text-text";
const NOTE_LIST =
  "dbhealth:m-0 dbhealth:list-none dbhealth:p-0 dbhealth:whitespace-normal";

export function HealthSection({
  client,
  confirm,
}: {
  readonly client: HealthClient;
  readonly confirm: Confirm;
}): ReactElement {
  return (
    <div className={ROOT_CLASSES}>
      <Orphans client={client} confirm={confirm} />
      <Duplicates client={client} confirm={confirm} />
    </div>
  );
}

function Orphans({
  client,
  confirm,
}: {
  readonly client: HealthClient;
  readonly confirm: Confirm;
}): ReactElement {
  const orphans = useAsync(() => client.orphans());
  const mutation = useMutation(orphans.reload);
  const rows = orphans.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.attachment.size, 0);

  return (
    <section className={PART} aria-labelledby="dbhealth-orphans">
      <h3 id="dbhealth-orphans">Orphan files</h3>
      <p className={NOTE}>
        Files no note uses. A file used only by a trashed note is not an orphan.
      </p>
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
        <button
          type="button"
          aria-label="Refresh orphan files"
          title="Refresh"
          onClick={orphans.reload}
        >
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
            {rows.length} file{rows.length === 1 ? "" : "s"},{" "}
            {formatBytes(total)} total.
          </p>
          <Table
            head={["File", "Actions"]}
          >
            <tbody>
              {rows.map(({ attachment }) => (
                <tr key={attachment.id}>
                  <th scope="row">
                    {/* The viewer's file page: look before deleting. */}
                    <a
                      className={LINK}
                      href={`#/file/${encodeURIComponent(attachment.id)}`}
                    >
                      {attachment.name}
                    </a>
                    <span className={HINT}>
                      {attachment.mime} · {formatBytes(attachment.size)} · uploaded{" "}
                      {formatWhen(attachment.created_at)}
                    </span>
                    <span className={HINT}>{attachment.id}</span>
                  </th>
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
                          if (ok)
                            mutation.run(attachment.id, () =>
                              client.deleteAttachment(attachment.id),
                            );
                        });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
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
  const [strategy, setStrategy] = useState<Strategy>("unused");
  const fileGroups = files.data ?? [];
  const noteGroups = notes.data ?? [];
  const filesToGo = allToRemove(fileGroups, (group) => group.files.map(fileCopy), strategy);
  const notesToGo = allToRemove(noteGroups, (group) => group.documents, strategy);
  const total = filesToGo.length + notesToGo.length;

  /** Files are deleted, notes go to the Trash; one at a time, after one confirmation. */
  const remove = (key: string, anchor: HTMLElement, fileCopies: readonly Copy[], noteCopies: readonly Copy[]): void => {
    const count = fileCopies.length + noteCopies.length;
    const inUse = [...fileCopies, ...noteCopies].filter((copy) => copy.references > 0).length;
    const what = [
      fileCopies.length > 0 ? `${plural(fileCopies.length, "file")} will be deleted for good` : "",
      noteCopies.length > 0 ? `${plural(noteCopies.length, "note")} will go to the Trash` : "",
    ].filter(Boolean);
    void confirm({
      title: `Remove ${count} cop${count === 1 ? "y" : "ies"}?`,
      description:
        `${what.join("; ")}. A copy of each stays. ` +
        (inUse > 0
          ? `${inUse} of them ${inUse === 1 ? "is" : "are"} still used: the notes using ${inUse === 1 ? "it" : "them"} will show a missing file or a broken link.`
          : "Nothing uses them."),
      confirmLabel: "Remove",
      danger: true,
      anchor,
    }).then((ok) => {
      if (!ok) return;
      mutation.run(key, async () => {
        for (const file of fileCopies) await client.deleteAttachment(file.id);
        for (const note of noteCopies) await client.trashDocument(note.id);
      });
    });
  };

  return (
    <section className={PART} aria-labelledby="dbhealth-duplicates">
      <h3 id="dbhealth-duplicates">Duplicates</h3>
      <p className={NOTE}>
        Files with the same name and contents, and notes with the same title and text, stored more
        than once. A copy nothing uses is safe to remove while another copy stays.
      </p>
      <Failure error={files.error ?? notes.error ?? mutation.error} />
      <div className={ACTIONS}>
        <button type="button" aria-label="Refresh duplicates" title="Refresh" onClick={reload}>
          <RefreshIcon />
        </button>
        <label className={FIELD}>
          <span>Keep</span>
          <select value={strategy} onChange={(event) => setStrategy(event.currentTarget.value as Strategy)}>
            {STRATEGIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${TEXT_BUTTON} ${DANGER}`}
          disabled={total === 0 || mutation.busy !== undefined}
          onClick={(event) => remove("all", event.currentTarget, filesToGo, notesToGo)}
        >
          Remove {total} cop{total === 1 ? "y" : "ies"}
        </button>
      </div>

      <h4>Files</h4>
      {files.loading ? (
        <p role="status">Loading…</p>
      ) : fileGroups.length === 0 ? (
        <p className={NOTE}>No duplicate files.</p>
      ) : (
        <Table head={["Copy", "Used by", "Actions"]}>
          {fileGroups.map((group) => {
            const copies = group.files.map(fileCopy);
            const going = copiesToRemove(copies, strategy);
            const goingIds = new Set(going.map((copy) => copy.id));
            return (
              <Group
                key={`${group.name}/${group.sha256}`}
                label={group.name}
                detail={`${copies.length} copies · ${formatBytes(group.size)} each`}
                removing={going.length}
                busy={mutation.busy !== undefined}
                onRemove={(anchor) => remove(group.sha256, anchor, going, [])}
              >
                {group.files.map(({ attachment, references, referenced_by }, index) => (
                  <tr key={attachment.id}>
                    <th scope="row">
                      <a className={LINK} href={`#/file/${encodeURIComponent(attachment.id)}`}>
                        Copy {index + 1}
                        {index === 0 ? " (oldest)" : ""}
                      </a>
                      <span className={HINT}>uploaded {formatWhen(attachment.created_at)}</span>
                      <span className={HINT}>{attachment.id}</span>
                    </th>
                    <td data-label="Used by">
                      <UsedBy count={references} notes={referenced_by} going={goingIds.has(attachment.id)} />
                    </td>
                    <td>
                      <DeleteButton
                        label={`Delete copy ${index + 1} of ${group.name}`}
                        title="Delete this copy"
                        busy={mutation.busy === attachment.id}
                        onClick={(anchor) => {
                          void confirm({
                            title: `Delete copy ${index + 1} of ${group.name} permanently?`,
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
                ))}
              </Group>
            );
          })}
        </Table>
      )}

      <h4>Notes</h4>
      {notes.loading ? (
        <p role="status">Loading…</p>
      ) : noteGroups.length === 0 ? (
        <p className={NOTE}>No duplicate notes.</p>
      ) : (
        <Table head={["Copy", "Linked from", "Actions"]}>
          {noteGroups.map((group) => {
            const title = group.title || "Untitled";
            const going = copiesToRemove(group.documents, strategy);
            const goingIds = new Set(going.map((copy) => copy.id));
            const key = group.documents[0]?.id ?? title;
            return (
              <Group
                key={key}
                label={title}
                detail={`${group.documents.length} copies · ${formatBytes(group.size)} of text`}
                removing={going.length}
                busy={mutation.busy !== undefined}
                onRemove={(anchor) => remove(`notes/${key}`, anchor, [], going)}
              >
                {group.documents.map((document, index) => (
                  <tr key={document.id}>
                    <th scope="row">
                      <a className={LINK} href={`#/doc/${encodeURIComponent(document.id)}`}>
                        Copy {index + 1}
                        {index === 0 ? " (oldest)" : ""}
                      </a>
                      <span className={HINT}>created {formatWhen(document.created_at)}</span>
                      <span className={HINT}>{document.id}</span>
                    </th>
                    <td data-label="Linked from">
                      <UsedBy count={document.references} notes={document.referenced_by} going={goingIds.has(document.id)} />
                    </td>
                    <td>
                      <DeleteButton
                        label={`Move copy ${index + 1} of ${title} to the Trash`}
                        title="Move this copy to the Trash"
                        busy={mutation.busy === document.id}
                        onClick={(anchor) => {
                          void confirm({
                            title: `Move copy ${index + 1} of ${title} to the Trash?`,
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
                ))}
              </Group>
            );
          })}
        </Table>
      )}
    </section>
  );
}

interface Copy {
  readonly id: string;
  readonly references: number;
}

const fileCopy = (file: { readonly attachment: { readonly id: string }; readonly references: number }): Copy => ({
  id: file.attachment.id,
  references: file.references,
});

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One duplicate group: a heading row naming what is duplicated, then its copies. */
function Group({
  label,
  detail,
  removing,
  busy,
  onRemove,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  /** How many copies the chosen strategy removes from this group. */
  readonly removing: number;
  readonly busy: boolean;
  readonly onRemove: (anchor: HTMLElement) => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <tbody className={GROUP}>
      <tr>
        <th scope="rowgroup" colSpan={3}>
          <span className={GROUP_HEAD}>
            <span>
              <strong className="dbhealth:break-words">{label}</strong>
              <span className={HINT}>{detail}</span>
            </span>
            {removing > 0 && (
              <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={(event) => onRemove(event.currentTarget)}>
                Remove {removing} cop{removing === 1 ? "y" : "ies"}
              </button>
            )}
          </span>
        </th>
      </tr>
      {children}
    </tbody>
  );
}

/** Which notes use a copy, as links, and whether the chosen strategy removes it. */
function UsedBy({
  count,
  notes,
  going,
}: {
  readonly count: number;
  readonly notes: readonly NoteRef[];
  readonly going: boolean;
}): ReactElement {
  return (
    <>
      {count === 0 ? (
        <span>Nothing</span>
      ) : (
        <ul className={NOTE_LIST}>
          {notes.map((note) => (
            <li key={note.id}>
              <a className={LINK} href={`#/doc/${encodeURIComponent(note.id)}`}>
                {note.title || "Untitled"}
              </a>
              {note.trashed && <span className={HINT}>in the Trash</span>}
            </li>
          ))}
          {count > notes.length && <li className={HINT}>and {count - notes.length} more</li>}
        </ul>
      )}
      {going &&
        (count === 0 ? (
          <span className={SAFE}>Unused, will be removed</span>
        ) : (
          <span className={AT_RISK}>In use, will be removed</span>
        ))}
    </>
  );
}

function Failure({ error }: { readonly error: string | undefined }): ReactNode {
  return error ? (
    <p className={ERROR} role="alert">
      {error}
    </p>
  ) : null;
}

function Table({
  head,
  children,
}: {
  readonly head: readonly string[];
  readonly children: ReactNode;
}): ReactElement {
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
        {children}
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
    <button
      type="button"
      className={DANGER}
      aria-label={label}
      title={title}
      disabled={busy}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <TrashIcon />
    </button>
  );
}
