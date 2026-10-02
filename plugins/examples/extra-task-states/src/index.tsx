import type { Kernel } from "@kernel";
import { addTaskState, type MarkdownTaskState } from "plugin:markdown";

const STATES: readonly MarkdownTaskState[] = [
  { marker: "/", label: "In progress", icon: "◐", order: 15 },
  { marker: "-", label: "Dropped", icon: "⊘", order: 30, done: true },
  { marker: "?", label: "Question", icon: "?", order: 40 },
];

export const markers: readonly string[] = STATES.map((state) => state.marker);

export default function activate(kernel: Kernel): void {
  addTaskState(STATES);
  kernel.log.info(`extra-task-states: added ${STATES.length} markers`);
}
