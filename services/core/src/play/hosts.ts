/** Durée par défaut pendant laquelle un hébergeur reste marqué indisponible, en millisecondes (1 h). */
export const DEFAULT_HOST_DOWN_MS = 3_600_000;

/** Options de HostHealth : durée d'indisponibilité et horloge injectable. */
export interface HostHealthOptions {
  downMs?: number;
  now?: () => number;
}

/**
 * Nom d'hôte normalisé pour les comparaisons : sans espaces, en minuscules, sans point final.
 * Renvoie undefined si rien ne reste.
 */
export function normalizeHost(host: string): string | undefined {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return normalized === '' ? undefined : normalized;
}

/**
 * Nom d'hôte (hostname) d'une URL http(s), normalisé. Renvoie undefined pour une URL invalide,
 * un autre schéma (magnet:, data:…) ou une URL sans hôte. L'URL n'est jamais renvoyée ni journalisée ici.
 */
export function hostFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return normalizeHost(parsed.hostname);
}

/**
 * Mémoire des hébergeurs en panne : un hôte signalé par markDown est considéré indisponible
 * pendant downMs, puis redevient utilisable. Les hôtes sont comparés après normalisation.
 */
export class HostHealth {
  private readonly downMs: number;
  private readonly now: () => number;
  private readonly downUntil = new Map<string, number>();

  constructor(opts: HostHealthOptions = {}) {
    const downMs = opts.downMs ?? DEFAULT_HOST_DOWN_MS;
    if (!(downMs > 0)) throw new RangeError('downMs doit être > 0');
    this.downMs = downMs;
    this.now = opts.now ?? Date.now;
  }

  /** Marque l'hôte comme indisponible pour downMs à partir de maintenant. Ignore un hôte vide. */
  markDown(host: string): void {
    const key = normalizeHost(host);
    if (key === undefined) return;
    this.downUntil.set(key, this.now() + this.downMs);
  }

  /** Vrai si l'hôte est marqué indisponible à cet instant. Retire la marque une fois échue. */
  isDown(host: string): boolean {
    const key = normalizeHost(host);
    if (key === undefined) return false;
    const until = this.downUntil.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.downUntil.delete(key);
    return false;
  }

  /** Retire les marques échues. Renvoie leur nombre. */
  purge(): number {
    const now = this.now();
    let removed = 0;
    for (const [host, until] of this.downUntil) {
      if (now >= until) {
        this.downUntil.delete(host);
        removed += 1;
      }
    }
    return removed;
  }
}
