/**
 * Domaines de liens débridés dont l'URL https peut être signée pour le relais de plages, même sans avoir été émise par
 * /play : les flux de l'utilisateur viennent d'addons externes qui renvoient directement des liens AllDebrid. Même liste
 * et même règle que le Worker de relais (laststream-edge, RANGE_HOSTS) : le relais refuserait de toute façon le reste.
 */
const DEFAULT_HOSTS = '*.debrid.it,*.alldebrid.com';
const MAX_URL_LENGTH = 4096;

/** Motifs de domaines (variable LASTADDON_RANGE_HOSTS, séparés par des virgules ; à défaut, la liste par défaut). */
export function rangeHostPatterns(raw: string | undefined): string[] {
  return (raw !== undefined && raw.trim() !== '' ? raw : DEFAULT_HOSTS)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Domaine autorisé : `*.exemple.com` couvre les sous-domaines (jamais le domaine nu), un nom sans joker est exact. */
export function hostAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || /^[0-9.]+$/.test(host)) return false;
  return patterns.some((p) => (p.startsWith('*.') ? host.length > p.length - 1 && host.endsWith(p.slice(1)) : host === p));
}

/** URL https d'un domaine débrid autorisé (sans identifiants ni port autre que 443), sinon null. */
export function parseDebridUrl(raw: unknown, patterns: readonly string[]): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return null;
  return hostAllowed(url.hostname, patterns) ? url : null;
}
