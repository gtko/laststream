/* Où proposer l'app quand le navigateur ne suffit pas : détection d'OS et message de téléchargement adapté. Fonctions pures, testées. */

export type Os = 'windows' | 'android' | 'ios' | 'macos' | 'linux' | 'other';

export interface OsInput { userAgent?: string; platform?: string; maxTouchPoints?: number }

/** OS du navigateur d'après l'user-agent (l'iPad récent se dit « Macintosh » : écran tactile = iOS). */
export function detectOs(i: OsInput = {}): Os {
  const ua = i.userAgent ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/mac/i.test(i.platform ?? ua) && (i.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/windows/i.test(ua) || /^win/i.test(i.platform ?? '')) return 'windows';
  if (/mac/i.test(ua) || /^mac/i.test(i.platform ?? '')) return 'macos';
  if (/linux|x11|cros/i.test(ua)) return 'linux';
  return 'other';
}

export function currentOs(): Os {
  const n = typeof navigator === 'undefined' ? null : navigator;
  return detectOs({ userAgent: n?.userAgent, platform: n?.platform, maxTouchPoints: n?.maxTouchPoints });
}

/** Page de téléchargement de l'app (Windows, Android). */
export const APP_DOWNLOAD_URL = 'https://laststream.app/';

export interface AppOffer { text: string; link: { label: string; href: string } | null }

/** Message selon l'OS : lien de téléchargement sur Windows et Android, simple conseil ailleurs (pas d'app pour ces systèmes). */
export function appOffer(os: Os): AppOffer {
  switch (os) {
    case 'windows': return { text: 'Installe l’app Windows : elle lit tous les formats.', link: { label: 'Télécharger l’app Windows', href: APP_DOWNLOAD_URL } };
    case 'android': return { text: 'Installe l’app Android : elle lit tous les formats.', link: { label: 'Télécharger l’app Android', href: APP_DOWNLOAD_URL } };
    default: return { text: 'Il n’y a pas encore d’app pour ton système : ouvre Laststream dans Microsoft Edge sur Windows ou dans l’app Android.', link: null };
  }
}
