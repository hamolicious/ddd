/**
 * The kernel's own chrome: a notice strip and the plugin mount point.
 *
 * Deliberately almost nothing. `shell-ui` owns the layout (SPEC §6.5) and can be
 * replaced; what cannot be replaceable is the frame that still renders when the
 * shell is missing, failed, or skipped — otherwise the notice telling you *why* the
 * app is blank has nowhere to appear.
 *
 * **The strip is a fallback, not a second renderer.** A mounted shell renders the same
 * notices itself (`shell-ui`'s bell), and rendering both put every notice on screen
 * twice — the same message in the strip and behind the bell, dismissable in two places.
 * So the strip appears only when the mount is held by something that draws notices of its
 * own. `host.notices` stays the single source either way; only the kernel's *rendering* of
 * it is conditional.
 *
 * Three cases stand it back up, and the third is the one that is easy to miss:
 *
 * 1. Nothing holds the mount — no shell activated.
 * 2. The holder threw while rendering, so its bell is unreachable.
 * 3. **`?safe=bare`**, where the *kernel itself* holds the mount. `BareManager` is a
 *    plugin table and two links; it has no notice UI, and no plugin has loaded that could
 *    give it one. Keying the dedupe on "something holds the mount" silently blanked the
 *    strip on the one screen SPEC §6.1 calls the recovery path — the storage-not-persisted
 *    warning, the plugin-list failure and the update notice's only `Reload` button are all
 *    raised before the bare branch mounts, and every one of them had nowhere to appear.
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
  const [mountFailed, setMountFailed] = useState(false);
  const [status, setStatus] = useState<SyncStatus>(() => host.sync.state.status);

  useEffect(() => host.notices.subscribe(setNotices), [host]);
  useEffect(
    () =>
      host.mount.subscribe(() => {
        setMounted(host.mount.holder !== undefined);
        // A new holder gets a fresh chance to render its own notice UI.
        setMountFailed(false);
      }),
    [host],
  );
  // The 4401 path (SPEC §5.3): the socket asks for re-authentication and the app
  // asks the user, over the top of a workspace that is still there.
  useEffect(() => host.sync.api().subscribe((state) => setStatus(state.status)), [host]);
  // Once asked, the sign-in stays up until syncing resumes: a reconnect attempt passes
  // through `connecting`, and unmounting then wiped a half-typed password.
  const [signInNeeded, setSignInNeeded] = useState(false);
  useEffect(() => {
    if (status === "auth-required") setSignInNeeded(true);
    else if (status === "syncing" || status === "synced") setSignInNeeded(false);
  }, [status]);

  // `?safe=bare` mounts the kernel's own `BareManager`, which renders no notices and has
  // no plugin behind it that could — so the strip is the only place they can appear there.
  const bare = host.info.bootMode === "bare";
  /** Whoever holds the mount is drawing the notices itself, so the kernel stands down. */
  const holderDrawsNotices = mounted && !mountFailed && !bare;

  return (
    <div className="lm-frame">
      {holderDrawsNotices ? null : (
        <NoticeStrip notices={notices} onDismiss={(id) => host.notices.dismiss(id)} />
      )}
      <div className="lm-outlet">
        {mounted ? (
          <PluginErrorBoundary
            pluginId={host.mount.holder ?? "unknown"}
            point="ui.mount"
            fallback={MountFailed}
            onError={(error, where) => {
              // The shell that would have shown these notices is the thing that just
              // threw, so the kernel takes the strip back over.
              setMountFailed(true);
              host.notices.notify({
                id: "kernel:mount-failed",
                level: "error",
                message: `The interface from "${where.pluginId}" failed to render.`,
                detail: error.message,
              });
            }}
          >
            <KernelOutlet mount={host.mount} />
          </PluginErrorBoundary>
        ) : (
          <NoShell bootMode={host.info.bootMode} />
        )}
      </div>
      {signInNeeded ? (
        <ReauthOverlay
          user={host.session.user}
          {...(bearer !== undefined ? { bearer } : {})}
          onSignedIn={onSignedIn}
          exportUnsent={() => host.documents.exportUnsent()}
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
        <code>{pluginId}</code> draws the interface and it failed. Your documents are
        untouched.
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
      <p>Your workspace loaded, but no plugin drew the interface.</p>
      <p>
        Boot mode: <code>{bootMode}</code>.
      </p>
      <p>
        <a href={safeModeUrl("base")}>Boot with base plugins only</a> ·{" "}
        <a href={safeModeUrl("bare")}>Open the built-in plugin manager</a>
      </p>
    </div>
  );
}
