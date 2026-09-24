/**
 * `properties` — typed frontmatter editing (SPEC §6.5).
 *
 * This is the plugin the splice rule of SPEC §3.3 exists for. Humans own frontmatter;
 * a properties panel that parsed the block and wrote it back would destroy comments and
 * formatting, and would clobber a collaborator mid-edit. **Every write here is
 * `kernel.documents.splice.setFrontmatterValue`**, which replaces one key's value span
 * and nothing else. There is exactly one `set` and one `remove` in this file, no editor
 * touches the document itself, and no code path anywhere in it serializes a block.
 *
 * Per-key editors are contributed (`properties.editor`), so a plugin that introduces a
 * frontmatter convention brings its own widget — a date picker for `fm.date`, a folder
 * picker for `fm.path`, a tag input for `fm.tags` — without this plugin knowing about
 * any of them. The five shipped below are the fallbacks, and the date picker is one of
 * them because dates are a type in the filter DSL and are canonicalized at
 * materialization (SPEC §3.4): typing one by hand is how you get a string that never
 * sorts.
 */

import { NotImplementedError, type CoreValue, type DocumentRow, type Kernel, type OpenDocument } from "@kernel";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";

import {
  POINTS,
  propertiesEditorShape,
  type Command,
  type PropertiesEditor,
  type PropertiesEditorProps,
} from "../../_shared/points.js";
import {
  formatScalar,
  isDateKey,
  isIsoDateLike,
  joinDateValue,
  keyProblem,
  parseListInput,
  parseScalarInput,
  rowsFromFm,
  splitDateValue,
  type PropertyRow,
} from "./rows.js";

export interface PropertiesApi {
  /** The editor that claims a key, best match first. */
  editorFor(key: string, value: CoreValue | undefined): PropertiesEditor | undefined;
  /** Set one frontmatter key. A single splice; creates the block if absent. */
  set(documentId: string, key: string, value: CoreValue): Promise<void>;
  remove(documentId: string, key: string): Promise<void>;
  /**
   * The panel, for anyone who wants it somewhere other than the sidebar (an in-surface
   * inspector, a settings screen). Additive to the M3 scaffold's API.
   */
  readonly Panel: ComponentType<Record<string, never>>;
}

/** The `document-surface` API, structurally — plugins never import each other. */
interface DocumentSurfaceApiShape {
  currentDocument(): string | undefined;
  currentHandle(): OpenDocument | undefined;
  currentRow?(): DocumentRow | undefined;
  onChange(listener: (state: { documentId?: string; mode?: string; row?: DocumentRow }) => void): () => void;
}

export default function activate(kernel: Kernel): PropertiesApi {
  const editors = kernel.extensions.definePoint<PropertiesEditor>({
    name: POINTS.propertiesEditor,
    shape: propertiesEditorShape,
    key: (editor) => editor.id,
    description: "A typed editor for one kind of frontmatter value.",
  });

  const surface = kernel.services.require<DocumentSurfaceApiShape>("document-surface");

  /**
   * The **one** write path. Aimed at the open handle when there is one, so the splice
   * lands in the same `Y.Doc` the editor is bound to and the change appears under the
   * cursor rather than after a round trip.
   */
  const target = (documentId: string): string | OpenDocument => {
    const handle = surface.currentHandle();
    return handle && surface.currentDocument() === documentId ? handle : documentId;
  };

  const api: PropertiesApi = {
    editorFor: (key, value) =>
      [...editors.get()]
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .find((editor) => {
          try {
            return editor.match(key, value);
          } catch {
            // A throwing matcher must not break the whole panel.
            return false;
          }
        }),
    set: (documentId, key, value) =>
      kernel.documents.splice.setFrontmatterValue(target(documentId), key, value),
    remove: (documentId, key) =>
      kernel.documents.splice.removeFrontmatterKey(target(documentId), key),
    Panel: () => (
      <PropertiesPanel
        kernel={kernel}
        api={api}
        surface={surface}
        // Attribution comes from the registry, never from a contribution's own `id`:
        // `properties.date` is an editor id, not a plugin id, and an error boundary that
        // named the wrong plugin would send the reader to the wrong admin row.
        ownerOf={(editor) => editors.entries().find((entry) => entry.value === editor)?.pluginId}
      />
    ),
  };

  // ---------------------------------------------------------------------
  // the shipped editors
  // ---------------------------------------------------------------------

  kernel.extensions.contribute<PropertiesEditor>(POINTS.propertiesEditor, {
    id: "properties.text",
    order: 900,
    match: () => true,
    component: TextValueEditor,
  });

  kernel.extensions.contribute<PropertiesEditor>(POINTS.propertiesEditor, {
    id: "properties.number",
    order: 200,
    match: (_field, value) => typeof value === "number",
    component: NumberValueEditor,
  });

  kernel.extensions.contribute<PropertiesEditor>(POINTS.propertiesEditor, {
    id: "properties.boolean",
    order: 200,
    match: (_field, value) => typeof value === "boolean",
    component: BooleanValueEditor,
  });

  kernel.extensions.contribute<PropertiesEditor>(POINTS.propertiesEditor, {
    id: "properties.date",
    order: 100,
    // Dates are a type in the filter DSL and are canonicalized at materialization
    // (SPEC §3.4), so a date field must be written in a canonical shape — which is what
    // the picker guarantees and free text does not.
    match: (field, value) =>
      (isDateKey(field) || isIsoDateLike(value)) &&
      (value === undefined || value === null || typeof value === "string"),
    component: DateValueEditor,
  });

  kernel.extensions.contribute<PropertiesEditor>(POINTS.propertiesEditor, {
    id: "properties.list",
    order: 100,
    match: (_field, value) => Array.isArray(value),
    component: ListValueEditor,
  });

  // ---------------------------------------------------------------------
  // where it shows
  // ---------------------------------------------------------------------

  kernel.extensions.contribute(POINTS.sidebarPanel, {
    id: "properties.panel",
    title: "Properties",
    order: 30,
    defaultOpen: true,
    component: api.Panel,
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "properties.addProperty",
    title: "Add a property",
    category: "Document",
    when: () => surface.currentDocument() !== undefined,
    run: () => {
      // The panel may not be mounted (collapsed sidebar, mobile drawer); the event is
      // ephemeral by design and a missed one costs a focus, not a write.
      kernel.events.emit("properties:focus-add");
    },
  });

  return api;
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

/**
 * The per-key editor props, unchanged from the published shape.
 *
 * There used to be a second, undocumented prop here. `PropertiesEditorProps` named the
 * key `key`, which React reserves: `createElement` strips it from the config to use as
 * the element key, so no component could ever read it. This plugin compensated by passing
 * the name twice — as `key` and as an extra `propertyKey` — and reading whichever
 * arrived, which worked for the editors below and for nobody else: a third-party editor
 * compiled against the frozen type read `props.key` and got `undefined`.
 *
 * The field is now `propertyKey` in the point shape itself (`plugins/base/_shared/points.ts`),
 * so the published contract is the one that works and this alias is just a local name.
 */
type ShippedEditorProps = PropertiesEditorProps;

/** The property name. */
function fieldOf(props: ShippedEditorProps): string {
  return props.propertyKey;
}

/** Wrapping a contributed component per render would remount it on every keystroke. */
const wrapped = new WeakMap<
  ComponentType<PropertiesEditorProps>,
  ComponentType<PropertiesEditorProps>
>();

function boundaryFor(
  kernel: Kernel,
  editor: PropertiesEditor,
  pluginId: string | undefined,
): ComponentType<PropertiesEditorProps> {
  const existing = wrapped.get(editor.component);
  if (existing) return existing;
  const component = kernel.ui.boundary(editor.component, {
    point: POINTS.propertiesEditor,
    ...(pluginId === undefined ? {} : { pluginId }),
  });
  wrapped.set(editor.component, component);
  return component;
}

type OwnerLookup = (editor: PropertiesEditor) => string | undefined;

function PropertiesPanel({
  kernel,
  api,
  surface,
  ownerOf,
}: {
  readonly kernel: Kernel;
  readonly api: PropertiesApi;
  readonly surface: DocumentSurfaceApiShape;
  readonly ownerOf: OwnerLookup;
}): ReactNode {
  const [documentId, setDocumentId] = useState<string | undefined>(() => surface.currentDocument());
  const [row, setRow] = useState<DocumentRow | undefined>(() => surface.currentRow?.());
  const addKeyInput = useRef<HTMLInputElement | null>(null);

  useEffect(
    () =>
      surface.onChange((state) => {
        setDocumentId(state.documentId);
        setRow(state.row ?? surface.currentRow?.());
      }),
    [surface],
  );

  useEffect(
    () => kernel.events.on("properties:focus-add", () => addKeyInput.current?.focus()),
    [kernel],
  );

  const rows = useMemo(() => rowsFromFm(row?.fm), [row]);

  if (documentId === undefined) {
    return (
      <div className="properties-root properties-empty">
        <p>Open a document to see its properties.</p>
      </div>
    );
  }

  return (
    <div className="properties-root">
      {row?.fm_parse_error ? (
        <p className="properties-warning" role="status">
          At least one frontmatter line could not be read and is missing from the list below.
          <strong> The document text is untouched</strong> — open edit mode to fix the line by
          hand. (SPEC §3.4: a malformed line is dropped, never rewritten.)
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="properties-empty">
          This document has no frontmatter yet. Adding a property writes a <code>---</code> block
          at the top of the text.
        </p>
      ) : (
        <dl className="properties-list">
          {rows.map((entry) => (
            <PropertyRowView
              key={entry.key}
              kernel={kernel}
              api={api}
              documentId={documentId}
              row={entry}
              ownerOf={ownerOf}
            />
          ))}
        </dl>
      )}

      <AddPropertyRow
        kernel={kernel}
        api={api}
        documentId={documentId}
        existingKeys={rows.map((entry) => entry.key)}
        keyInputRef={addKeyInput}
      />
    </div>
  );
}

function PropertyRowView({
  kernel,
  api,
  documentId,
  row,
  ownerOf,
}: {
  readonly kernel: Kernel;
  readonly api: PropertiesApi;
  readonly documentId: string;
  readonly row: PropertyRow;
  readonly ownerOf: OwnerLookup;
}): ReactNode {
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const editor = api.editorFor(row.key, row.value);
  const Editor = editor ? boundaryFor(kernel, editor, ownerOf(editor)) : undefined;

  const write = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      kernel.log.error(`could not write fm.${row.key}`, failure);
      setError(describeWriteFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="properties-row" data-kind={row.kind} data-busy={busy ? "true" : "false"}>
      <dt className="properties-key">
        <span className="properties-key-name" title={`${row.key} (${row.kind})`}>
          {row.key}
        </span>
      </dt>
      <dd className="properties-value">
        {Editor ? (
          <Editor
            key={row.key}
            documentId={documentId}
            propertyKey={row.key}
            value={row.value}
            onChange={(value: CoreValue) => write(() => api.set(documentId, row.key, value))}
          />
        ) : (
          <span className="properties-muted">{formatScalar(row.value)}</span>
        )}
        <button
          type="button"
          className="properties-remove"
          aria-label={`Remove ${row.key}`}
          title={`Remove ${row.key}`}
          onClick={() => void write(() => api.remove(documentId, row.key))}
        >
          ×
        </button>
        {error ? (
          <p className="properties-error" role="alert">
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

function AddPropertyRow({
  kernel,
  api,
  documentId,
  existingKeys,
  keyInputRef,
}: {
  readonly kernel: Kernel;
  readonly api: PropertiesApi;
  readonly documentId: string;
  readonly existingKeys: readonly string[];
  readonly keyInputRef: RefObject<HTMLInputElement>;
}): ReactNode {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = key.trim();
    const invalid = keyProblem(trimmed, existingKeys);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await api.set(documentId, trimmed, parseScalarInput(value));
      setKey("");
      setValue("");
    } catch (failure) {
      kernel.log.error(`could not add fm.${trimmed}`, failure);
      setProblem(describeWriteFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="properties-add"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="properties-add-field">
        <span className="properties-add-label">New property</span>
        <input
          ref={keyInputRef}
          className="properties-input"
          type="text"
          value={key}
          placeholder="name"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setKey(event.target.value);
            setProblem(undefined);
          }}
        />
      </label>
      <label className="properties-add-field">
        <span className="properties-add-label">Value</span>
        <input
          className="properties-input"
          type="text"
          value={value}
          placeholder="empty"
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" className="properties-button" disabled={busy || key.trim().length === 0}>
        Add
      </button>
      {problem ? (
        <p className="properties-error" role="alert">
          {problem}
        </p>
      ) : null}
      <p className="properties-hint">
        Types follow the document: <code>3</code> is a number, <code>true</code> a boolean,{" "}
        <code>&quot;3&quot;</code> a string, empty is null.
      </p>
    </form>
  );
}

/**
 * The splice helpers are the one part of `kernel.documents` that is still unimplemented
 * in this build (they need the core's splice ABI over Wasm). Saying so beats "undefined
 * is not a function", and the panel keeps working for reading either way.
 */
function describeWriteFailure(failure: unknown): string {
  if (failure instanceof NotImplementedError) {
    return "Frontmatter editing needs the kernel's splice helpers, which this build does not implement yet.";
  }
  if (failure instanceof Error) return failure.message;
  return String(failure);
}

// ---------------------------------------------------------------------------
// the shipped editors
// ---------------------------------------------------------------------------

/**
 * Text, and the fallback for everything unclaimed. Commits on blur and on Enter rather
 * than per keystroke: each commit is a CRDT transaction, and one per character would
 * make the document's history unreadable and the splice churn pointless.
 */
function TextValueEditor(props: ShippedEditorProps): ReactNode {
  const { value, onChange } = props;
  const field = fieldOf(props);
  const [draft, setDraft] = useState(() => formatScalar(value));
  const committed = useRef(formatScalar(value));

  // A change arriving over sync wins over an untouched draft.
  useEffect(() => {
    const incoming = formatScalar(value);
    if (incoming !== committed.current) {
      committed.current = incoming;
      setDraft(incoming);
    }
  }, [value]);

  const commit = (): void => {
    if (draft === committed.current) return;
    committed.current = draft;
    void onChange(parseScalarInput(draft));
  };

  return (
    <input
      className="properties-input"
      type="text"
      value={draft}
      aria-label={field}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          setDraft(committed.current);
        }
      }}
    />
  );
}

function NumberValueEditor(props: ShippedEditorProps): ReactNode {
  const { value, onChange } = props;
  const field = fieldOf(props);
  const [draft, setDraft] = useState(() => formatScalar(value));
  const committed = useRef(formatScalar(value));

  useEffect(() => {
    const incoming = formatScalar(value);
    if (incoming !== committed.current) {
      committed.current = incoming;
      setDraft(incoming);
    }
  }, [value]);

  const commit = (): void => {
    if (draft === committed.current) return;
    committed.current = draft;
    // Still through `parseScalarInput`: an emptied number field is null, not `NaN`, and
    // text typed into it stays the user's text rather than becoming a broken number.
    void onChange(parseScalarInput(draft));
  };

  return (
    <input
      className="properties-input"
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={field}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function BooleanValueEditor(props: ShippedEditorProps): ReactNode {
  const { value, onChange } = props;
  const field = fieldOf(props);
  return (
    <label className="properties-checkbox">
      <input
        type="checkbox"
        checked={value === true}
        aria-label={field}
        onChange={(event) => void onChange(event.target.checked)}
      />
      <span>{value === true ? "true" : "false"}</span>
    </label>
  );
}

/**
 * The shipped date picker (SPEC §6.5: "typed key/value rows (date pickers etc.)").
 *
 * Two controls, because the model has two precisions and they are not interchangeable:
 * `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM:SS.sssZ` (SPEC §3.4). Clearing the time goes back
 * to the date-only shape rather than inventing midnight, because `eq` on a `fm` date is
 * precision-sensitive and a silent promotion to a datetime would quietly stop matching
 * every filter the user wrote.
 */
function DateValueEditor(props: ShippedEditorProps): ReactNode {
  const { value, onChange } = props;
  const field = fieldOf(props);
  const parts = splitDateValue(value);
  const unparseable = typeof value === "string" && value.length > 0 && parts.date === "";

  if (unparseable) {
    // Never overwrite text we could not read: show it, and let the user fix it.
    return (
      <span className="properties-unparseable">
        <input
          className="properties-input"
          type="text"
          value={value}
          aria-label={field}
          onChange={(event) => void onChange(event.target.value)}
        />
        <span className="properties-muted">not a date the workspace can sort</span>
      </span>
    );
  }

  return (
    <span className="properties-date">
      <input
        className="properties-input properties-input-date"
        type="date"
        value={parts.date}
        aria-label={`${field} date`}
        onChange={(event) => {
          const next = event.target.value;
          void onChange(next === "" ? null : joinDateValue(next, parts.time));
        }}
      />
      <input
        className="properties-input properties-input-time"
        type="time"
        value={parts.time ?? ""}
        aria-label={`${field} time`}
        disabled={parts.date === ""}
        onChange={(event) => {
          const time = event.target.value;
          void onChange(joinDateValue(parts.date, time === "" ? undefined : time));
        }}
      />
    </span>
  );
}

/**
 * A list, as chips plus one text field. The text field is the editable form (a YAML flow
 * sequence is what the document holds), and the chips are how you remove one item
 * without retyping the rest.
 */
function ListValueEditor(props: ShippedEditorProps): ReactNode {
  const { value, onChange } = props;
  const field = fieldOf(props);
  const items = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState(() => formatScalar(value));
  const committed = useRef(formatScalar(value));

  useEffect(() => {
    const incoming = formatScalar(value);
    if (incoming !== committed.current) {
      committed.current = incoming;
      setDraft(incoming);
    }
  }, [value]);

  const commit = (): void => {
    if (draft === committed.current) return;
    committed.current = draft;
    void onChange([...parseListInput(draft)]);
  };

  return (
    <span className="properties-list-editor">
      {items.length > 0 ? (
        <span className="properties-chips">
          {items.map((item, index) => (
            <span className="properties-chip" key={`${formatScalar(item)}-${index}`}>
              {formatScalar(item)}
              <button
                type="button"
                className="properties-chip-remove"
                aria-label={`Remove ${formatScalar(item)} from ${field}`}
                onClick={() => {
                  const next = items.filter((_, position) => position !== index);
                  committed.current = formatScalar(next);
                  setDraft(committed.current);
                  void onChange(next);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </span>
      ) : null}
      <input
        className="properties-input"
        type="text"
        value={draft}
        aria-label={`${field}, comma separated`}
        placeholder="comma, separated"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </span>
  );
}
