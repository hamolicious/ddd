import type { SlashCommand } from "./api.js";

export function slashQuery(beforeCaret: string): string | undefined {
  return /(?:^|\s)\/([\p{L}\p{N}_-]{0,32})$/u.exec(beforeCaret)?.[1];
}

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
  return scored
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.command);
}
