import { useEffect, useState, type ReactNode } from "react";

import type { Notice, SessionUser, SyncStatus } from "@kernel";
import { KernelOutlet, PluginErrorBoundary, type KernelHost } from "@kernel/runtime/index.js";

import { safeModeUrl } from "../boot/safe-mode.js";
import { ReauthOverlay } from "./ReauthOverlay.js";

export interface AppFrameProps {
  readonly host: KernelHost;
  readonly bearer?: boolean;
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
        setMountFailed(false);
      }),
    [host],
  );
  useEffect(() => host.sync.api().subscribe((state) => setStatus(state.status)), [host]);
  const [signInNeeded, setSignInNeeded] = useState(false);
  useEffect(() => {
    if (status === "auth-required") setSignInNeeded(true);
    else if (status === "syncing" || status === "synced") setSignInNeeded(false);
  }, [status]);

  const bare = host.info.bootMode === "bare";
  const holderDrawsNotices = mounted && !mountFailed && !bare;

  return (
    <div className="ddd-frame">
      {holderDrawsNotices ? null : (
        <NoticeStrip notices={notices} onDismiss={(id) => host.notices.dismiss(id)} />
      )}
      <div className="ddd-outlet">
        {mounted ? (
          <PluginErrorBoundary
            pluginId={host.mount.holder ?? "unknown"}
            point="ui.mount"
            fallback={MountFailed}
            onError={(error, where) => {
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
    <ul className="ddd-notices" aria-live="polite">
      {notices.map((notice) => (
        <li key={notice.id} className={`ddd-notice ddd-notice-${notice.level}`}>
          <span className="ddd-notice-message">{notice.message}</span>
          {notice.detail ? (
            <details className="ddd-notice-detail">
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
          {notice.progress ? (
            <div
              className="ddd-notice-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(clamp01(notice.progress.value) * 100)}
              aria-valuetext={notice.progress.label}
            >
              <span style={{ width: `${clamp01(notice.progress.value) * 100}%` }} />
              {notice.progress.label ? <small>{notice.progress.label}</small> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function MountFailed({
  error,
  pluginId,
}: {
  readonly error: Error;
  readonly pluginId: string;
}): ReactNode {
  return (
    <div className="ddd-empty" role="alert">
      <h1>The interface failed to render</h1>
      <p>
        <code>{pluginId}</code> draws the interface and it failed. Your documents are
        untouched.
      </p>
      <pre className="ddd-boot-error">{error.message}</pre>
      <p>
        <a href={safeModeUrl("base")}>Boot with base plugins only</a> ·{" "}
        <a href={safeModeUrl("bare")}>Open the built-in plugin manager</a>
      </p>
    </div>
  );
}

function NoShell({ bootMode }: { readonly bootMode: string }): ReactNode {
  return (
    <div className="ddd-empty" role="alert">
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
