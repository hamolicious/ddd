/**
 * `timeline` — a saved search's notes along a time axis, for the saved searches whose
 * `type` is `timeline`. "New timeline" (a command, and in the folder tree) makes one for the
 * notes inside it.
 *
 * Which fields place a note are its settings, in the note's `%%% timeline` section: when it starts
 * (`created_at`, `fm.date`, …), optionally when it ends — a bar rather than a point — and
 * optionally a field to split the notes into lanes (`fm.status`, `fm.project`), plus the
 * scale (`layout.ts`). The results come from `search` (`plugin:search`'s `useResults`, narrowed
 * to the window on screen), so every rule of the search applies as it does in the table.
 *
 * No exports: it only contributes a document mode, a command and menu actions.
 */

import type { Kernel } from "@kernel";
import { addCommand } from "plugin:commands";
import { addAction } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import { SavedSearch, encode, useResults } from "plugin:search";

import { offerSavedView } from "../../_shared/saved-view-mode.js";

import { TimelineSettings } from "./Settings.js";
import { createTimeline } from "./Timeline.js";

type RouterModule = typeof import("plugin:router");

let router: RouterModule | undefined;

export default function activate(kernel: Kernel): void {
  void kernel.plugins
    .optional<RouterModule>("router")
    .then((module) => {
      router = module;
    })
    .catch((cause: unknown) => kernel.log.warn("router unavailable; a new timeline is not opened", cause));

  const Timeline = createTimeline(() => ({ useResults }));
  offerSavedView(
    kernel,
    {
      type: "timeline",
      label: "Timeline",
      noun: "timeline",
      commandIcon: "timeline",
      icon: (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h18M7 8v8M12 5v6M17 13v6" />
        </svg>
      ),
      order: 25,
      render: (props) => <Timeline {...props} />,
      settings: (props) => <TimelineSettings {...props} />,
      // An empty stretch of time is still a timeline, with its own "nothing here" line.
      showsEmpty: true,
    },
    {
      addMode,
      // `SavedViewCommand.run` returns `unknown`; a command's returns `void | Promise<void>`.
      addCommand: (command) =>
        addCommand({
          ...command,
          run: async () => {
            await command.run();
          },
        }),
      addAction,
      notifyCreated,
      search: () => ({ SavedSearch, encode }),
      navigate: (path) => router?.navigate(path),
    },
  );
}

export function deactivate(): void {
  router = undefined;
}
