// Résolveur de titre (ODY-220) : connu de l'app → mémoire locale enregistrée → TMDB.
import { describe, expect, it, vi } from 'vitest';
import type { MetaFetcher } from '../src/data/friendHistoryView';
import { createTitleResolver, TITLE_CACHE_KEY } from '../src/data/titleResolver';

const memoryStorage = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};

describe('résolveur de titre', () => {
  it('utilise d’abord le titre connu de l’app, sans réseau', async () => {
    const fetchMeta = vi.fn<MetaFetcher>();
    const r = createTitleResolver(fetchMeta, { storage: memoryStorage(), known: () => ({ title: 'Severance', poster: '/s.jpg' }) });
    expect(await r('tv', 95396)).toEqual({ title: 'Severance', poster_path: '/s.jpg' });
    expect(fetchMeta).not.toHaveBeenCalled();
  });

  it('enregistre un titre résolu par TMDB et ne le redemande plus, même après rechargement', async () => {
    const storage = memoryStorage();
    const fetchMeta = vi.fn<MetaFetcher>(async () => ({ name: 'The Bear', poster_path: '/b.jpg' }));
    expect(await createTitleResolver(fetchMeta, { storage })('tv', 136315)).toEqual({ name: 'The Bear', poster_path: '/b.jpg' });
    expect(JSON.parse(storage.data[TITLE_CACHE_KEY])['tv:136315']).toEqual({ t: 'The Bear', p: '/b.jpg' });
    const again = vi.fn<MetaFetcher>();
    expect(await createTitleResolver(again, { storage })('tv', 136315)).toEqual({ title: 'The Bear', poster_path: '/b.jpg' });
    expect(again).not.toHaveBeenCalled();
  });

  it('n’enregistre ni un échec réseau ni une réponse sans titre', async () => {
    const storage = memoryStorage();
    const failing = createTitleResolver(async () => { throw new Error('offline'); }, { storage });
    await expect(failing('movie', 1)).rejects.toThrow('offline');
    await createTitleResolver(async () => ({}), { storage })('movie', 2);
    expect(storage.data[TITLE_CACHE_KEY]).toBeUndefined();
  });

  it('borne la mémoire locale en gardant les plus récents, et ignore un stockage corrompu ou absent', async () => {
    const storage = memoryStorage();
    const r = createTitleResolver(async (_k, id) => ({ title: 'T' + id }), { storage, max: 2 });
    await r('movie', 1); await r('movie', 2); await r('movie', 3);
    expect(Object.keys(JSON.parse(storage.data[TITLE_CACHE_KEY]))).toEqual(['movie:2', 'movie:3']);
    const bad = memoryStorage({ [TITLE_CACHE_KEY]: '{pas du json' });
    expect(await createTitleResolver(async () => ({ title: 'X' }), { storage: bad })('movie', 9)).toEqual({ title: 'X' });
    expect(await createTitleResolver(async () => ({ title: 'Y' }), { storage: null })('movie', 9)).toEqual({ title: 'Y' });
  });
});
