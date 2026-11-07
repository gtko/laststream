// Service worker « coupe-circuit » : l'ancienne app (fork de stremio-web) servie sur la même origine
// avait installé un service worker Workbox qui continue de servir sa version en cache.
// Ce fichier le remplace, vide tous les caches, se désinscrit et recharge les onglets ouverts.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
