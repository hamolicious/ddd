/**
 * Languages the user brought themselves: a tree-sitter grammar (`.wasm`) and its
 * `highlights.scm`, uploaded from Settings → Code languages.
 *
 * Both files are ordinary attachments, and the list of them is a per-user setting, one
 * JSON string per language. That makes a custom language behave like everything else a
 * user owns: it syncs to their other devices, and because the setting's text holds the
 * `attachment://` references, the server never reports the files as orphans.
 *
 * Nothing is saved until the grammar has loaded and its query compiled in this browser,
 * in the same web-tree-sitter that will run it — a grammar built for another ABI, or a
 * query naming nodes the grammar lacks, is refused with tree-sitter's own message.
 */

import type { Kernel, SettingsValue } from "@kernel";

export const CUSTOM_KEY = "custom";
const REFERENCE = /^attachment:\/\/([0-9A-Za-z]{26})$/;

export interface CustomLanguage {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /** `attachment://<ulid>` of the grammar. */
  readonly wasm: string;
  /** `attachment://<ulid>` of the highlights query. */
  readonly highlights: string;
  /** Bytes of both, as uploaded. */
  readonly size: number;
}

export interface CustomUpload {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly grammar: File;
  readonly highlights: File;
}

/** Lowercase letters, digits and `_ + # -`, starting with a letter: an info string. */
export const LANGUAGE_ID = /^[a-z][a-z0-9_+#-]{0,31}$/;

export function parseCustom(value: SettingsValue | undefined): CustomLanguage[] {
  if (!Array.isArray(value)) return [];
  const out: CustomLanguage[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    try {
      const raw = JSON.parse(entry) as Partial<CustomLanguage>;
      if (
        typeof raw.id === "string" &&
        LANGUAGE_ID.test(raw.id) &&
        typeof raw.name === "string" &&
        typeof raw.wasm === "string" &&
        REFERENCE.test(raw.wasm) &&
        typeof raw.highlights === "string" &&
        REFERENCE.test(raw.highlights)
      ) {
        out.push({
          id: raw.id,
          name: raw.name,
          aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias) => typeof alias === "string") : [],
          wasm: raw.wasm,
          highlights: raw.highlights,
          size: typeof raw.size === "number" ? raw.size : 0,
        });
      }
    } catch {
      // A hand-edited line that is not ours any more: skip it, keep the rest.
    }
  }
  return out;
}

/** The attachment id inside an `attachment://` reference, if it is one. */
export function attachmentId(url: string): string | undefined {
  return REFERENCE.exec(url)?.[1];
}

/** Normalise what was typed in the form: ids and aliases lowercase, no blanks, no repeats. */
export function aliasesFrom(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((alias) => alias.trim().toLowerCase()).filter(Boolean))];
}

export interface Custom {
  list(): readonly CustomLanguage[];
  /** Check, upload, then record. Rejects with a message fit to show. */
  add(upload: CustomUpload, check: (grammar: Uint8Array, highlights: string) => Promise<void>): Promise<CustomLanguage>;
  /** Forget it, and delete its files where this user may. */
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Bytes of an attachment, through the session (cookie or bearer). */
  fetchBytes(reference: string): Promise<Uint8Array>;
}

export function createCustom(kernel: Kernel): Custom {
  try {
    kernel.settings.defineSchema({
      [CUSTOM_KEY]: {
        type: "list",
        label: "Your own code languages",
        description: "Grammars you uploaded. Settings → Code languages adds and deletes them.",
        default: [],
      },
    });
  } catch (error) {
    kernel.log.warn("the custom-languages setting is unavailable", error);
  }

  const list = (): CustomLanguage[] => {
    try {
      return parseCustom(kernel.settings.get(CUSTOM_KEY));
    } catch {
      return [];
    }
  };
  const write = (languages: readonly CustomLanguage[]): Promise<void> =>
    kernel.settings.set(
      CUSTOM_KEY,
      languages.map((language) => JSON.stringify(language)),
    );

  const upload = async (file: File): Promise<string> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await kernel.session.fetch("/attachments", { method: "POST", body: form });
    if (!response.ok) throw new Error(`${file.name} was not uploaded (${response.status})`);
    const body = (await response.json()) as { reference?: string };
    if (!body.reference || !REFERENCE.test(body.reference)) throw new Error(`${file.name}: the server gave no reference`);
    return body.reference;
  };

  return {
    list,

    async add(input, check) {
      const grammar = new Uint8Array(await input.grammar.arrayBuffer());
      const highlights = await input.highlights.text();
      await check(grammar, highlights);
      const [wasm, query] = await Promise.all([upload(input.grammar), upload(input.highlights)]);
      const language: CustomLanguage = {
        id: input.id,
        name: input.name,
        aliases: input.aliases,
        wasm,
        highlights: query,
        size: input.grammar.size + input.highlights.size,
      };
      await write([...list().filter((other) => other.id !== language.id), language]);
      return language;
    },

    async remove(id) {
      const language = list().find((other) => other.id === id);
      if (!language) return;
      await write(list().filter((other) => other.id !== id));
      for (const reference of [language.wasm, language.highlights]) {
        const attachment = attachmentId(reference);
        if (!attachment) continue;
        // Best effort: the language is gone either way, and a file left behind is only
        // an orphan an admin can see.
        await kernel.session.fetch(`/attachments/${attachment}`, { method: "DELETE" }).catch(() => undefined);
      }
    },

    subscribe(listener) {
      try {
        return kernel.settings.subscribe(() => listener());
      } catch {
        return () => {};
      }
    },

    async fetchBytes(reference) {
      const attachment = attachmentId(reference);
      if (!attachment) throw new Error(`${reference} is not an attachment`);
      const response = await kernel.session.fetch(`/attachments/${attachment}`);
      if (!response.ok) throw new Error(`${reference}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
