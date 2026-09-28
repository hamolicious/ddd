/**
 * The change list and the apply plan, as rows (PLUGIN-PROTOCOLS §6c "the side panel lists
 * the consequences before anything runs"). Pure: from the resolver's `ApplyPlan` and the
 * two overrides, to what the inspector prints and what Apply's confirm names.
 */

import type { ApplyPlan, WiringOverrides } from "@kernel";

import { nodeOfPort } from "./model.js";

export type Op = "add" | "del" | "mod";

export interface ChangeRow {
  readonly op: Op;
  readonly text: string;
  /** A plugin to select when the row is chosen… */
  readonly node?: string;
  /** …or a consumed port. */
  readonly port?: string;
}

export interface ChangeSummary {
  readonly rows: readonly ChangeRow[];
  /** What else stops or starts because a service they need comes or goes. */
  readonly alsoStops: readonly string[];
  readonly alsoStarts: readonly string[];
  /** The apply steps, in order. */
  readonly steps: readonly string[];
  readonly cold: readonly string[];
  readonly addedErrors: number;
  /** The draft stops the running editor itself: Apply asks first (§7). */
  readonly stopsEditor: boolean;
}

export function summarize(plan: ApplyPlan, base: WiringOverrides, draft: WiringOverrides, editorId: string): ChangeSummary {
  const rows: ChangeRow[] = [];
  for (const change of plan.changes) {
    switch (change.kind) {
      case "unplug":
        rows.push({ op: "del", text: `unplug ${change.plugin}`, node: change.plugin });
        break;
      case "plug":
        rows.push({ op: "add", text: `plug in ${change.plugin}`, node: change.plugin });
        break;
      case "bind":
        rows.push({
          op: "mod",
          text: `${change.port}: ${change.from ? nodeOfPort(change.from) : "nothing"} → ${change.to ? nodeOfPort(change.to) : "nothing"}`,
          port: change.port,
        });
        break;
      case "seats": {
        const seats = change.seats.map((seat, i) => `${i + 1} ${nodeOfPort(seat)}${change.added.includes(seat) ? " (new)" : ""}`).join(", ");
        const removed = change.removed.length ? `; removed ${change.removed.map(nodeOfPort).join(", ")}` : "";
        rows.push({ op: "mod", text: `${change.port} seats: ${seats || "empty"}${removed}`, port: change.port });
        break;
      }
      case "listen":
        for (const from of change.added) rows.push({ op: "add", text: `${from} → ${change.port}`, port: change.port });
        for (const from of change.removed) rows.push({ op: "del", text: `${from} → ${change.port}`, port: change.port });
        break;
    }
  }
  // Pins and cuts that the plan does not spell as a change (a pin to what was automatic
  // anyway, a cut of an inactive wire) still show as edits, so nothing is silent.
  for (const port of Object.keys(draft.bind)) {
    if (base.bind[port] === draft.bind[port] || rows.some((row) => row.port === port)) continue;
    const to = draft.bind[port];
    rows.push({ op: "mod", text: `${port}: ${to === null ? "unbound" : `pinned to ${nodeOfPort(to ?? "")}`}`, port });
  }
  for (const wire of draft.cut) if (!base.cut.includes(wire) && !rows.some((row) => row.text.includes(wire))) rows.push({ op: "del", text: `cut ${wire}` });
  for (const wire of draft.add) if (!base.add.includes(wire) && !rows.some((row) => row.text.includes(wire))) rows.push({ op: "add", text: `add ${wire}` });

  const steps: string[] = [];
  if (plan.cold.length > 0) {
    steps.push(`reload · ${plan.cold.join(", ")}`);
  } else {
    if (plan.stop.length > 0) steps.push(`stop · ${plan.stop.join(", ")}`);
    if (plan.restart.length > 0) steps.push(`restart · ${plan.restart.join(", ")}`);
    if (plan.hosts.length > 0) steps.push(`update · ${plan.hosts.join(", ")}`);
    if (plan.start.length > 0) steps.push(`start · ${plan.start.join(", ")}`);
  }
  return {
    rows,
    alsoStops: plan.alsoStops,
    alsoStarts: plan.alsoStarts,
    steps,
    cold: plan.cold,
    addedErrors: plan.addedErrors,
    stopsEditor: plan.stop.includes(editorId) || plan.alsoStops.includes(editorId) || plan.cold.includes(editorId),
  };
}

/** The plugins the plan touches, for the "what else stops" line of an unplug. */
export function alsoStops(plan: ApplyPlan | undefined, plugin: string): readonly string[] {
  if (!plan) return [];
  return plan.alsoStops.filter((id) => id !== plugin);
}
