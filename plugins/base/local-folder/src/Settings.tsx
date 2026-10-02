import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Controller, View } from "./index.js";

const BUTTON =
  "localfolder:tap-h localfolder:cursor-pointer localfolder:rounded localfolder:border localfolder:border-border-strong localfolder:bg-bg-raised localfolder:px-2 localfolder:font-sans localfolder:text-text";
const MUTED = "localfolder:m-0 localfolder:text-sm localfolder:text-text-muted";

function describe(view: View): string {
  switch (view.phase) {
    case "unavailable":
      return "Not available here. Use the desktop or Android app, or a Chromium-based browser.";
    case "off":
      return "Off. Choose a folder to keep your notes there as Markdown files.";
    case "needs-permission":
      return "The browser needs your permission again.";
    case "other-tab":
      return "Kept up to date by another tab of this app.";
    case "syncing":
      return "Syncing…";
    case "idle":
      return view.lastSync !== undefined ? `Up to date (${new Date(view.lastSync).toLocaleTimeString()}).` : "Up to date.";
    case "held":
      return `${view.held ?? 0} files are missing from the folder. Nothing was deleted yet: see the notice.`;
    case "error":
      return view.error ?? "Something went wrong.";
  }
}

export function LocalFolderSettings({ controller }: { readonly controller: Controller }): ReactElement {
  const [view, setView] = useState(controller.view);
  useEffect(() => controller.subscribe(setView), [controller]);
  const connected = view.phase !== "off" && view.phase !== "unavailable";

  return (
    <div className="localfolder:flex localfolder:flex-col localfolder:gap-3 localfolder:font-sans localfolder:text-text">
      {view.label !== undefined && connected ? (
        <p className="localfolder:m-0 localfolder:break-all">
          <span className="localfolder:text-text-muted">Folder: </span>
          {view.label}
        </p>
      ) : null}
      <p className={view.phase === "error" ? "localfolder:m-0 localfolder:text-sm localfolder:text-danger" : MUTED} role="status">
        {describe(view)}
      </p>
      {view.phase !== "unavailable" ? (
        <div className="localfolder:flex localfolder:flex-wrap localfolder:gap-2">
          <button type="button" className={BUTTON} onClick={() => void controller.choose()}>
            {connected ? "Change folder" : "Choose folder"}
          </button>
          {view.phase === "needs-permission" ? (
            <button type="button" className={BUTTON} onClick={() => void controller.reconnect()}>
              Allow access
            </button>
          ) : null}
          {view.phase === "idle" || view.phase === "error" ? (
            <button type="button" className={BUTTON} onClick={() => controller.syncNow()}>
              Sync now
            </button>
          ) : null}
          {connected ? (
            <button type="button" className={BUTTON} onClick={() => void controller.disconnect()}>
              Stop using this folder
            </button>
          ) : null}
        </div>
      ) : null}
      {view.conflicts.length > 0 ? (
        <div className="localfolder:flex localfolder:flex-col localfolder:gap-1">
          <p className={MUTED}>Edited in both places at once; the disk's version was saved as:</p>
          <ul className="localfolder:m-0 localfolder:pl-5 localfolder:text-sm">
            {view.conflicts.map((path) => (
              <li key={path} className="localfolder:break-all">
                {path}
              </li>
            ))}
          </ul>
          <button type="button" className={BUTTON} onClick={() => controller.clearConflicts()}>
            Dismiss
          </button>
        </div>
      ) : null}
      {connected ? (
        <p className={MUTED}>
          Folders become directories and each note a <code>.md</code> file. Files stay in the folder when you stop.
        </p>
      ) : null}
    </div>
  );
}
