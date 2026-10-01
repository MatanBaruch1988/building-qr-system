// Kill switch for the OLD app's service worker on building-qr-system.web.app.
//
// The old PWA registered /sw.js on this address and caches the old app shell, so phones/browsers that used it
// keep showing the old app even after this folder is deployed. A browser re-checks /sw.js on every visit: this
// replacement installs at once, deletes every cache, unregisters itself and reloads open pages, which then get the
// redirect page (index.html) that forwards to the new address.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.map((n) => caches.delete(n)))
      await self.registration.unregister()
      const windows = await self.clients.matchAll({ type: 'window' })
      windows.forEach((w) => w.navigate(w.url))
    })(),
  )
})
