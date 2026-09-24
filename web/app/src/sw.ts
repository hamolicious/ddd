/**
 * The service worker (SPEC §8: "Offline app shell (browser): Workbox; kernel bundle
 * precached; plugin modules served at version-scoped URLs cached immutable; one
 * 'update available — reload' flow covers bundle and plugin changes").
 *
 * Four routes, and the reasoning for each:
 *
 * - **Precache** everything the build emitted — the app bundle *and* the runtime
 *   layer chunks. Without the runtime chunks an offline boot resolves `react`
 *   through the import map to a URL it cannot fetch, which looks like a broken
 *   import map rather than a missing cache entry.
 * - **`/plugins/<id>/<version>/…` cache-first, forever.** The URL carries the
 *   version, so the bytes behind it never change; a new version is a new URL. This
 *   is what makes "the server hot-loads plugins and every client falls in step"
 *   (SPEC §1) survive going offline.
 * - **`/importmap.json` stale-while-revalidate.** It *does* change (on install), and
 *   it must exist offline. Serving yesterday's map and refreshing in the background
 *   is exactly right: it points at version-scoped URLs that are all still valid.
 * - **`/api/**` network-only, never cached.** Documents live in IndexedDB through the
 *   sync protocol, which has its own consistency model (`safe_seq`, state vectors). A
 *   cached REST response is a second, silently-wrong copy of the workspace.
 *
 * The precache list is a virtual module the service-worker build fills in by reading
 * what the app build actually emitted (`vite.sw.config.ts`) — so it cannot drift from
 * the bundle, and there is no generated file checked into `src/`.
 */

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";
import { precacheEntries } from "virtual:lm-precache";

/**
 * The three worker-scope members this file uses. Declared locally rather than by
 * adding the `webworker` lib: that lib and `dom` redeclare each other's globals, and
 * one tsconfig covers this file, the app and every plugin.
 */
interface WorkerScope {
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "message",
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
  addEventListener(
    type: "activate",
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  readonly caches: { delete(name: string): Promise<boolean> };
  readonly crypto: Crypto;
}

const sw = self as unknown as WorkerScope;

/** The one cache entry holding a rendered `index.html`. */
const SHELL_CACHE = "lm-shell";

precacheAndRoute([...precacheEntries]);
cleanupOutdatedCaches();

// Plugin modules and their assets: immutable per version.
registerRoute(
  ({ url }) => url.pathname.startsWith("/plugins/"),
  new CacheFirst({ cacheName: "lm-plugins" }),
);

// The runtime layer is precached, but a hashed chunk requested after an update
// (a plugin pinned to an older map) still has to resolve.
registerRoute(
  ({ url }) => url.pathname.startsWith("/runtime/"),
  new CacheFirst({ cacheName: "lm-runtime" }),
);

registerRoute(
  ({ url }) => url.pathname === "/importmap.json" || url.pathname === "/kernel.d.ts",
  new StaleWhileRevalidate({ cacheName: "lm-meta" }),
);

// The API and the sync socket are never the service worker's business.
registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly());

/**
 * SPA navigation: every in-app URL renders the app shell (the router is a plugin, so
 * `/doc/01J…` is a client-side route).
 *
 * **Network-first, and the shell is deliberately *not* precached.** The server injects
 * the import map inline with a per-response CSP nonce, so a precached `index.html`
 * would pin one nonce and one import map forever — and `createHandlerBoundToURL`
 * combined with a document the server rewrites per request is how you end up serving a
 * shell whose map predates the last deploy. Online, every navigation gets a fresh
 * document; offline, the last good one is served from this cache, which is exactly the
 * app-shell guarantee of SPEC §8.
 *
 * One cache entry, keyed on `/`: caching per-URL would store a copy of the same shell
 * for every document a user has ever opened.
 *
 * Runtime-caching it still replays bytes the server marked `no-store`, so the two
 * consequences are handled rather than accepted: the nonce is re-minted on every served
 * response ({@link withFreshNonce}), so a cached CSP nonce is never a fixed long-lived
 * value; and the entry is dropped when a new worker activates, so a post-deploy shell can
 * never boot against runtime chunks that no longer exist.
 */
const shell = new NetworkFirst({ cacheName: SHELL_CACHE, networkTimeoutSeconds: 4 });
registerRoute(
  new NavigationRoute(
    async ({ event }) =>
      withFreshNonce(
        await shell.handle({ event, request: new Request("/", { credentials: "same-origin" }) }),
      ),
    { denylist: [/^\/api\//, /^\/plugins\//, /^\/metrics$/, /^\/health/, /^\/ready/] },
  ),
);

/**
 * Re-mint the CSP nonce on every served shell.
 *
 * The server sends `index.html` with `Cache-Control: no-store` precisely because its
 * inline import map carries a per-response nonce, and `statics.rs` says in as many words
 * that "a cached nonce is a CSP bypass". The Cache Storage API does not honour
 * `no-store`, so storing the shell for offline use — which the app-shell guarantee of
 * SPEC §8 requires — would otherwise replay one nonce to that browser indefinitely, and
 * the nonce would stop being unguessable.
 *
 * So the cached bytes keep a *placeholder* nonce and every response rewrites it: the
 * value in the `Content-Security-Policy` header and the value on the inline
 * `<script type="importmap">` are replaced with the same fresh random string. The policy
 * is unchanged in every other respect, and a response with no nonce (an error page, a
 * document served by something other than `index_html`) passes through untouched.
 */
async function withFreshNonce(response: Response): Promise<Response> {
  const csp = response.headers.get("content-security-policy");
  const current = csp === null ? null : /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp);
  const previous = current?.[1];
  if (!csp || previous === undefined) return response;

  const bytes = new Uint8Array(16);
  sw.crypto.getRandomValues(bytes);
  const next = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const body = (await response.text()).split(previous).join(next);
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", csp.split(previous).join(next));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A new worker discards the stored shell.
 *
 * The cached document carries the import map that was inline when it was stored, and that
 * map names hashed `/runtime/<chunk>-<hash>.js` URLs. After a deploy those files are gone
 * (`cleanupOutdatedCaches` removes the old precache), so serving yesterday's shell — which
 * happens on any navigation slower than `networkTimeoutSeconds` — would boot a page whose
 * `react` cannot resolve. Dropping it costs one online navigation to refill, and the
 * navigation that activates a new worker is by definition one that just reached the server.
 */
sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.caches.delete(SHELL_CACHE));
});

/**
 * The single update flow. The worker waits rather than taking over mid-session — a
 * kernel bundle swapped under a running plugin set is how you get two Reacts and an
 * unexplainable render loop — and the page offers "reload to update" (see
 * `update.ts`). `SKIP_WAITING` is that button.
 */
sw.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    void sw.skipWaiting();
  }
});
