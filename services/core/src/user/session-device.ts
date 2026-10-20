/** Longueur maximale du user-agent conservé avec une session. */
export const USER_AGENT_MAX_LENGTH = 200;

/** User-agent prêt à être stocké : sans espaces superflus, tronqué à 200 caractères ; null si absent ou vide. */
export function storedUserAgent(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, USER_AGENT_MAX_LENGTH);
}

/** Système d'exploitation déduit du user-agent (iPhone et iPad avant macOS : leur UA contient « Mac OS X »). */
function operatingSystem(ua: string): string | null {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** Navigateur déduit du user-agent. Les moteurs Chromium (Edge, Opera, Samsung, Chrome) passent avant Safari. */
function browser(ua: string): string | null {
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/**
 * Libellé court de l'appareil dérivé du user-agent, pour la fiche administrateur : « Android · Chrome »,
 * « iPhone · Safari », « Windows · Laststream Desktop ». Null si le user-agent ne permet de rien reconnaître
 * (absent, client HTTP générique, etc.).
 */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined || userAgent.trim() === '') return null;
  const os = operatingSystem(userAgent);
  // Clients Laststream (application de bureau ou mobile) : leur UA contient le nom de l'application.
  const app = /laststream/i.test(userAgent) ? (/desktop/i.test(userAgent) ? 'Laststream Desktop' : 'Application Laststream') : null;
  const what = app ?? browser(userAgent);
  const parts = [os, what].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
