/**
 * `calendar` — a saved search's notes on a month grid, for the saved searches whose `type`
 * is `calendar`. "New calendar" (a command, and in the folder tree) makes one for the notes
 * inside it.
 *
 * Which field dates a note is its setting, in the note's `%%% calendar` section: a calendar of
 * `created_at`, of `fm.date`, of `fm.due` — with an optional end field for notes that run
 * over several days (`layout.ts`). The results come from `search` itself (`plugin:search`'s
 * `useResults`, narrowed to the weeks on screen), so the filter, text and machine-document
 * rules are the same as every other view's. Each note wears the colour and icon `folders`
 * gives it (`plugin:folders` `look`, an optional dependency), as it does in the tree and in links.
 *
 * No exports: it only contributes a document mode, a command and menu actions.
 */

import type { Kernel } from "@kernel";
import { addCommand } from "plugin:commands";
import { addAction } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import { addMode } from "plugin:document-surface";
import { SavedSearch, encode, useResults } from "plugin:search";

import type { Looks } from "../../_shared/note-look.js";
import { offerSavedView } from "../../_shared/saved-view-mode.js";

import { createCalendar } from "./Calendar.js";
import { CalendarSettings } from "./Settings.js";

type RouterModule = typeof import("plugin:router");
type FoldersModule = typeof import("plugin:folders");

let router: RouterModule | undefined;
// Colours and icons, as the folder tree dresses each note; plain chips without `folders`.
let folders: FoldersModule | undefined;

export default function activate(kernel: Kernel): void {
  void kernel.plugins
    .optional<RouterModule>("router")
    .then((module) => {
      router = module;
    })
    .catch((cause: unknown) => kernel.log.warn("router unavailable; a new calendar is not opened", cause));
  void kernel.plugins
    .optional<FoldersModule>("folders")
    .then((module) => {
      folders = module;
    })
    .catch((cause: unknown) => kernel.log.warn("folders unavailable; notes show without their look", cause));

  const looks = (): Looks | undefined => folders;
  const Calendar = createCalendar(() => ({ useResults }), looks);
  offerSavedView(
    kernel,
    {
      type: "calendar",
      label: "Calendar",
      noun: "calendar",
      commandIcon: "calendar",
      icon: (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      ),
      order: 10,
      render: (props) => <Calendar {...props} />,
      settings: (props) => <CalendarSettings {...props} />,
      // An empty month is still a month.
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
  folders = undefined;
}
