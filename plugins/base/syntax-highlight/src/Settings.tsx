/**
 * Settings → Code languages: every language on offer, installed or not, with its
 * download size. Installing one here is the same as the button on a code block.
 *
 * Below the list, a form for bringing your own: any tree-sitter grammar compiled to
 * `.wasm`, and a `highlights.scm` query for it.
 */

import { useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import { aliasesFrom } from "./custom.js";
import type { SyntaxApi } from "./api.js";

const base = import.meta.url;

/** `index.json`'s sizes for the built-in catalog; contributed languages carry their own. */
function useCatalogSizes(): Readonly<Record<string, number>> {
  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    let live = true;
    fetch(new URL("languages/index.json", base).href)
      .then((response) => (response.ok ? response.json() : { sizes: {} }))
      .then((index: { sizes?: Record<string, number> }) => {
        if (live) setSizes(index.sizes ?? {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return sizes;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SyntaxSettings({ api }: { readonly api: SyntaxApi }): ReactNode {
  useSyncExternalStore(api.subscribe, api.revision);
  const sizes = useCatalogSizes();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const run = (id: string, action: () => Promise<void>, verb: string): void => {
    setProblem(undefined);
    setBusy(id);
    action()
      .catch((error: unknown) => {
        setProblem(`Could not ${verb} ${id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setBusy(undefined));
  };

  const languages = [...api.languages()].sort((a, b) => a.name.localeCompare(b.name));
  const customIds = new Set(api.custom().map((language) => language.id));

  return (
    <div className="lmsh-settings">
      <p className="lmsh-note">
        Fenced code in an installed language is highlighted, in read mode and while editing.
        A language is downloaded to each device the first time it is needed, and works offline after that.
      </p>
      <ul className="lmsh-list">
        {languages.map((language) => {
          const installed = api.isInstalled(language.id);
          const own = customIds.has(language.id);
          const state = api.state(language.id);
          const size = formatSize(language.size ?? sizes[language.id]);
          return (
            <li key={language.id} className="lmsh-row">
              <span className="lmsh-name">{language.name}</span>
              <span className="lmsh-meta">
                {[
                  own ? "yours" : "",
                  language.aliases?.length ? language.aliases.join(", ") : "",
                  size,
                  installed && state === "loading" ? "downloading…" : "",
                  installed && state === "failed" ? "did not load" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {own ? (
                <button
                  type="button"
                  className="lmsh-action"
                  disabled={busy === language.id}
                  onClick={() => run(language.id, () => api.removeCustom(language.id), "delete")}
                >
                  Delete
                </button>
              ) : null}
              <button
                type="button"
                className="lmsh-action"
                hidden={own && installed}
                disabled={busy === language.id}
                onClick={() =>
                  installed
                    ? run(language.id, () => api.remove(language.id), "remove")
                    : run(language.id, () => api.install(language.id), "install")
                }
              >
                {installed ? "Remove" : "Install"}
              </button>
            </li>
          );
        })}
      </ul>
      {problem ? (
        <p className="lmsh-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <AddLanguage api={api} />
    </div>
  );
}

/** Upload a grammar of your own. Checked here first; saved only if it loads. */
function AddLanguage({ api }: { readonly api: SyntaxApi }): ReactNode {
  const id = useId();
  const [name, setName] = useState("");
  const [languageId, setLanguageId] = useState("");
  const [aliases, setAliases] = useState("");
  const [grammar, setGrammar] = useState<File | undefined>(undefined);
  const [highlights, setHighlights] = useState<File | undefined>(undefined);
  const [state, setState] = useState<{ readonly busy?: boolean; readonly problem?: string; readonly done?: string }>({});
  // The file inputs are reset by remounting them once a language is added.
  const [round, setRound] = useState(0);

  const suggestedId = name.trim().toLowerCase().replace(/[^a-z0-9_+#-]+/g, "-").replace(/^[^a-z]+|-+$/g, "");
  const effectiveId = languageId.trim().toLowerCase() || suggestedId;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!grammar || !highlights) {
      setState({ problem: "Choose both files: the grammar (.wasm) and its highlights query (.scm)." });
      return;
    }
    setState({ busy: true });
    api
      .addCustom({ id: effectiveId, name, aliases: aliasesFrom(aliases), grammar, highlights })
      .then(() => {
        setState({ done: `${name.trim()} is installed. Write \`\`\`${effectiveId} in a note to use it.` });
        setName("");
        setLanguageId("");
        setAliases("");
        setGrammar(undefined);
        setHighlights(undefined);
        setRound((value) => value + 1);
      })
      .catch((error: unknown) => setState({ problem: error instanceof Error ? error.message : String(error) }));
  };

  return (
    <form className="lmsh-add" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="lmsh-add-title">
        Add your own
      </h3>
      <p className="lmsh-note">
        Any tree-sitter grammar built to WebAssembly (<code>tree-sitter build --wasm</code>), with the{" "}
        <code>highlights.scm</code> query that colours it. They are checked here before they are saved,
        and kept as attachments, so your other devices get them too.
      </p>
      <label className="lmsh-field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Zig" required />
      </label>
      <label className="lmsh-field">
        <span>Id</span>
        <input
          value={languageId}
          onChange={(event) => setLanguageId(event.target.value)}
          placeholder={suggestedId || "zig"}
          spellCheck={false}
        />
      </label>
      <label className="lmsh-field">
        <span>Other names</span>
        <input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="zg, ziglang" spellCheck={false} />
      </label>
      <label className="lmsh-field">
        <span>Grammar (.wasm)</span>
        <input
          key={`g${round}`}
          type="file"
          accept=".wasm,application/wasm"
          onChange={(event) => setGrammar(event.target.files?.[0])}
        />
      </label>
      <label className="lmsh-field">
        <span>Highlights (.scm)</span>
        <input key={`h${round}`} type="file" accept=".scm,text/plain" onChange={(event) => setHighlights(event.target.files?.[0])} />
      </label>
      <div>
        <button type="submit" className="lmsh-action" disabled={state.busy}>
          {state.busy ? "Checking…" : "Add language"}
        </button>
      </div>
      {state.problem ? (
        <p className="lmsh-problem" role="alert">
          {state.problem}
        </p>
      ) : null}
      {state.done ? (
        <p className="lmsh-note" role="status">
          {state.done}
        </p>
      ) : null}
    </form>
  );
}
