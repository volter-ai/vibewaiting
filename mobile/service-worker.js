self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Vibewaiting is a live doorway into a local machine. The service worker exists for an installed
// app lifecycle, but deliberately provides no offline cache or stale transcript fallback.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin)
    return;
  event.respondWith(fetch(request, { cache: "no-store" }));
});
