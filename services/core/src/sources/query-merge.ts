import type { RawStream } from '../types.js';
import { redactUrl } from './http.js';

/** Requêtes d'une même recherche exécutées en parallèle, au plus. */
export const MAX_PARALLEL_QUERIES = 3;

/** Budget global par défaut des requêtes texte d'une recherche Torznab ou Jackett, en millisecondes. */
export const SEARCH_BUDGET_MS = 12_000;

/** Flux renvoyé par une requête, avec ses alias hors infoHash (guid, lien de téléchargement sans secret). */
export interface Candidate {
  stream: RawStream;
  aliases: string[];
}

/**
 * Exécute les tâches avec au plus `limit` en parallèle. Les tâches démarrent dans l'ordre des éléments ; les
 * résultats (réussites ou échecs) gardent cet ordre. Ne rejette jamais.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Alias d'un release hors infoHash : guid ou lien de téléchargement, masqué (clé API retirée). Les magnets sont
 * exclus : leur infoHash sert de clé.
 */
export function releaseAliases(...values: unknown[]): string[] {
  const aliases: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase().startsWith('magnet:')) continue;
    aliases.push(redactUrl(trimmed));
  }
  return aliases;
}

function keysOf(stream: RawStream, aliases: readonly string[]): string[] {
  const keys = aliases.map((alias) => `alias:${alias}`);
  if (stream.infoHash !== undefined) keys.push(`hash:${stream.infoHash.toLowerCase()}`);
  else if (stream.magnet !== undefined) keys.push(`magnet:${stream.magnet}`);
  return keys;
}

/**
 * Fusionne les résultats de plusieurs requêtes (une liste par requête, dans l'ordre d'envoi). Un release déjà vu
 * dans une requête précédente (même infoHash, ou même alias) n'est pas repris : son flux garde la première
 * occurrence et reçoit l'union des noms d'indexeurs. Les doublons à l'intérieur d'une même requête sont conservés.
 */
export function mergeRequestResults(batches: readonly (readonly Candidate[])[]): RawStream[] {
  const owner = new Map<string, RawStream>();
  const merged: RawStream[] = [];
  for (const batch of batches) {
    const fresh: { keys: string[]; stream: RawStream }[] = [];
    for (const { stream, aliases } of batch) {
      const keys = keysOf(stream, aliases);
      let kept: RawStream | undefined;
      for (const key of keys) kept ??= owner.get(key);
      if (kept !== undefined) {
        if (stream.indexers !== undefined) {
          kept.indexers = [...new Set([...(kept.indexers ?? []), ...stream.indexers])];
        }
        for (const key of keys) if (!owner.has(key)) owner.set(key, kept);
        continue;
      }
      merged.push(stream);
      fresh.push({ keys, stream });
    }
    for (const { keys, stream } of fresh) {
      for (const key of keys) owner.set(key, stream);
    }
  }
  return merged;
}
