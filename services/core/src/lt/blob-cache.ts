import { createHash } from 'node:crypto';
import { type CacheProvider, REFRESH_RETRY_MS } from '../cache/ttl-cache.js';
import type { LtContext } from './context.js';
import type { MetaBlobStore } from './meta.js';

/**
 * Valeur amont gardée dans le store de blobs (R2 sous Workers, ODY-297 lot D) plutôt que dans le KV. Elle est relue
 * depuis le store tant qu'elle est fraîche, et réécrite seulement quand elle manque ou a expiré : une écriture par durée
 * de vie, jamais à chaque lecture. La mémoire de l'isolat sert devant, sans niveau 2 KV. Un échec amont alors qu'un objet
 * expiré existe sert cet objet périmé, avec un nouvel essai après REFRESH_RETRY_MS. Sans store (Node) : mémoire seule.
 */

/** Ce que garde la mémoire : la valeur, et si elle est périmée (servie faute de mieux). */
interface Loaded<T> {
  value: T;
  stale: boolean;
}

/** Objet lu dans le store : la valeur, et s'il est encore frais. */
interface Stored<T> {
  value: T;
  fresh: boolean;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Lit l'objet d'une clé. Absent, illisible ou store en panne : absent (jamais de levée). */
async function readStored<T>(blobs: MetaBlobStore, key: string): Promise<Stored<T> | undefined> {
  try {
    const blob = await blobs.get(key);
    if (blob === undefined) return undefined;
    return { value: JSON.parse(blob.body) as T, fresh: blob.expiresAt > Date.now() };
  } catch {
    return undefined;
  }
}

/** Écrit la valeur avec son empreinte et son échéance. Store en panne : la valeur reste en mémoire seulement. */
async function writeStored<T>(blobs: MetaBlobStore, key: string, value: T, ttlMs: number): Promise<void> {
  try {
    const body = JSON.stringify(value) as string | undefined;
    if (body === undefined) return;
    await blobs.put(key, { body, etag: sha256(body), expiresAt: Date.now() + ttlMs, ttl: ttlMs });
  } catch {
    /* store indisponible : la valeur reste servie depuis la mémoire */
  }
}

/** Valeur d'une clé : le store si elle y est fraîche ; sinon l'amont, réécrite dans le store. */
async function fromStore<T>(blobs: MetaBlobStore | undefined, key: string, ttlMs: number, load: () => Promise<T>): Promise<Loaded<T>> {
  if (blobs === undefined) return { value: await load(), stale: false };
  const stored = await readStored<T>(blobs, key);
  if (stored?.fresh === true) return { value: stored.value, stale: false };
  let value: T;
  try {
    value = await load();
  } catch (err) {
    if (stored === undefined) throw err;
    return { value: stored.value, stale: true };
  }
  await writeStored(blobs, key, value, ttlMs);
  return { value, stale: false };
}

/**
 * Lit `load` à travers le store de blobs de l'application (clé `key`, durée de vie `ttlMs`). `provider` ne sert qu'aux
 * compteurs. Pas de niveau 2 KV, quel que soit le fournisseur.
 */
export async function cachedInBlobs<T>(ctx: LtContext, key: string, ttlMs: number, load: () => Promise<T>, provider: CacheProvider): Promise<T> {
  const loaded = await ctx.state.cache.get<Loaded<T>>(
    `blob:${key}`,
    (entry) => (entry.stale ? REFRESH_RETRY_MS : ttlMs),
    () => fromStore(ctx.blobs, key, ttlMs, load),
    { provider, l2: false, swr: true },
  );
  return loaded.value;
}
