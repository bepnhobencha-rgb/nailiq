// TurnIQ M5 application shell. Only the generic offline route and immutable
// same-origin Next static assets are cached. Authenticated dashboard HTML,
// API responses, Server Actions and customer/provider data are never cached.
const CACHE_NAME = "nailiq-turniq-offline-shell-v1";
const OFFLINE_PATH = "/turniq/offline";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith("nailiq-turniq-offline-shell-") && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "WARM_TURNIQ_OFFLINE_SHELL") return;
  const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const raw of urls) {
      try {
        const url = new URL(raw, self.location.origin);
        const allowed = url.origin === self.location.origin &&
          (url.pathname === OFFLINE_PATH || url.pathname.startsWith("/_next/static/"));
        if (!allowed) continue;
        const response = await fetch(url.href, { credentials: "same-origin" });
        if (response.ok) await cache.put(url.href, response);
      } catch {
        // Warming is best-effort; the UI reports whether a valid encrypted
        // snapshot exists before allowing any offline mutation.
      }
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const isTurnIqSurface =
          url.pathname === OFFLINE_PATH ||
          /^\/dashboard\/[^/]+\/center\/?$/.test(url.pathname);
        if (!isTurnIqSurface) throw error;
        const cached = await caches.match(new URL(OFFLINE_PATH, self.location.origin).href);
        if (cached) return cached;
        throw error;
      }
    })());
  }
});
