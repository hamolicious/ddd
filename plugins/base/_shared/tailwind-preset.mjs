/**
 * The blessed Tailwind preset for a Life Manager frontend plugin.
 *
 * There is intentionally no preflight and no cascade layer here. Plugin stylesheets
 * are linked after the app shell: preflight would restyle the whole application, and
 * layered utilities would lose to the shell's unlayered element rules. `@theme inline`
 * keeps the kernel-owned tokens live rather than writing global replacement values.
 *
 * **Every plugin gets its own class prefix** (`folders:flex`, `folders:compact:gap-1`).
 * Each plugin's stylesheet is compiled on its own and they all land in one document, so
 * unprefixed utilities are shared names: a stylesheet linked later that also emits
 * `.invisible` or `.m-0` re-declares it *after* an earlier plugin's `visible` or
 * `ml-auto`, and silently wins on that plugin's elements. With a prefix no two plugins
 * emit the same selector, and each stylesheet's own ordering is the whole story.
 */

/**
 * The prefix a plugin's classes carry: `x-tailwind.prefix` from the manifest, or the
 * plugin id with everything but `a-z` removed (Tailwind accepts nothing else).
 *
 * @param {{ id: string, "x-tailwind"?: unknown }} manifest
 */
export function tailwindPrefix(manifest) {
  const option = manifest["x-tailwind"];
  const chosen =
    typeof option === "object" && option !== null && "prefix" in option
      ? String(option.prefix)
      : manifest.id.replace(/[^a-z]/g, "");
  if (!/^[a-z]+$/.test(chosen)) {
    throw new Error(`${manifest.id}: Tailwind prefix "${chosen}" must be lowercase a-z only`);
  }
  // The prefix also names the theme variables Tailwind emits (`--<prefix>-text-sm`), and
  // `--lm-*` is the kernel's token namespace: `lm` would overwrite the app's theme.
  if (chosen === "lm") throw new Error(`${manifest.id}: Tailwind prefix "lm" is reserved`);
  return chosen;
}

/** @param {string} prefix `tailwindPrefix(manifest)`; `""` compiles unprefixed. */
export const tailwindPreset = (prefix) => String.raw`
@import "tailwindcss/theme.css" source(none)${prefix ? ` prefix(${prefix})` : ""};
@import "tailwindcss/utilities.css" source(none);

/* The kernel, rather than the OS preference, owns the active colour scheme. */
@custom-variant dark (&:where([data-lm-scheme="dark"], [data-lm-scheme="dark"] *));

/* Keep this in sync with _shared/compact.ts's COMPACT_MEDIA_QUERY. */
@custom-variant compact (@media ((max-width: 640px) or ((max-height: 480px) and (pointer: coarse))));

/* No pointer that can hover: a phone in landscape is above the compact width and still
   cannot reveal anything that waits for :hover. */
@custom-variant touch (@media (hover: none));

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
  /* Half a kernel space, so the numeric scale reads like stock Tailwind's 4 px one
     (p-2 = one --lm-space) while still following a theme that changes the token. */
  --spacing: calc(var(--lm-space) * 0.5);
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
