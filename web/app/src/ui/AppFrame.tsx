/**
 * The kernel's own chrome: a notice strip and the plugin mount point.
 *
 * Deliberately almost nothing. `shell-ui` owns the layout (SPEC §6.5) and can be
 * replaced; what cannot be replaceable is the frame that still renders when the
 * shell is missing, failed, or skipped — otherwise the notice telling you *why* the
 * app is blank has nowhere to appear.
 *
 * **The mount is inside an error boundary, and that is the whole point of the frame.**
 * `shell-ui` wraps each contributed *component* in `kernel.ui.boundary`, but that leaves
 * everything between them uncovered: the shell's own render, the mode tabs, and every
 * contributed `icon` (a `ReactNode`, which cannot be wrapped as a component). Without a
 * boundary here, one throw in any of those unmounts the React root — a white page with
 * no notice strip, no in-place chip, and not even the `?safe=1` links that get you out.
 * With it, the failure is contained to the mount and the recovery panel is still on
 * screen (SPEC §6.4).
 */

import { useEffect, useState, type ReactNode } from "react";

import type { Notice, SessionUser, SyncStatus } from "@kernel";
import { KernelOutlet, PluginErrorBoundary, type KernelHost } from "@kernel/runtime/index.js";

import { safeModeUrl } from "../boot/safe-mode.js";
import { ReauthOverlay } from "./ReauthOverlay.js";

export interface AppFrameProps {
  readonly host: KernelHost;
  /** Shell sessions carry a bearer token (SPEC §5.2); browsers use the cookie. */
  readonly bearer?: boolean;
  /** Re-authentication succeeded: resume syncing (and persist a new shell token). */
  readonly onSignedIn: (user: SessionUser, token?: string) => void;
}

export function AppFrame({ host, bearer, onSignedIn }: AppFrameProps): ReactNode {
  const [notices, setNotices] = useState<readonly Notice[]>(() => host.notices.list());
  const [mounted, setMounted] = useState<boolean>(() => host.mount.holder !== undefined);
  const [status, setStatus] = useState<SyncStatus>(() => host.sync.state.status);

  useEffect(() => host.notices.subscribe(setNotices), [host]);
  useEffect(
    () => host.mount.subscribe(() => setMounted(host.mount.holder !== undefined)),
    [host],
  );
  // The 4401 path (SPEC §5.3): the socket asks for re-authentication and the app
  // asks the user, over the top of a workspace that is still there.
  useEffect(() => host.sync.api().subscribe((state) => setStatus(state.status)), [host]);

  return (
    <div className="lm-frame">
      <NoticeStrip notices={notices} onDismiss={(id) => host.notices.dismiss(id)} />
      <div className="lm-outlet">
        {mounted ? (
          <PluginErrorBoundary
            pluginId={host.mount.holder ?? "unknown"}
            point="ui.mount"
            fallback={MountFailed}
            onError={(error, where) =>
              host.notices.notify({
                id: "kernel:mount-failed",
                level: "error",
                message: `The interface from "${where.pluginId}" failed to render.`,
                detail: error.message,
              })
            }
          >
            <KernelOutlet mount={host.mount} />
          </PluginErrorBoundary>
        ) : (
          <NoShell bootMode={host.info.bootMode} />
        )}
      </div>
      {status === "auth-required" ? (
        <ReauthOverlay
          user={host.session.user}
          {...(bearer !== undefined ? { bearer } : {})}
          onSignedIn={onSignedIn}
        />
      ) : null}
    </div>
  );
}

function NoticeStrip({
  notices,
  onDismiss,
}: {
  readonly notices: readonly Notice[];
  readonly onDismiss: (id: string) => void;
}): ReactNode {
  if (notices.length === 0) return null;
  return (
    <ul className="lm-notices" aria-live="polite">
      {notices.map((notice) => (
        <li key={notice.id} className={`lm-notice lm-notice-${notice.level}`}>
          <span className="lm-notice-message">{notice.message}</span>
          {notice.detail ? (
            <details className="lm-notice-detail">
              <summary>Details</summary>
              <pre>{notice.detail}</pre>
            </details>
          ) : null}
          {(notice.actions ?? []).map((action) => (
            <button key={action.label} type="button" onClick={() => action.run()}>
              {action.label}
            </button>
          ))}
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(notice.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The mounted UI threw while rendering.
 *
 * The in-place chip that `kernel.ui.boundary` uses is right for a panel inside a
 * working shell; here the whole interface is gone, so this says what happened and
 * offers the same two exits as {@link NoShell} — which the user can reach, because the
 * frame around this is still on screen.
 */
function MountFailed({
  error,
  pluginId,
}: {
  readonly error: Error;
  readonly pluginId: string;
}): ReactNode {
  return (
    <div className="lm-empty" role="alert">
      <h1>The interface failed to render</h1>
      <p>
        <code>{pluginId}</code> holds the UI mount and threw while rendering, so the app
        has no layout. Your documents are untouched — this is a display failure.
      </p>
      <pre className="lm-boot-error">{error.message}</pre>
      <p>
        <a href={safeModeUrl("base")}>Boot with base plugins only</a> ·{" "}
        <a href={safeModeUrl("bare")}>Open the built-in plugin manager</a>
      </p>
    </div>
  );
}

/**
 * What a user sees when no plugin took the mount. It is an error state, but a
 * recoverable one, so it says the two things that get you out: safe mode and the
 * plugin manager.
 */
function NoShell({ bootMode }: { readonly bootMode: string }): ReactNode {
  return (
    <div className="lm-empty" role="alert">
      <h1>No user interface is mounted</h1>
      <p>
        The kernel started and the workspace is synced, but no plugin claimed the UI
        mount — normally <code>shell-ui</code>. Boot mode: <code>{bootMode}</code>.
      </p>
      <p>
        <a href={safeModeUrl("base")}>Boot with base plugins only</a> ·{" "}
        <a href={safeModeUrl("bare")}>Open the built-in plugin manager</a>
      </p>
    </div>
  );
}
