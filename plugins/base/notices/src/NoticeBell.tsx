import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Kernel, Notice } from "@kernel";

function useNotices(kernel: Kernel): readonly Notice[] {
  const [notices, setNotices] = useState<readonly Notice[]>(() => kernel.ui.notices());
  useEffect(() => kernel.ui.onNotices(setNotices), [kernel]);
  return notices;
}

export function NoticeBell({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const notices = useNotices(kernel);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);

  const count = notices.length;
  const announced = useRef<ReadonlySet<string> | undefined>(undefined);
  if (announced.current === undefined) {
    announced.current = new Set(notices.map((notice) => notice.id));
  }

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  useEffect(() => {
    const previous = announced.current ?? new Set<string>();
    announced.current = new Set(notices.map((notice) => notice.id));
    if (notices.some((notice) => !previous.has(notice.id) && !notice.progress)) setOpen(true);
  }, [notices]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (count === 0) return null;

  const running = notices.flatMap((notice) => (notice.progress ? [clamp01(notice.progress.value)] : []));

  const worst = notices.some((notice) => notice.level === "error")
    ? "error"
    : notices.some((notice) => notice.level === "warning")
      ? "warning"
      : "info";

  return (
    <div className="notices:relative notices:inline-flex notices:compact:static" ref={container}>
      <button
        type="button"
        className="notices-bell notices:group notices:tap notices:relative notices:box-border notices:inline-flex notices:w-[var(--ddd-tap-target)] notices:cursor-pointer notices:items-center notices:justify-center notices:rounded notices:border notices:border-transparent notices:bg-transparent notices:p-0 notices:text-text-muted notices:hover:border-border notices:hover:bg-bg-raised notices:hover:text-text"
        data-level={worst}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="notices:size-[1.15em]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span
          aria-hidden="true"
          className="notices:absolute notices:right-1 notices:top-1 notices:min-w-[1.3em] notices:rounded-full notices:bg-accent notices:px-1 notices:text-center notices:text-[0.7em] notices:font-semibold notices:leading-[1.3em] notices:text-accent-text notices:tabular-nums notices:group-data-[level=warning]:bg-warning notices:group-data-[level=warning]:text-text-inverse notices:group-data-[level=error]:bg-danger notices:group-data-[level=error]:text-danger-text"
        >
          {count}
        </span>
        <span className="notices:sr-only">
          {count} notice{count === 1 ? "" : "s"}
        </span>
        {running.length > 0 ? (
          <span aria-hidden="true" className="notices:absolute notices:inset-x-1.5 notices:bottom-1 notices:h-[3px] notices:overflow-hidden notices:rounded-full notices:bg-border">
            <span
              className="notices:block notices:h-full notices:bg-accent notices:transition-[width] notices:duration-300"
              style={{ width: `${(running.reduce((total, value) => total + value, 0) / running.length) * 100}%` }}
            />
          </span>
        ) : null}
      </button>
      <div id={panelId} className="notices-panel notices:absolute notices:right-0 notices:top-[calc(100%+var(--ddd-space)*0.5)] notices:z-25 notices:max-h-[calc(var(--ddd-viewport-height)*0.6)] notices:w-[min(26rem,calc(100vw-var(--ddd-space)*2))] notices:overflow-y-auto notices:rounded-lg notices:border notices:border-border notices:bg-bg-raised notices:p-2 notices:shadow-2 notices:compact:inset-x-2 notices:compact:w-auto notices:compact:pb-[calc(var(--ddd-space)+var(--ddd-safe-bottom))] notices:[&_li]:border-b notices:[&_li]:border-border notices:[&_li]:py-1.5 notices:[&_li:last-child]:border-b-0 notices:[&_pre]:mt-1 notices:[&_pre]:max-w-full notices:[&_pre]:overflow-x-auto notices:[&_pre]:whitespace-pre-wrap notices:[&_ul]:m-0 notices:[&_ul]:list-none notices:[&_ul]:p-0" hidden={!open} role="group" aria-label="Notices">
        <ul>
          {notices.map((notice) => (
            <li key={notice.id} data-level={notice.level}>
              <p className={`notices:mb-1 notices:mt-0 notices:[overflow-wrap:anywhere] ${notice.level === "error" ? " notices:text-danger" : notice.level === "warning" ? " notices:text-warning" : ""}`}>{notice.message}</p>
              {notice.pluginId ? (
                <p className="notices:mb-1 notices:mt-0 notices:text-sm notices:text-text-muted">
                  plugin <code>{notice.pluginId}</code>
                </p>
              ) : null}
              {notice.detail ? (
                <details>
                  <summary>Details</summary>
                  <pre>{notice.detail}</pre>
                </details>
              ) : null}
              <p className="notices:m-0 notices:flex notices:flex-wrap notices:gap-1">
                {(notice.actions ?? []).map((action) => (
                  <button key={action.label} type="button" onClick={() => action.run()}>
                    {action.label}
                  </button>
                ))}
              </p>
              {notice.progress ? <ProgressBar value={notice.progress.value} label={notice.progress.label} /> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProgressBar({ value, label }: { readonly value: number; readonly label?: string }): ReactNode {
  const share = clamp01(value);
  return (
    <div
      className="notices:mt-1.5 notices:flex notices:flex-col notices:gap-0.5"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-valuetext={label}
    >
      <span className="notices:block notices:h-1 notices:overflow-hidden notices:rounded-full notices:bg-border">
        <span
          className="notices:block notices:h-full notices:rounded-full notices:bg-accent notices:transition-[width] notices:duration-300"
          style={{ width: `${share * 100}%` }}
        />
      </span>
      {label ? <span className="notices:self-end notices:text-sm notices:text-text-muted notices:tabular-nums">{label}</span> : null}
    </div>
  );
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
