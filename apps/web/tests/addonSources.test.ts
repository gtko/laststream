import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpFn, HttpRequest, HttpResponse } from '../src/sources/debrid/http';

// TMDB / IMDb / serveur ne doivent jamais être appelés pour un titre d'addon : on espionne les portes d'entrée.
vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, fetchStreamsResult: vi.fn(async () => { throw new Error('serveur appelé'); }) };
});
vi.mock('../src/data/imdbResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/imdbResolve')>();
  return { ...actual, resolveImdbId: vi.fn(async () => { throw new Error('resolveImdbId appelé'); }) };
});
vi.mock('../src/data/lt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/lt')>();
  return { ...actual, tmdb: vi.fn(async () => { throw new Error('tmdb appelé'); }) };
});

const { fetchAddonMeta, loadAddonSources } = await import('../src/sources/addonSources');
const sources = await import('../src/data/sources');
const imdbResolve = await import('../src/data/imdbResolve');
const lt = await import('../src/data/lt');

const ENTRY = { manifestUrl: 'https://addon.test/cfg/manifest.json', name: 'Mon Addon' };
const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const ok = (body: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: bytes(body) });

function http(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const calls: string[] = [];
  const fn: HttpFn = async (req) => { calls.push(req.url); return handler(req); };
  return { fn, calls };
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

const noTmdb = () => {
  expect(imdbResolve.resolveImdbId).not.toHaveBeenCalled();
  expect(sources.fetchStreamsResult).not.toHaveBeenCalled();
  expect(lt.tmdb).not.toHaveBeenCalled();
};

describe('loadAddonSources', () => {
  it('flux url et infoHash : seule la route stream de l’addon est appelée (id encodé)', async () => {
    const h = http(() => ok({ streams: [
      { name: 'Direct', title: 'Ep 1 1080p', url: 'https://cdn.test/a.mp4' },
      { name: 'Torrent', title: 'Ep 1', infoHash: 'a'.repeat(40) },
    ] }));
    const views = await loadAddonSources(ENTRY, 'anime', 'fk:a/b', h.fn);
    expect(h.calls).toEqual(['https://addon.test/cfg/stream/anime/fk%3Aa%2Fb.json']);
    expect(views.some((v) => v.stream.url === 'https://cdn.test/a.mp4')).toBe(true);
    // Sans débrideur sur l'appareil, le torrent sans lien n'est pas proposé.
    expect(views.some((v) => v.stream.infoHash)).toBe(false);
    noTmdb();
  });

  it('500 : liste vide, sans exception', async () => {
    expect(await loadAddonSources(ENTRY, 'movie', 'fk:1', http(() => ok({}, 500)).fn)).toEqual([]);
    noTmdb();
  });

  it('rejet CORS / réseau : liste vide', async () => {
    const h = http(() => { throw new TypeError('Failed to fetch'); });
    expect(await loadAddonSources(ENTRY, 'movie', 'fk:1', h.fn)).toEqual([]);
    noTmdb();
  });

  it('corps invalide ou trop gros : liste vide', async () => {
    expect(await loadAddonSources(ENTRY, 'movie', 'fk:1', http(() => ok('<html>')).fn)).toEqual([]);
    const big = { status: 200, headers: {}, body: new Uint8Array(40 * 1024 * 1024) };
    expect(await loadAddonSources(ENTRY, 'movie', 'fk:1', http(() => big).fn)).toEqual([]);
  });

  it('adresse d’addon invalide : liste vide, aucun appel', async () => {
    const h = http(() => ok({ streams: [] }));
    expect(await loadAddonSources({ manifestUrl: 'pas une url', name: 'x' }, 'movie', 'fk:1', h.fn)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe('fetchAddonMeta', () => {
  it('fiche complète : nom, fond, genres, épisodes ; route meta encodée', async () => {
    const h = http(() => ok({ meta: {
      id: 'fk:1', type: 'series', name: 'Mon anime', poster: 'https://i.test/p.jpg', background: 'https://i.test/b.jpg', description: 'Résumé',
      genres: ['Action', 3, ''], releaseInfo: '2020', imdb_id: 'tt123',
      videos: [{ id: 'fk:1:1:1', title: 'Pilote', season: 1, episode: 1, released: '2020-01-01' }, { id: 'fk:1:1:2', name: 'Suite', season: '1', number: 2 }, { title: 'sans id' }],
    } }));
    const r = await fetchAddonMeta(ENTRY, 'anime', 'fk:1', h.fn);
    expect(h.calls).toEqual(['https://addon.test/cfg/meta/anime/fk%3A1.json']);
    expect(r.error).toBeUndefined();
    expect(r.meta).toMatchObject({ id: 'fk:1', name: 'Mon anime', background: 'https://i.test/b.jpg', description: 'Résumé', genres: ['Action'], releaseInfo: '2020', imdb_id: 'tt123' });
    expect(r.meta?.videos).toEqual([
      { id: 'fk:1:1:1', title: 'Pilote', season: 1, episode: 1, released: '2020-01-01' },
      { id: 'fk:1:1:2', title: 'Suite', season: 1, episode: 2 },
    ]);
    noTmdb();
  });

  it('500, CORS, corps invalide, fiche sans nom : jamais de rejet, erreur renvoyée', async () => {
    expect((await fetchAddonMeta(ENTRY, 'movie', 'fk:1', http(() => ok({}, 500)).fn)).error).toBe('http');
    expect((await fetchAddonMeta(ENTRY, 'movie', 'fk:1', http(() => { throw new TypeError('cors'); }).fn)).error).toBe('network');
    expect((await fetchAddonMeta(ENTRY, 'movie', 'fk:1', http(() => ok('nope')).fn)).error).toBe('invalid');
    expect((await fetchAddonMeta(ENTRY, 'movie', 'fk:1', http(() => ok({ meta: { id: 'x' } })).fn)).error).toBe('invalid');
    expect((await fetchAddonMeta({ manifestUrl: '', name: 'x' }, 'movie', 'fk:1', http(() => ok({})).fn)).error).toBe('invalid');
  });

  it('addon sans ressource meta : pas d’appel, pas d’erreur', async () => {
    const h = http(() => ok({}));
    expect(await fetchAddonMeta({ ...ENTRY, resources: { meta: false, stream: true } }, 'movie', 'fk:1', h.fn)).toEqual({});
    expect(h.calls).toEqual([]);
  });
});
