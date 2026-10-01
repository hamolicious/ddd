/**
 * The demo's offline app shell (SPEC §8: "Workbox; kernel bundle precached").
 *
 * Hand-written, ~50 lines, because M2 adds no dependencies (web/CONTRACTS.md) and
 * `vite-plugin-pwa` is optional for this milestone. M3 replaces it with the real
 * Workbox setup and the "update available — reload" flow; the contract it has to
 * keep is the one this file already keeps:
 *
 * - **Network-first, cache-fallback** for the shell and its modules. Fresh code
 *   wins whenever the network answers (dev reloads keep working), and a reload
 *   with the plug pulled still boots the app.
 * - **`/api` is never touched.** Sync, REST and the WebSocket must fail honestly
 *   when the server is unreachable — a cached `200` for a projection query or a
 *   login would be a lie, and the kernel's offline story is IndexedDB, not HTTP
 *   caching (SPEC §4.1).
 */

const CACHE = "ddd-demo-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/index.html"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        // Opaque and error responses are not worth keeping.
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        // Ignore the query string on the way back out: Vite's dev server stamps
        // module URLs with cache-busting parameters that change between loads.
        const cached =
          (await cache.match(request)) ?? (await cache.match(request, { ignoreSearch: true }));
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await cache.match("/index.html", { ignoreSearch: true });
          if (shell) return shell;
        }
        throw error;
      }
    })(),
  );
});
