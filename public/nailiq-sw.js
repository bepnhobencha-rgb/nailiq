// Minimal service worker — its only job is to make the dashboard an
// installable PWA (Chrome/Android require a registered SW with a fetch
// handler). Network passthrough: we don't cache, so there's no stale-asset
// risk and the app always reflects the latest deploy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
// Presence of a fetch listener satisfies the installability check; we
// intentionally do NOT call respondWith, so every request hits the network.
self.addEventListener("fetch", () => {});
