import { Capacitor, registerPlugin } from '@capacitor/core';

/* Résolution réelle de la sortie vidéo sur Android (ODY-251). La WebView d'une box Android TV déclare souvent 1920×1080 avec un
 * ratio de 1 sur une TV 4K : `screen` × `devicePixelRatio` sous-estime alors l'écran. Le plugin natif LaststreamDisplay lit le
 * mode d'affichage réel ; la valeur est mise en mémoire au démarrage pour que le plafond de résolution reste synchrone. */

interface LaststreamDisplayPlugin {
  getOutput(): Promise<{ width: number; height: number }>;
}

const NativeDisplay = registerPlugin<LaststreamDisplayPlugin>('LaststreamDisplay');

let shortSide: number | null = null;

/** Côté court de la sortie vidéo en pixels physiques, lu par le plugin natif (null : non disponible ou pas encore lu). */
export const nativeScreenShortSide = (): number | null => shortSide;

/** Valeur lue par le plugin → côté court, ou null si elle est inutilisable. */
export function shortSideOf(output: { width?: unknown; height?: unknown } | null | undefined): number | null {
  const w = Number(output?.width);
  const h = Number(output?.height);
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? Math.round(Math.min(w, h)) : null;
}

/** Remet la lecture à zéro (tests). */
export function resetNativeScreen(): void {
  shortSide = null;
}

/** Relit la sortie vidéo. Sans plugin (navigateur, ancienne version de l'APK) ou en cas d'erreur, la valeur reste inchangée. */
export async function refreshNativeScreen(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LaststreamDisplay')) return;
    const next = shortSideOf(await NativeDisplay.getOutput());
    if (next !== null) shortSide = next;
  } catch { /* plafond calculé d'après la WebView */ }
}

/** Lecture au démarrage, puis à chaque retour au premier plan (la TV a pu changer de mode HDMI). */
export function initNativeScreen(): void {
  void refreshNativeScreen();
  try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshNativeScreen(); }); } catch { /* pas de document */ }
}
