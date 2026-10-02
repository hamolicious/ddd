import type { ReactElement } from "react";

const common = {
  "aria-hidden": true,
  viewBox: "0 0 24 24",
  width: "1.15em",
  height: "1.15em",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function KeyIcon(): ReactElement {
  return (
    <svg {...common}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </svg>
  );
}

export function TrashIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

export function RevokeIcon(): ReactElement {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

export function CopyIcon(): ReactElement {
  return (
    <svg {...common}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h9" />
    </svg>
  );
}

export function CheckIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

export function CloseIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PowerIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M12 3v9" />
      <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
    </svg>
  );
}

export function ChevronIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function PlayIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M7 5l12 7-12 7z" />
    </svg>
  );
}

export function UploadIcon(): ReactElement {
  return (
    <svg {...common}>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

export function InfoIcon(): ReactElement {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
