/**
 * `virtual:lm-precache` — the precache list, generated at build time by
 * `vite.sw.config.ts` from the files the app build emitted.
 *
 * It is a virtual module rather than a generated source file so that nothing in
 * `src/` is ever stale, and so `npm run typecheck` passes in a checkout that has
 * never run a build.
 */
declare module "virtual:lm-precache" {
  export const precacheEntries: readonly { readonly url: string; readonly revision: string | null }[];
}
