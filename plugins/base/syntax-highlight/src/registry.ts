/** Which language an info string means: by id, then by alias, case-insensitively. */

import type { SyntaxLanguage } from "../../_shared/points.js";

export interface LanguageIndex {
  resolve(infoString: string | undefined): SyntaxLanguage | undefined;
  readonly languages: readonly SyntaxLanguage[];
}

/** The first contribution of an id or an alias wins, as with every keyed point. */
export function indexLanguages(languages: readonly SyntaxLanguage[]): LanguageIndex {
  const byName = new Map<string, SyntaxLanguage>();
  for (const language of languages) {
    const id = language.id.toLowerCase();
    if (!byName.has(id)) byName.set(id, language);
  }
  for (const language of languages) {
    for (const alias of language.aliases ?? []) {
      const name = alias.toLowerCase();
      if (!byName.has(name)) byName.set(name, language);
    }
  }
  return {
    languages,
    resolve: (infoString) => {
      const name = infoString?.trim().split(/\s+/, 1)[0]?.toLowerCase();
      return name ? byName.get(name) : undefined;
    },
  };
}
