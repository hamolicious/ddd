/**
 * The blessed Tailwind preset for a Life Manager frontend plugin.
 *
 * There is intentionally no preflight and no cascade layer here. Plugin stylesheets
 * are linked after the app shell: preflight would restyle the whole application, and
 * layered utilities would lose to the shell's unlayered element rules. `@theme inline`
 * keeps the kernel-owned tokens live rather than writing global replacement values.
 */
export const TAILWIND_PRESET = String.raw`
@import "tailwindcss/theme.css" source(none);
@import "tailwindcss/utilities.css" source(none);

/* The kernel, rather than the OS preference, owns the active colour scheme. */
@custom-variant dark (&:where([data-lm-scheme="dark"], [data-lm-scheme="dark"] *));

/* Keep this in sync with _shared/compact.ts's COMPACT_MEDIA_QUERY. */
@custom-variant compact (@media ((max-width: 640px) or ((max-height: 480px) and (pointer: coarse))));

@theme inline {
  /* Surfaces and text */
  --color-bg: var(--lm-bg);
  --color-bg-subtle: var(--lm-bg-subtle);
  --color-bg-raised: var(--lm-bg-raised);
  --color-bg-overlay: var(--lm-bg-overlay);
  --color-border: var(--lm-border);
  --color-border-strong: var(--lm-border-strong);
  --color-text: var(--lm-text);
  --color-text-muted: var(--lm-text-muted);
  --color-text-inverse: var(--lm-text-inverse);

  /* Meaning */
  --color-link: var(--lm-link);
  --color-accent: var(--lm-accent);
  --color-accent-text: var(--lm-accent-text);
  --color-accent-subtle: var(--lm-accent-subtle);
  --color-danger: var(--lm-danger);
  --color-danger-text: var(--lm-danger-text);
  --color-warning: var(--lm-warning);
  --color-success: var(--lm-success);

  /* Affordances */
  --color-focus: var(--lm-focus-ring);
  --color-selection: var(--lm-selection);
  --shadow-1: var(--lm-shadow-1);
  --shadow-2: var(--lm-shadow-2);

  /* Type and metrics */
  --font-sans: var(--lm-font-sans);
  --font-mono: var(--lm-font-mono);
  --radius: var(--lm-radius);
  --radius-md: var(--lm-radius);
  --radius-lg: var(--lm-radius-lg);
  --spacing: var(--lm-space);
}

/* SPEC §6.5's 44 px touch target; @utility makes it variant-aware. */
@utility tap {
  min-height: var(--lm-tap-target);
  min-width: var(--lm-tap-target);
}
@utility tap-h {
  min-height: var(--lm-tap-target);
}
`;
