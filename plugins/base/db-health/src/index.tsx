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
