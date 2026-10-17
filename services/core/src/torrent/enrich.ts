import type { RawStream } from '../types.js';
import type { FetchFn } from '../sources/http.js';
import { fetchTorrent, type FetchedTorrent, type TorrentCache } from './fetch-torrent.js';

/** Nombre maximal de .torrent lus en parallèle. */
export const ENRICH_CONCURRENCY = 3;

export interface EnrichOptions {
  /** fetch injecté (tests). Par défaut : fetch global. */
  fetch?: FetchFn;
  /** Nombre maximal de flux à lire (les N premiers parmi ceux sans infoHash mais avec downloadUrl). */
  topN: number;
  /** guid d'un flux ; défaut : stream.guid. Sert de clé de cache. */
  guidOf?: (stream: RawStream) => string | undefined;
  timeoutMs?: number;
  cache?: TorrentCache;
}

interface Candidate {
  index: number;
  url: string;
  guid: string | undefined;
}

/** Exécute `task` sur chaque élément avec au plus `limit` tâches simultanées. */
async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function applyTorrent(stream: RawStream, fetched: FetchedTorrent): RawStream {
  if (fetched.kind === 'magnet') return { ...stream, infoHash: fetched.infoHash };
  return {
    ...stream,
    infoHash: fetched.infoHash,
    privateTorrent: fetched.private,
    packFiles: fetched.files.map((file) => ({ idx: file.idx, name: file.path, size: file.size })),
  };
}

/**
 * Renseigne l'infoHash des flux qui n'en ont pas mais portent une downloadUrl (lien .torrent proxifié), en lisant
 * le .torrent. Ne traite que les `topN` premiers candidats, avec au plus ENRICH_CONCURRENCY lectures simultanées.
 * Un échec ne touche que son flux, qui reste tel quel. Renvoie un nouveau tableau : les flux non lus sont les
 * mêmes objets ; les flux lus sont des copies, avec infoHash, privateTorrent et packFiles. downloadUrl reste
 * présent en mémoire uniquement, jamais dans une réponse exposée.
 */
export async function resolveInfoHashes(streams: RawStream[], opts: EnrichOptions): Promise<RawStream[]> {
  const limit = Number.isFinite(opts.topN) ? Math.max(0, Math.floor(opts.topN)) : 0;
  const candidates: Candidate[] = [];
  streams.forEach((stream, index) => {
    if (stream.infoHash !== undefined || stream.downloadUrl === undefined) return;
    candidates.push({
      index,
      url: stream.downloadUrl,
      guid: opts.guidOf === undefined ? stream.guid : opts.guidOf(stream),
    });
  });

  const out = [...streams];
  await runLimited(candidates.slice(0, limit), ENRICH_CONCURRENCY, async (candidate) => {
    const stream = streams[candidate.index];
    if (stream === undefined) return;
    try {
      const fetched = await fetchTorrent(candidate.url, {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
        cache: opts.cache,
        guid: candidate.guid,
      });
      out[candidate.index] = applyTorrent(stream, fetched);
    } catch {
      // Échec isolé : le flux reste sans infoHash et les autres sont traités normalement.
    }
  });
  return out;
}
