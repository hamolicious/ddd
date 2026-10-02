/**
 * `db-health` — Database health: admin checks on what the workspace stores.
 *
 * One settings section, for admins only (every endpoint it reads is admin-only):
 *
 * - **Orphan files**: stored files no note uses.
 * - **Duplicates**: files with the same name and contents, and notes with the same title
 *   and text, under different ids — each copy with how many notes point at it.
 *
 * The server finds them (`routes/attachments.rs`, `routes/documents.rs`); this plugin only
 * shows them. Nothing is deleted automatically: a file goes after a confirmation, a note
 * goes to the Trash. "Check database health" in the palette opens the section.
 */

import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
import { addCommand } from "plugin:commands";
import { confirm } from "plugin:context-menu";
import { addSection, open } from "plugin:settings";

import { createHealthClient } from "./api.js";
import { HealthSection } from "./Health.js";

const SECTION = "db-health";

export default function activate(kernel: Kernel): void {
  if (!kernel.session.isAdmin()) return;

  const client = createHealthClient((path, init) => kernel.session.fetch(path, init));
  const Section = (): ReactElement => <HealthSection client={client} confirm={confirm} />;

  addSection({
    id: SECTION,
    title: "Database health",
    description: "Files nothing uses, and duplicate files and notes. Nothing is deleted automatically.",
    // Beside the admin sections (900), after them.
    order: 905,
    component: Section,
  });

  addCommand({
    id: "db-health.open",
    title: "Check database health",
    category: "Admin",
    run: () => open(SECTION),
  });
}
