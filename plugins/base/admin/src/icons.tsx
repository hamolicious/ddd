import { useSyncExternalStore, type ReactElement } from "react";

type IconsModule = typeof import("plugin:icons");

let iconsModule: IconsModule | undefined;
const iconListeners = new Set<() => void>();

export function setIconsPlugin(module: IconsModule | undefined): void {
  iconsModule = module;
  for (const listener of [...iconListeners]) listener();
}

const subscribeIcons = (listener: () => void): (() => void) => {
  iconListeners.add(listener);
  return () => iconListeners.delete(listener);
};

function Glyph({ name, fallback }: { readonly name: string; readonly fallback: ReactElement }): ReactElement {
  const icons = useSyncExternalStore(subscribeIcons, () => iconsModule, () => iconsModule);
  return icons ? <icons.Icon name={name} size="1.15em" /> : fallback;
}

function glyph(name: string, fallback: ReactElement): ReactElement {
  return <Glyph name={name} fallback={fallback} />;
}

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
  return glyph("key", (
    <svg {...common}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </svg>
  ));
}

export function TrashIcon(): ReactElement {
  return glyph("trash", (
    <svg {...common}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  ));
}

export function RevokeIcon(): ReactElement {
  return glyph("ban", (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  ));
}

export function CopyIcon(): ReactElement {
  return glyph("copy", (
    <svg {...common}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h9" />
    </svg>
  ));
}

export function CheckIcon(): ReactElement {
  return glyph("check", (
    <svg {...common}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  ));
}

export function CloseIcon(): ReactElement {
  return glyph("x", (
    <svg {...common}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ));
}

export function PowerIcon(): ReactElement {
  return glyph("power", (
    <svg {...common}>
      <path d="M12 3v9" />
      <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
    </svg>
  ));
}

export function ChevronIcon(): ReactElement {
  return glyph("chevron-down", (
    <svg {...common}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ));
}

export function PlayIcon(): ReactElement {
  return glyph("player-play", (
    <svg {...common}>
      <path d="M7 5l12 7-12 7z" />
    </svg>
  ));
}

export function UploadIcon(): ReactElement {
  return glyph("upload", (
    <svg {...common}>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  ));
}

export function InfoIcon(): ReactElement {
  return glyph("info-circle", (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  ));
}

export function CogIcon(): ReactElement {
  return glyph("settings", (
    <svg {...common}>
      <path d="M10.3 4.3a1.7 1.7 0 0 1 3.4 0 1.7 1.7 0 0 0 2.6 1.1 1.7 1.7 0 0 1 2.4 2.4 1.7 1.7 0 0 0 1 2.5 1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0-1 2.6 1.7 1.7 0 0 1-2.4 2.4 1.7 1.7 0 0 0-2.6 1 1.7 1.7 0 0 1-3.4 0 1.7 1.7 0 0 0-2.5-1 1.7 1.7 0 0 1-2.4-2.4 1.7 1.7 0 0 0-1.1-2.6 1.7 1.7 0 0 1 0-3.4 1.7 1.7 0 0 0 1.1-2.5 1.7 1.7 0 0 1 2.4-2.4 1.7 1.7 0 0 0 2.5-1.1z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ));
}

export function PackageIcon(): ReactElement {
  return glyph("package", (
    <svg {...common}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ));
}

export function RefreshIcon(): ReactElement {
  return glyph("refresh", (
    <svg {...common}>
      <path d="M20 11a8 8 0 0 0-14.9-4M4 4v3h3M4 13a8 8 0 0 0 14.9 4M20 20v-3h-3" />
    </svg>
  ));
}

export function UpdateIcon(): ReactElement {
  return glyph("circle-arrow-up", (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16V8M8 12l4-4 4 4" />
    </svg>
  ));
}
