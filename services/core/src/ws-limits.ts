/**
 * Plafonds des connexions WebSocket des Durable Objects (party, flux social). Un Durable Object est un singleton : ses
 * compteurs en mémoire valent pour toutes les instances du Worker, contrairement à `rate-limit.ts`. Module pur, testable
 * sous Node ; les Durable Objects y branchent leurs sockets.
 */

/**
 * Fenêtre glissante par clé : au plus `max` messages sur les `windowMs` dernières millisecondes. Chaque message refusé est
 * quand même compté (un client qui insiste reste bloqué) mais l'historique garde au plus `max + 1` instants par clé.
 */
export function createSlidingWindow(max: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const current = now();
    const recent = (hits.get(key) ?? []).filter((at) => current - at < windowMs);
    recent.push(current);
    if (recent.length > max + 1) recent.splice(0, recent.length - (max + 1));
    hits.set(key, recent);
    if (hits.size > 10_000) {
      for (const [existing, list] of hits) {
        if (list.every((at) => current - at >= windowMs)) hits.delete(existing);
      }
    }
    return recent.length <= max;
  };
}

/** Connexion ouverte : ordre d'ouverture (`openedAt` en ms, puis `seq` pour départager la même milliseconde). */
export interface OpenConnection {
  openedAt: number;
  seq: number;
}

/**
 * Connexions à fermer pour qu'une nouvelle tienne sous le plafond `max` : les plus anciennes, en gardant `max - 1`
 * existantes. Plafond inférieur à 1 : toutes.
 */
export function connectionsToEvict<T extends OpenConnection>(open: readonly T[], max: number): T[] {
  const ordered = [...open].sort((a, b) => a.openedAt - b.openedAt || a.seq - b.seq);
  return ordered.slice(0, Math.max(0, ordered.length - Math.max(0, max - 1)));
}
