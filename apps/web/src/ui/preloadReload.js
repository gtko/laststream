/* Chargement à la demande en échec (`vite:preloadError`) : un fichier a disparu après une mise en ligne, ou le réseau a coupé.
 * En ligne, un rechargement repart sur les bons fichiers ; hors ligne, il ne servirait à rien (l'état d'erreur s'affiche).
 * Un seul rechargement par fenêtre de 5 minutes (garde horodatée) : pas de boucle, mais un onglet resté ouvert qui
 * traverse deux mises en ligne peut se recharger de nouveau. */
const KEY = 'ls-preload-reload';
export const RELOAD_GUARD_MS = 5 * 60 * 1000;

export function installPreloadReload(win = window) {
  win.addEventListener('vite:preloadError', (e) => {
    if (win.navigator && win.navigator.onLine === false) return;
    try {
      const last = Number(win.sessionStorage.getItem(KEY));
      const now = Date.now();
      if (last && now - last < RELOAD_GUARD_MS) return;
      win.sessionStorage.setItem(KEY, String(now));
    } catch (_) { return; }
    e.preventDefault();
    win.location.reload();
  });
}
