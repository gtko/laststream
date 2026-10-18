/* Les addons Stremio débrident eux-mêmes : l'app ne garde plus aucune clé de débrideur. Efface, au lancement, les
 * réglages et états de l'ancien gestionnaire (clés AllDebrid, TorBox, Real-Debrid) du stockage de l'appareil. */
const KEYS = ['laststream.debrid.v1', 'laststream.debrid.state.v1'];
const DB_NAME = 'laststream-debrid';

export function wipeDeviceDebrid(): void {
  try {
    const s = globalThis.localStorage;
    if (s) {
      for (const k of KEYS) s.removeItem(k);
      for (let i = s.length - 1; i >= 0; i -= 1) {
        const k = s.key(i);
        if (k && k.startsWith('laststream.debrid')) s.removeItem(k);
      }
    }
  } catch { /* stockage indisponible */ }
  try { globalThis.indexedDB?.deleteDatabase(DB_NAME); } catch { /* sans IndexedDB */ }
}
