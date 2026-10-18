// Titres masqués sur le serveur : liste paginée en mémoire, filtre de l'accueil inchangé, envois par lots, plus d'écriture homeHidden*.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { apiHiddenBackend } from '../src/data/hiddenApi';
import {
  flushSync, HOME_FILTERS_KEY_PREFIX, hiddenIdle, hiddenOnServer, hiddenTitles, hideTitle, isHiddenKey, keepVisible, loadServerHidden,
  resetFiltersCache, restoreHidden, SERVER_BATCH, setFiltersPusher, setGenreBanned, setHiddenBackend, setServerRetryDelay, unhideTitles,
  applyAccountFilters, type HiddenBackend, type HiddenEntry,
} from '../src/data/homeFilters';

const entry = (i: number, over: Partial<HiddenEntry> = {}): HiddenEntry => ({ key: `movie:${1000 + i}`, title: 'Titre ' + i, poster: '/p' + i + '.jpg', addedAt: 1700000000000 + i, ...over });

/** Serveur factice : liste en mémoire, journal des appels. */
function fakeBackend(initial: HiddenEntry[] = []) {
  const store = new Map(initial.map((e) => [e.key, e]));
  const log: Array<{ op: 'put' | 'remove'; n: number }> = [];
  const backend: HiddenBackend = {
    load: async () => [...store.values()].sort((a, b) => a.addedAt - b.addedAt),
    put: async (_id, entries) => { log.push({ op: 'put', n: entries.length }); entries.forEach((e) => { if (!store.has(e.key)) store.set(e.key, e); }); return true; },
    remove: async (_id, keys) => { log.push({ op: 'remove', n: keys.length }); keys.forEach((k) => store.delete(k)); return true; },
  };
  return { backend, store, log };
}

beforeEach(() => {
  localStorage.clear();
  resetFiltersCache();
  setFiltersPusher(null);
  setServerRetryDelay(1);
});
afterEach(() => {
  resetFiltersCache();
  vi.unstubAllGlobals();
});

describe('titres masqués via l’API', () => {
  it('charge la liste du serveur en mémoire et filtre l’accueil comme avant', async () => {
    const fake = fakeBackend([entry(1), entry(2)]);
    setHiddenBackend(fake.backend);
    expect(await loadServerHidden('default')).toBe(true);
    expect(hiddenOnServer()).toBe(true);
    expect(hiddenTitles().map((h) => h.key)).toEqual(['movie:1001', 'movie:1002']);
    expect(isHiddenKey('movie:1001')).toBe(true);
    const items = [{ type: 'movie' as const, id: 1001 }, { type: 'movie' as const, id: 5 }, { type: 'tv' as const, id: 1002 }];
    expect(keepVisible(items).map((i) => i.id)).toEqual([5, 1002]);
  });

  it('masquer / réafficher / restaurer passent par l’API et restent en mémoire', async () => {
    const fake = fakeBackend();
    setHiddenBackend(fake.backend);
    await loadServerHidden('default');
    expect(hideTitle({ key: 'movie:42', title: 'Alien', poster: '/a.jpg' })).toBe(true);
    expect(isHiddenKey('movie:42')).toBe(true);
    await hiddenIdle();
    expect(fake.store.has('movie:42')).toBe(true);
    const removed = unhideTitles(['movie:42']);
    expect(removed).toHaveLength(1);
    expect(isHiddenKey('movie:42')).toBe(false);
    await hiddenIdle();
    expect(fake.store.has('movie:42')).toBe(false);
    expect(restoreHidden(removed)).toBe(true);
    await hiddenIdle();
    expect(fake.store.get('movie:42')?.addedAt).toBe(removed[0].addedAt);
  });

  it('plusieurs milliers de titres : filtre en mémoire, envois par lots de 500 au plus', async () => {
    const many = Array.from({ length: 3200 }, (_, i) => entry(i));
    const fake = fakeBackend(many);
    setHiddenBackend(fake.backend);
    await loadServerHidden('default');
    expect(hiddenTitles()).toHaveLength(3200);
    const kept = keepVisible(many.slice(0, 5).map((e, i) => ({ type: 'movie' as const, id: 1000 + i })));
    expect(kept).toEqual([]);
    unhideTitles(many.map((e) => e.key));
    await hiddenIdle();
    expect(fake.log.filter((l) => l.op === 'remove').map((l) => l.n)).toEqual([500, 500, 500, 500, 500, 500, 200]);
    expect(SERVER_BATCH).toBe(500);
    expect(hiddenTitles()).toHaveLength(0);
  });

  it('n’écrit plus homeHidden* dans les réglages ; genres et séries vues continuent d’y passer', async () => {
    vi.useFakeTimers();
    const pusher = vi.fn(async (_id: string, _settings: Record<string, unknown>) => true);
    setFiltersPusher(pusher);
    setHiddenBackend(fakeBackend().backend);
    await loadServerHidden('default');
    hideTitle({ key: 'movie:7', title: 'X' });
    setGenreBanned([27], true);
    flushSync();
    const sent = pusher.mock.calls.flatMap((c) => Object.keys(c[1]));
    expect(sent).toContain('homeGenres');
    expect(sent.some((k) => k.startsWith('homeHidden'))).toBe(false);
    vi.useRealTimers();
  });

  it('applyAccountFilters ignore les anciens morceaux homeHidden du compte (le serveur les a importés)', async () => {
    const fake = fakeBackend([entry(1)]);
    setHiddenBackend(fake.backend);
    await loadServerHidden('default');
    applyAccountFilters('default', { homeGenres: [16], homeHidden: 1, homeHidden0: [{ key: 'movie:99', title: 'Ancien', poster: '', addedAt: 1 }] });
    expect(hiddenTitles().map((h) => h.key)).toEqual(['movie:1001']);
  });

  it('les masqués gardés dans ce navigateur par une ancienne version partent au compte puis quittent le stockage local', async () => {
    localStorage.setItem(HOME_FILTERS_KEY_PREFIX + 'default', JSON.stringify({ hidden: [entry(9)], genres: [35], completed: [] }));
    const fake = fakeBackend([entry(1)]);
    setHiddenBackend(fake.backend);
    await loadServerHidden('default');
    await hiddenIdle();
    expect(fake.store.has('movie:1009')).toBe(true);
    expect(hiddenTitles().map((h) => h.key).sort()).toEqual(['movie:1001', 'movie:1009']);
    const stored = JSON.parse(localStorage.getItem(HOME_FILTERS_KEY_PREFIX + 'default')!);
    expect(stored.hidden).toEqual([]);
    expect(stored.genres).toEqual([35]);
  });

  it('serveur injoignable : on reste sur le stockage local par réglages', async () => {
    setHiddenBackend({ load: async () => { throw new Error('réseau'); }, put: async () => true, remove: async () => true });
    expect(await loadServerHidden('default')).toBe(false);
    expect(hiddenOnServer()).toBe(false);
    expect(hideTitle({ key: 'movie:3', title: 'Local' })).toBe(true);
    expect(isHiddenKey('movie:3')).toBe(true);
  });

  it('un envoi refusé est retenté une fois', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue(true);
    setHiddenBackend({ load: async () => [], put, remove: async () => true });
    await loadServerHidden('default');
    hideTitle({ key: 'movie:5', title: 'Retry' });
    await hiddenIdle();
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('client de l’API paginée', () => {
  it('lit toutes les pages (curseur) et rend la liste du plus ancien au plus récent', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
    reloadSettings();
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      const u = new URL(String(url));
      const cursor = u.searchParams.get('cursor');
      const page = (items: unknown[], next: string | null) => new Response(JSON.stringify({ items, total: 3, nextCursor: next }), { status: 200 });
      if (!cursor) return page([{ key: 'movie:3', title: 'C', poster: null, addedAt: 3000 }, { key: 'tv:2', title: 'B', poster: '/b.jpg', addedAt: 2000 }], 'cur1');
      return page([{ key: 'movie:1', title: 'A', poster: null, addedAt: '2020-01-01T00:00:00Z' }, { key: 'bad', title: 'Ignoré', poster: null, addedAt: 1 }], null);
    }));
    const list = await apiHiddenBackend.load('p1');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/user/profiles/p1/hidden?limit=500');
    expect(urls[1]).toContain('cursor=cur1');
    expect(list.map((e) => e.key)).toEqual(['movie:1', 'tv:2', 'movie:3']);
    expect(list[1].poster).toBe('/b.jpg');
  });

  it('envoie PUT /hidden et POST /hidden/remove', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ total: 1, removed: 1 }), { status: 200 });
    }));
    await apiHiddenBackend.put('p1', [entry(1)]);
    await apiHiddenBackend.remove('p1', ['movie:1001']);
    expect(calls[0]).toMatchObject({ method: 'PUT' });
    expect(calls[0].url).toBe('http://localhost:7000/user/profiles/p1/hidden');
    expect(JSON.parse(calls[0].body!).entries[0]).toMatchObject({ key: 'movie:1001', title: 'Titre 1', poster: '/p1.jpg', addedAt: 1700000000001 });
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1].url).toBe('http://localhost:7000/user/profiles/p1/hidden/remove');
    expect(JSON.parse(calls[1].body!)).toEqual({ keys: ['movie:1001'] });
  });
});
