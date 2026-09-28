/** Import the Markdown documents in an Obsidian vault ZIP through public kernel APIs only. */

import type { Kernel } from "@kernel";
import type { Command } from "@protocols/lm/commands.command";
import type { NavbarItem } from "@protocols/lm/navbar.item";

import { importVault } from "./import.js";
import { readVaultArchive } from "./zip.js";

const NOTICE_ID = "obsidian-importer.status";

export default function activate(kernel: Kernel): void {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const picked = await kernel.capabilities.filesystem.pick({
        accept: [".zip", "application/zip"],
        multiple: false,
      });
      const file = picked[0];
      if (!file) return;
      kernel.ui.notify({ id: NOTICE_ID, level: "info", message: `Reading ${file.name}…` });
      const archiveName = vaultName(file.name);
      const archive = await readVaultArchive(await file.bytes(), archiveName);
      if (archive.notes.length === 0 && archive.attachments.length === 0) {
        throw new Error("the ZIP contains no importable notes or attachments");
      }
      const result = await importVault(kernel, archiveName, archive, (finished, total) => {
        kernel.ui.notify({
          id: NOTICE_ID,
          level: "info",
          message: `Importing Obsidian vault… ${String(finished)} of ${String(total)}`,
          progress: { value: total === 0 ? 1 : finished / total },
        });
      });
      const details = [
        result.alreadyImported > 0 ? `${String(result.alreadyImported)} already imported` : "",
        result.attachmentsImported > 0 ? `${String(result.attachmentsImported)} attachments imported` : "",
        result.attachmentsAlreadyImported > 0
          ? `${String(result.attachmentsAlreadyImported)} attachments already imported`
          : "",
        archive.skippedFiles > 0 ? `${String(archive.skippedFiles)} configuration files skipped` : "",
        result.resolvedWikilinks > 0 ? `${String(result.resolvedWikilinks)} wikilinks resolved` : "",
        result.unresolvedWikilinks > 0 ? `${String(result.unresolvedWikilinks)} wikilinks unresolved` : "",
        result.failed.length > 0 ? `${String(result.failed.length)} failed` : "",
      ].filter((part) => part !== "");
      kernel.ui.notify({
        id: NOTICE_ID,
        level: result.failed.length === 0 ? "info" : "warning",
        message: `Imported ${String(result.imported)} ${result.imported === 1 ? "note" : "notes"} and ${String(result.attachmentsImported)} ${result.attachmentsImported === 1 ? "attachment" : "attachments"}.`,
        detail: details.join(" · ") || undefined,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      kernel.log.error("Obsidian import failed", cause);
      kernel.ui.notify({ id: NOTICE_ID, level: "error", message: "Obsidian import failed", detail: message });
    } finally {
      running = false;
    }
  };

  kernel.ports.offer<Command>("command", {
    id: "obsidian-importer.import",
    title: "Import an Obsidian vault",
    category: "Import",
    run,
    when: () => !running && kernel.capabilities.has("filesystem"),
  });
  kernel.ports.offer<NavbarItem>("nav", {
    id: "obsidian-importer.import",
    label: "Import Obsidian vault",
    icon: "⇩",
    side: "end",
    order: 85,
    onSelect: () => void run(),
  });
}

function vaultName(filename: string): string {
  return filename.replace(/\.zip$/i, "") || "Obsidian vault";
}
