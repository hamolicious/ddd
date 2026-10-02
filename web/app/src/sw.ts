import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";
import { precacheEntries } from "virtual:ddd-precache";

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

const SHELL_CACHE = "ddd-shell";

precacheAndRoute([...precacheEntries]);
cleanupOutdatedCaches();

registerRoute(
  ({ url }) => url.pathname.startsWith("/plugins/"),
  new CacheFirst({ cacheName: "ddd-plugins" }),
);

registerRoute(
  ({ url }) => url.pathname.startsWith("/runtime/"),
  new CacheFirst({ cacheName: "ddd-runtime" }),
);

registerRoute(
  ({ url }) => url.pathname === "/importmap.json" || url.pathname === "/kernel.d.ts",
  new StaleWhileRevalidate({ cacheName: "ddd-meta" }),
);

registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly());

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

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.caches.delete(SHELL_CACHE));
});

sw.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    void sw.skipWaiting();
  }
});
