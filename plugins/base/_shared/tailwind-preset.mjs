export function tailwindPrefix(manifest) {
  const option = manifest["x-tailwind"];
  const chosen =
    typeof option === "object" && option !== null && "prefix" in option
      ? String(option.prefix)
      : manifest.id.replace(/[^a-z]/g, "");
  if (!/^[a-z]+$/.test(chosen)) {
    throw new Error(`${manifest.id}: Tailwind prefix "${chosen}" must be lowercase a-z only`);
  }
  if (chosen === "ddd") throw new Error(`${manifest.id}: Tailwind prefix "ddd" is reserved`);
  return chosen;
}

export const tailwindPreset = (prefix) => String.raw`
@import "tailwindcss/theme.css" source(none)${prefix ? ` prefix(${prefix})` : ""};
@import "tailwindcss/utilities.css" source(none);

/* The kernel, rather than the OS preference, owns the active colour scheme. */
@custom-variant dark (&:where([data-ddd-scheme="dark"], [data-ddd-scheme="dark"] *));

/* Keep this in sync with _shared/compact.ts's COMPACT_MEDIA_QUERY. */
@custom-variant compact (@media ((max-width: 640px) or ((max-height: 480px) and (pointer: coarse))));

/* No pointer that can hover: a phone in landscape is above the compact width and still
   cannot reveal anything that waits for :hover. */
@custom-variant touch (@media (hover: none));

@theme inline {
  /* Surfaces and text */
  --color-bg: var(--ddd-bg);
  --color-bg-subtle: var(--ddd-bg-subtle);
  --color-bg-raised: var(--ddd-bg-raised);
  --color-bg-overlay: var(--ddd-bg-overlay);
  --color-border: var(--ddd-border);
  --color-border-strong: var(--ddd-border-strong);
  --color-text: var(--ddd-text);
  --color-text-muted: var(--ddd-text-muted);
  --color-text-inverse: var(--ddd-text-inverse);

  /* Meaning */
  --color-link: var(--ddd-link);
  --color-accent: var(--ddd-accent);
  --color-accent-text: var(--ddd-accent-text);
  --color-accent-subtle: var(--ddd-accent-subtle);
  --color-danger: var(--ddd-danger);
  --color-danger-text: var(--ddd-danger-text);
  --color-warning: var(--ddd-warning);
  --color-success: var(--ddd-success);

  /* Affordances */
  --color-focus: var(--ddd-focus-ring);
  --color-selection: var(--ddd-selection);
  --shadow-1: var(--ddd-shadow-1);
  --shadow-2: var(--ddd-shadow-2);

  /* Type and metrics */
  --font-sans: var(--ddd-font-sans);
  --font-mono: var(--ddd-font-mono);
  --radius: var(--ddd-radius);
  --radius-md: var(--ddd-radius);
  --radius-lg: var(--ddd-radius-lg);
  /* Half a kernel space, so the numeric scale reads like stock Tailwind's 4 px one
     (p-2 = one --ddd-space) while still following a theme that changes the token. */
  --spacing: calc(var(--ddd-space) * 0.5);
}

/* SPEC §6.5's 44 px touch target; @utility makes it variant-aware. */
@utility tap {
  min-height: var(--ddd-tap-target);
  min-width: var(--ddd-tap-target);
}
@utility tap-h {
  min-height: var(--ddd-tap-target);
}
`;
