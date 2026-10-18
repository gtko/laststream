import { createHash } from 'node:crypto';
import { type KvCache, platform } from '../platform/index.js';
import { createMemoryKvCache } from '../platform/memory-kv-cache.js';

/**
 * Registre des URL de lecture que lastAddon a lui-même émises ou résolues (flux directs rendus au client, liens débridés
 * vers lesquels /play redirige). Les miniatures de la barre n'acceptent que ces URL (en plus du serveur de streaming
 * local) : un client ne peut donc pas faire lire une adresse arbitraire à ffmpeg ni au relais de plages.
 *
 * Le registre vit dans un `KvCache` de la plateforme (mémoire sous Node, KV sous Workers) : sous Workers, /stream,
 * /play et la route de miniatures peuvent être servis par des instances différentes.
 */

/** Durée de vie d'une entrée : une séance de lecture longue, pas davantage. */
export const ISSUED_TTL_MS = 6 * 3600e3;

/** Normalise une URL (href) ; undefined si elle est invalide ou non http(s). */
function hrefOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Clé de cache d'une valeur arbitraire (les clés KV sont limitées en longueur) : préfixe et empreinte SHA-256. */
const keyOf = (prefix: 'u' | 'r', value: string): string => `${prefix}:${createHash('sha256').update(value).digest('hex')}`;

export class IssuedUrls {
  private readonly kv: KvCache;
  private readonly ttlSeconds: number;

  /** `now` et `ttlMs` : horloge et durée de vie ; `kv` : stockage (défaut : mémoire du processus). */
  constructor(now: () => number = Date.now, ttlMs: number = ISSUED_TTL_MS, kv?: KvCache) {
    this.ttlSeconds = ttlMs / 1000;
    this.kv = kv ?? createMemoryKvCache(now);
  }

  /** Une URL rendue au client (flux direct ou lien de lecture lastAddon). */
  async note(raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return;
    const href = hrefOf(raw);
    if (href !== undefined) await this.kv.set(keyOf('u', href), '1', this.ttlSeconds);
  }

  /** Les flux d'une réponse /stream : on retient leur `url` s'ils en ont une. */
  async noteStreams(streams: readonly unknown[]): Promise<void> {
    const urls = streams.flatMap((stream) =>
      typeof stream === 'object' && stream !== null && 'url' in stream ? [(stream as { url?: unknown }).url] : [],
    );
    await Promise.all(urls.map((url) => this.note(url)));
  }

  /** Lien débridé vers lequel la route /play de `path` (chemin + requête) vient de rediriger. */
  async noteResolved(path: string, target: string): Promise<void> {
    const href = hrefOf(target);
    if (href === undefined) return;
    await Promise.all([this.kv.set(keyOf('r', path), href, this.ttlSeconds), this.kv.set(keyOf('u', href), '1', this.ttlSeconds)]);
  }

  /** Cette URL a-t-elle été émise récemment ? */
  async has(raw: string): Promise<boolean> {
    const href = hrefOf(raw);
    return href !== undefined && (await this.kv.get(keyOf('u', href))) !== undefined;
  }

  /** Dernier lien débridé résolu pour le chemin d'une URL /play lastAddon, ou undefined. */
  async resolvedFor(raw: string): Promise<string | undefined> {
    try {
      const url = new URL(raw);
      return await this.kv.get(keyOf('r', url.pathname + url.search));
    } catch {
      return undefined;
    }
  }
}

let shared: IssuedUrls | undefined;

/** Registre du processus (ou, sous Workers, partagé par KV), alimenté par les routes /stream et /play. */
export function issuedUrls(): IssuedUrls {
  shared ??= new IssuedUrls(Date.now, ISSUED_TTL_MS, platform().createKvCache('issued'));
  return shared;
}
