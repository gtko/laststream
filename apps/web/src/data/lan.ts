/* Adresses du réseau local : sur Android, le serveur lastAddon tourne sur le PC de l'utilisateur, en http. Le http n'est
 * accepté que pour ces adresses (Android ne sait pas limiter le trafic en clair à des plages IP). Fonctions pures, testées. */

/** localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, IPv6 local, noms en .local / .lan / .home ou sans point. */
export function isLanHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /\.(local|lan|home|internal)$/.test(h) || !h.includes('.');
}

/** `http://` n'est permis que vers le réseau local ; `https://` toujours. */
export function cleartextAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLanHost(u.hostname));
}

/** Serveur de streaming Stremio (port 11470) sur la machine qui héberge lastAddon ; chaîne vide si l'adresse est invalide. */
export function streamingServerFor(lastAddonBase: string): string {
  try {
    const u = new URL(lastAddonBase);
    return `${u.protocol}//${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:11470`;
  } catch {
    return '';
  }
}
