/* Mémoire (session) des hôtes dont les fichiers ne se lisent pas par plages depuis la page (CORS refusé, plage ignorée).
 * Alimentée par la sonde du moteur audio de repli ; lue par le sélecteur de sources pour ne plus annoncer « Son décodé par
 * l'app » sur un hôte déjà refusé. Seul l'hôte de l'URL de départ est gardé : jamais le chemin ni la requête. */

const denied = new Set<string>();

function hostOf(url: string | undefined | null): string {
  try { return url ? new URL(url).host.toLowerCase() : ''; } catch { return ''; }
}

export function rememberRange(url: string, ok: boolean): void {
  const h = hostOf(url);
  if (!h) return;
  if (ok) denied.delete(h); else denied.add(h);
}

export function rangeDenied(url: string | undefined | null): boolean {
  const h = hostOf(url);
  return h !== '' && denied.has(h);
}

export function resetRangeMemory(): void { denied.clear(); }
