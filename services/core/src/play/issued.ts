/**
 * Registre en mémoire des URL de lecture que lastAddon a lui-même émises ou résolues (flux directs rendus au client,
 * liens débridés vers lesquels /play redirige). Les miniatures de la barre n'acceptent que ces URL (en plus du serveur
 * de streaming local) : un client ne peut donc pas faire lire une adresse arbitraire à ffmpeg.
 */

/** Durée de vie d'une entrée : une séance de lecture longue, pas davantage. */
export const ISSUED_TTL_MS = 6 * 3600e3;
/** Nombre maximal d'entrées par table (les plus anciennes partent d'abord). */
export const ISSUED_MAX = 5000;

interface Entry<T> {
  value: T;
  at: number;
}

function put<T>(map: Map<string, Entry<T>>, key: string, value: T, now: number): void {
  map.delete(key);
  map.set(key, { value, at: now });
  while (map.size > ISSUED_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function live<T>(map: Map<string, Entry<T>>, key: string, now: number, ttl: number): T | undefined {
  const entry = map.get(key);
  if (entry === undefined) return undefined;
  if (now - entry.at > ttl) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Normalise une URL (href) ; undefined si elle est invalide ou non http(s). */
function hrefOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export class IssuedUrls {
  private readonly urls = new Map<string, Entry<true>>();
  private readonly resolved = new Map<string, Entry<string>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ISSUED_TTL_MS,
  ) {}

  /** Une URL rendue au client (flux direct ou lien de lecture lastAddon). */
  note(raw: unknown): void {
    if (typeof raw !== 'string') return;
    const href = hrefOf(raw);
    if (href !== undefined) put(this.urls, href, true, this.now());
  }

  /** Les flux d'une réponse /stream : on retient leur `url` s'ils en ont une. */
  noteStreams(streams: readonly unknown[]): void {
    for (const stream of streams) {
      if (typeof stream === 'object' && stream !== null && 'url' in stream) this.note((stream as { url?: unknown }).url);
    }
  }

  /** Lien débridé vers lequel la route /play de `path` (chemin + requête) vient de rediriger. */
  noteResolved(path: string, target: string): void {
    const href = hrefOf(target);
    if (href === undefined) return;
    const now = this.now();
    put(this.resolved, path, href, now);
    put(this.urls, href, true, now);
  }

  /** Cette URL a-t-elle été émise récemment ? */
  has(raw: string): boolean {
    const href = hrefOf(raw);
    return href !== undefined && live(this.urls, href, this.now(), this.ttlMs) === true;
  }

  /** Dernier lien débridé résolu pour le chemin d'une URL /play lastAddon, ou undefined. */
  resolvedFor(raw: string): string | undefined {
    try {
      const url = new URL(raw);
      return live(this.resolved, url.pathname + url.search, this.now(), this.ttlMs);
    } catch {
      return undefined;
    }
  }
}

/** Registre du processus, alimenté par les routes /stream et /play. */
export const issuedUrls = new IssuedUrls();
