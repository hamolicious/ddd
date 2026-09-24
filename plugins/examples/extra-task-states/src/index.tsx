/**
 * `extra-task-states` — three more task markers, contributed the way SPEC §6.6 says
 * a plugin should.
 *
 * It exists for two reasons beyond being a small example:
 *
 * 1. It is the **only** way to test the registry-driven half of the task contract.
 *    `[ ]` and `[x]` are `markdown`'s own default contributions, so a test that only
 *    clicks those cannot tell "the registry decides" apart from "GFM decides" — and
 *    GFM recognises exactly those two markers and no others. `[/]` is recognised by
 *    nothing but this contribution.
 * 2. It demonstrates the documented consequence (SPEC §6.6, risk 7): a client without
 *    this plugin renders `- [/] thing` as the literal text `[/] thing`, and counts one
 *    fewer task. Installing it changes the *meaning* of text that was already there —
 *    which is the point of a marker registry, and the reason the spec calls it out.
 *
 * No `editor.extension` companion: these markers need no new *syntax*, only new
 * semantics for a character inside brackets that markdown already tokenizes.
 */

import type { Kernel } from "@kernel";

/** Declared locally — `_shared/points.ts` belongs to the base distribution, not to `@kernel`. */
const TASK_STATE_POINT = "markdown.taskState";

interface TaskState {
  readonly marker: string;
  readonly label: string;
  readonly icon: unknown;
  readonly order?: number;
  readonly done?: boolean;
}

/**
 * `done` is the interesting field. "In progress" and "Question" are **not** done, so
 * they count as open work; "Dropped" is `done: true` — not because it was finished,
 * but because `done` answers "should this still be chased", which is the question
 * every task count is really asking.
 */
const STATES: readonly TaskState[] = [
  { marker: "/", label: "In progress", icon: "◐", order: 15 },
  { marker: "-", label: "Dropped", icon: "⊘", order: 30, done: true },
  { marker: "?", label: "Question", icon: "?", order: 40 },
];

export default function activate(kernel: Kernel): { readonly markers: readonly string[] } {
  for (const state of STATES) kernel.extensions.contribute(TASK_STATE_POINT, state);
  kernel.log.info(`extra-task-states: added ${STATES.length} markers`);
  return { markers: STATES.map((state) => state.marker) };
}
