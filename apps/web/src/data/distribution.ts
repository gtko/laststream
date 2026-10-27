import { Capacitor } from '@capacitor/core';

/*
 * Canal de distribution. L'import d'addons (migration Stremio et Nuvio) n'existe jamais dans les versions App Store et
 * Google Play. Une version de store est reconnue par :
 * - le build web : `VITE_DISTRIBUTION=play` ou `appstore` ;
 * - la coque native : `appendUserAgent` de capacitor.config.json contenant `LaststreamStore/<canal>` (l'interface Android est
 *   chargée depuis le serveur, le même build web sert donc l'APK direct et une éventuelle version Play) ;
 * - iOS natif : toujours une version App Store.
 */
export const STORE_UA_MARK = 'LaststreamStore/';

export function isStoreBuild(): boolean {
  const env = String(import.meta.env.VITE_DISTRIBUTION ?? '').toLowerCase();
  if (env === 'play' || env === 'appstore') return true;
  try {
    if (Capacitor.getPlatform() === 'ios') return true;
  } catch { /* hors Capacitor */ }
  return typeof navigator !== 'undefined' && navigator.userAgent.includes(STORE_UA_MARK);
}
