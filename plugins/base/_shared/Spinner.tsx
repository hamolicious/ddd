import type { CSSProperties, ReactElement } from "react";

const SPIN = "ddd-shared-spinner-spin";

const KEYFRAMES = `@keyframes ${SPIN}{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){[data-ddd-spinner]{animation:none!important}}`;

const ROOT: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" };

const RING: CSSProperties = {
  display: "block",
  width: 14,
  height: 14,
  boxSizing: "border-box",
  borderRadius: "9999px",
  border: "2px solid var(--ddd-border)",
  borderTopColor: "var(--ddd-accent)",
  animation: `${SPIN} 1s linear infinite`,
};

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
};

export function Spinner({
  label = "Loading…",
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}): ReactElement {
  return (
    <span className={className} style={ROOT} role="status" aria-live="polite">
      <style>{KEYFRAMES}</style>
      <span style={SR_ONLY}>{label}</span>
      <span aria-hidden="true" data-ddd-spinner="" style={RING} />
    </span>
  );
}
