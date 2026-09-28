/**
 * The `markdown.codeBlock` renderer: fenced code, coloured by its language's grammar.
 *
 * It draws plain text first and colours it once the grammar is loaded, so a block is
 * never blank while a grammar downloads. A language in the catalog that the user has
 * not installed gets a small "Highlight as …" button; one nobody knows stays plain.
 */

import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import type { MarkdownCodeBlockProps } from "@protocols/lm/markdown.codeBlock";

import type { Span } from "./engine.js";
import type { SyntaxApi } from "./index.js";

export function segments(code: string, spans: readonly Span[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.from > at) out.push(<Fragment key={`t${at}`}>{code.slice(at, span.from)}</Fragment>);
    out.push(
      <span key={`s${span.from}`} className={span.className}>
        {code.slice(span.from, span.to)}
      </span>,
    );
    at = span.to;
  }
  if (at < code.length) out.push(<Fragment key={`t${at}`}>{code.slice(at)}</Fragment>);
  return out;
}

export function codeBlockFor(api: SyntaxApi): (props: MarkdownCodeBlockProps) => ReactNode {
  return function CodeBlock({ code, language: infoString }: MarkdownCodeBlockProps): ReactNode {
    useSyncExternalStore(api.subscribe, api.revision);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const language = api.resolve(infoString);
    const installed = language ? api.isInstalled(language.id) : false;
    const wanted = language && installed ? language.id : undefined;
    useEffect(() => {
      if (wanted) api.ensureLoaded(wanted);
    }, [wanted]);
    const spans = language && installed ? api.highlight(code, language.id) : undefined;

    const install = (): void => {
      if (!language) return;
      setProblem(undefined);
      api.install(language.id).catch((error: unknown) => {
        setProblem(`Could not install ${language.name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    const failed = language && installed && api.state(language.id) === "failed";

    return (
      <div className="lmsh-block">
        <pre className="md-code lmsh-pre">
          <code className={infoString ? `language-${infoString}` : undefined}>
            {spans ? segments(code, spans) : code}
          </code>
        </pre>
        {language && !installed ? (
          <button type="button" className="lmsh-install" onClick={install} title={`Install ${language.name} highlighting`}>
            Highlight as {language.name}
          </button>
        ) : null}
        {failed ? (
          <button type="button" className="lmsh-install" onClick={() => api.ensureLoaded(language.id, true)}>
            {language.name} did not load — retry
          </button>
        ) : null}
        {problem ? (
          <p className="lmsh-problem" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    );
  };
}
