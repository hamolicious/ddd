import { createRegistry, s } from "@kernel";

import type { CustomLanguage, CustomUpload } from "./custom.js";
import type { LoadState, Span } from "./engine.js";

export interface SyntaxLanguage {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly wasmUrl: string;
  readonly highlightsUrl: string;
  readonly size?: number;
}

export interface SyntaxApi {
  languages(): readonly SyntaxLanguage[];
  resolve(infoString: string | undefined): SyntaxLanguage | undefined;
  isInstalled(id: string): boolean;
  install(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  state(id: string): LoadState | undefined;
  ensureLoaded(id: string, retry?: boolean): void;
  highlight(code: string, language: string): readonly Span[] | undefined;
  custom(): readonly CustomLanguage[];
  addCustom(upload: CustomUpload): Promise<void>;
  removeCustom(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  revision(): number;
}

export const languageRegistry = createRegistry<SyntaxLanguage>({
  key: (language) => language.id,
  shape: s.object({
    id: s.string(),
    name: s.string(),
    aliases: s.optional(s.array(s.string())),
    wasmUrl: s.string(),
    highlightsUrl: s.string(),
    size: s.optional(s.number()),
  }),
});
