/**
 * What the `/` menu shows for what was typed. Pure, so it is tested without an editor.
 */

import type { SlashCommand } from "./api.js";

/**
 * The query when the caret sits right after `/word`: the slash at the start of the line
 * or after a space (so `a/b` and URLs never open it), then letters, digits, `-` or `_`.
 * `undefined` when the menu should be closed.
 */
export function slashQuery(beforeCaret: string): string | undefined {
  return /(?:^|\s)\/([\p{L}\p{N}_-]{0,32})$/u.exec(beforeCaret)?.[1];
}

/**
 * Best first: title starts with it, then a keyword does, then either contains it. Within
 * a rank, `commands` keeps its order: the registry's, by each command's `order`.
 */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
  documentId: string,
  limit = 20,
): readonly SlashCommand[] {
  const needle = query.toLowerCase();
  const scored: { command: SlashCommand; rank: number }[] = [];
  for (const command of commands) {
    try {
      if (command.when && !command.when({ documentId })) continue;
    } catch {
      continue;
    }
    const title = command.title.toLowerCase();
    const keywords = (command.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const rank =
      needle === "" || title.startsWith(needle) || title.split(/\s+/).some((word) => word.startsWith(needle))
        ? 0
        : keywords.some((keyword) => keyword.startsWith(needle))
          ? 1
          : title.includes(needle) || keywords.some((keyword) => keyword.includes(needle))
            ? 2
            : -1;
    if (rank >= 0) scored.push({ command, rank });
  }
  // A stable sort: equal ranks stay in the order given.
  return scored
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.command);
}
