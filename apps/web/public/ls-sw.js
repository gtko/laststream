// Service worker minimal de Laststream (rend l'app installable). Aucun cache agressif :
// le réseau passe toujours en premier ; seul un écran « hors ligne » sert de repli aux navigations.
// (L'ancien service-worker.js reste le coupe-circuit qui nettoie l'ancienne app.)
const OFFLINE = 'ls-offline-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE).then((c) => c.add(new Request('/offline.html', { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== OFFLINE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()));
});
