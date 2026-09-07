/**
 * Service worker: caches the shell, never the data.
 *
 * The rule that matters here is that `/api/` is NEVER cached. A stale draft
 * served from cache would let you approve text that is not the text on the
 * server, and publish something you did not read. Offline for this app means
 * "cannot reach LinkedIn anyway", so there is nothing to gain by pretending.
 *
 * The shell — page, manifest, icons — is cached so the app opens instantly and
 * can at least tell you it is offline rather than showing a browser error page.
 */
// Bumped with the redesign: the old name's entries are deleted on activate, so
// an installed app picks up the new shell instead of serving the old one back.
const CACHE = "postwright-shell-v2";
const SHELL = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close; a stale
  // worker serving an old shell is exactly the confusion to avoid.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Anything that reads or writes state goes to the network, always, and fails
  // honestly if the network is gone.
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;

  // Shell: network first so a redeploy is picked up, cache as the fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});
