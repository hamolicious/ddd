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
      showsEmpty: true,
    },
    {
      addMode,
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
