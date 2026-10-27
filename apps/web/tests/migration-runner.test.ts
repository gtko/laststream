// Migration : moteur (reprise après coupure sans doublon, rapport), écrivains, addons importés, marques du profil.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJob, createJob, isTransient, loadJob, reportOf, reportText, runJob, saveJob, type RunDeps } from '../src/data/migration/runner';
import { CINEMETA, createResolver, createVideoLister, NotFound } from '../src/data/migration/resolve';
import type { MigrationSink, ResolvedTitle } from '../src/data/migration/sink';
import { animeKeys, effectiveWatchedAt, rememberWatchDate } from '../src/data/migration/profileMarks';
import { importAddons, importedAddons, manifestUrlOf, precheck } from '../src/data/migration/addons';
import { pruneAddonCatalogs, readAddonCatalogs } from '../src/data/addonCatalog';
import { STORE_UA_MARK } from '../src/data/distribution';
import { UserApiError } from '../src/data/userApi';
import type { MigrationItem } from '../src/data/migration/types';

const item = (uid: string, over: Partial<MigrationItem> = {}): MigrationItem => ({ uid, action: 'library', type: 'movie', ref: { tmdb: Number(uid.replace(/\D/g, '')) || 1 }, title: 'T' + uid, ...over });

function fakeSink(over: Partial<MigrationSink> = {}) {
  const writes: string[] = [];
  const sink: MigrationSink = {
    hasLists: true,
    library: vi.fn(async (t: ResolvedTitle) => { writes.push('lib:' + t.id); }),
    ensureList: vi.fn(async (_l, name, known) => known || 'list-' + name),
    listItem: vi.fn(async (id: string, t: ResolvedTitle) => { writes.push('list:' + id + ':' + t.id); return false; }),
    watched: vi.fn(async (t: ResolvedTitle, eps) => { writes.push('watched:' + t.id + (eps ? ':' + eps.length : '')); }),
    progress: vi.fn(async (t: ResolvedTitle, ep, pos) => { writes.push('progress:' + t.id + ':' + pos); }),
    ...over,
  };
  return { sink, writes };
}

const deps = (sink: MigrationSink, over: Partial<RunDeps> = {}): RunDeps => ({
  sink,
  resolve: async (i) => ({ type: i.type, id: i.ref.tmdb ?? 0, title: i.title, poster: '' }),
  videos: async () => [],
  ...over,
});

beforeEach(() => localStorage.clear());

describe('runJob', () => {
  it('écrit bibliothèque et listes, puis vus, puis progression ; rapport complet', async () => {
    const job = createJob({ source: 'stremio', items: [
      item('p1', { action: 'progress', positionSec: 60, durationSec: 600 }),
      item('w2', { action: 'watched' }),
      item('l3', { action: 'list', list: 'watchlist' }),
      item('b4'),
      item('b4'), // doublon de la source
      item('s5', { skipReason: 'Chaîne TV' }),
    ] }, 'pr1');
    const { sink, writes } = fakeSink();
    const done = await runJob(job, deps(sink));
    expect(writes).toEqual(['lib:4', 'list:list-À voir · Stremio:3', 'watched:2', 'progress:1:60']);
    expect(done.status).toBe('done');
    const rep = reportOf(done);
    expect(rep).toMatchObject({ total: 5, ok: 4, skipped: 1, failed: 0, byAction: { library: 1, list: 1, watched: 1, progress: 1 } });
    expect(rep.problems).toEqual([{ uid: 's5', status: 'skipped', action: 'library', title: 'Ts5', reason: 'Chaîne TV' }]);
    expect(reportText(rep, 0)).toMatch(/Ignoré · Ts5 · Chaîne TV/);
  });

  it('coupure réseau : pause, journal enregistré ; la reprise ne réécrit rien de confirmé', async () => {
    const job = createJob({ source: 'nuvio', items: [item('a1'), item('a2'), item('a3')] }, 'pr1');
    let fail = true;
    const { sink, writes } = fakeSink({
      library: vi.fn(async (t: ResolvedTitle) => {
        if (t.id === 2 && fail) throw new UserApiError(0, 'network');
        writes.push('lib:' + t.id);
      }),
    });
    const paused = await runJob(job, deps(sink));
    expect(paused.status).toBe('paused');
    expect(paused.pausedReason).toMatch(/sans doublon/);
    const stored = loadJob('pr1');
    expect(stored?.results).toEqual({ a1: { s: 'ok' } });
    fail = false;
    const resumed = await runJob(stored!, deps(sink));
    expect(resumed.status).toBe('done');
    expect(writes).toEqual(['lib:1', 'lib:2', 'lib:3']);
  });

  it('titre introuvable et refus serveur : échecs avec raison, l’import continue', async () => {
    const job = createJob({ source: 'simkl', items: [item('x1'), item('x2'), item('x3')] }, 'pr1');
    const { sink } = fakeSink({ library: vi.fn(async (t: ResolvedTitle) => { if (t.id === 2) throw new UserApiError(403, 'forbidden'); }) });
    const done = await runJob(job, deps(sink, { resolve: async (i) => { if (i.uid === 'x1') throw new NotFound('Introuvable sur TMDB (IMDb tt1)'); return { type: 'movie', id: Number(i.uid.slice(1)), title: i.title, poster: '' }; } }));
    expect(done.results).toEqual({ x1: { s: 'failed', r: 'Introuvable sur TMDB (IMDb tt1)' }, x2: { s: 'failed', r: expect.stringMatching(/ce profil/) }, x3: { s: 'ok' } });
  });

  it('sans listes : le titre rejoint la bibliothèque, avec une remarque', async () => {
    const job = createJob({ source: 'stremio', items: [item('f1', { action: 'list', list: 'favorites' })] }, 'pr1');
    const { sink, writes } = fakeSink({ hasLists: false });
    const done = await runJob(job, deps(sink));
    expect(writes).toEqual(['lib:1']);
    expect(done.results.f1.r).toMatch(/bibliothèque/);
  });

  it('liste déjà existante pour la reprise : réutilisée, titre déjà présent ignoré', async () => {
    const job = createJob({ source: 'stremio-file', items: [item('l1', { action: 'list', list: 'watchlist' })] }, 'pr1');
    job.lists.watchlist = 'L-42';
    const { sink } = fakeSink({ listItem: vi.fn(async () => true) });
    const done = await runJob(job, deps(sink));
    expect(sink.ensureList).toHaveBeenCalledWith('watchlist', 'À voir · Stremio', 'L-42');
    expect(done.results.l1).toEqual({ s: 'skipped', r: 'Déjà dans la liste « À voir · Stremio »' });
  });

  it('série Stremio : épisodes décodés depuis la liste Cinemeta ; anime et date gardés', async () => {
    const job = createJob({ source: 'stremio', items: [item('g7', { action: 'watched', type: 'tv', ref: { imdb: 'tt7' }, stremioWatched: 'tt7:1:1:1:eJxjBAAAAgAC', anime: true, at: 1_600_000_000_000 })] }, 'local');
    const { sink, writes } = fakeSink();
    await runJob(job, deps(sink, {
      resolve: async () => ({ type: 'tv', id: 70, title: 'G', poster: '', imdb: 'tt7' }),
      videos: async (imdb) => (imdb === 'tt7' ? [{ id: 'tt7:1:1', season: 1, episode: 1 }] : []),
    }));
    expect(writes).toEqual(['watched:70:1']);
    expect(animeKeys().has('tv:70')).toBe(true);
    expect(effectiveWatchedAt('tv:70', Date.now())).toBe(1_600_000_000_000);
  });

  it('arrêt demandé : pause avant l’élément suivant', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const job = await runJob(createJob({ source: 'plex', items: [item('a1')] }, 'pr1'), deps(fakeSink().sink, { signal: ctrl.signal }));
    expect(job.status).toBe('paused');
  });

  it('journal : effacé à l’abandon ; illisible ignoré', () => {
    const job = createJob({ source: 'plex', items: [] }, 'pr9');
    saveJob(job);
    expect(loadJob('pr9')).not.toBeNull();
    clearJob('pr9');
    expect(loadJob('pr9')).toBeNull();
    localStorage.setItem('laststream.migration.job:pr8', '{oops');
    expect(loadJob('pr8')).toBeNull();
  });

  it('erreurs transitoires', () => {
    expect(isTransient(new UserApiError(0, 'network'))).toBe(true);
    expect(isTransient(new UserApiError(503, 'x'))).toBe(true);
    expect(isTransient(new UserApiError(403, 'x'))).toBe(false);
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('résolution TMDB', () => {
  it('cherche par IMDb puis TVDB, une fois par titre ; type inconnu accepté', async () => {
    const tmdbFn = vi.fn(async (path: string) => {
      if (path === 'find/tt1') return { movie_results: [], tv_results: [] };
      if (path === 'find/99') return { tv_results: [{ id: 5, name: 'Show', poster_path: '/p.jpg', first_air_date: '2020-01-01' }] };
      return { movie_results: [{ id: 8, title: 'Film', poster_path: '/f.jpg', release_date: '1999-03-31' }] };
    });
    const resolve = createResolver(tmdbFn);
    expect(await resolve(item('a', { type: 'tv', ref: { imdb: 'tt1', tvdb: 99 } }))).toEqual({ type: 'tv', id: 5, title: 'Show', poster: '/p.jpg', year: '2020', imdb: 'tt1' });
    expect(await resolve(item('b', { ref: { imdb: 'tt2' }, typeUnknown: true }))).toMatchObject({ type: 'movie', id: 8, year: '1999' });
    await resolve(item('c', { ref: { imdb: 'tt2' }, typeUnknown: true }));
    expect(tmdbFn).toHaveBeenCalledTimes(3);
    await expect(resolve(item('d', { type: 'movie', ref: { imdb: 'tt1' } }))).rejects.toBeInstanceOf(NotFound);
    expect(await resolve(item('e', { ref: { tmdb: 603 }, title: 'Matrix' }))).toEqual({ type: 'movie', id: 603, title: 'Matrix', poster: '' });
  });

  it('liste des épisodes Cinemeta', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify({ meta: { videos: [{ id: 'tt7:1:2', season: 1, number: 2, released: '2020-01-01T00:00:00Z' }] } })));
    const list = createVideoLister(fetchFn);
    expect(await list('tt7')).toEqual([{ id: 'tt7:1:2', season: 1, episode: 2, released: '2020-01-01T00:00:00Z' }]);
    await list('tt7');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][0]).toBe(CINEMETA + 'tt7.json');
  });
});

describe('marques du profil', () => {
  it('date importée : remplacée par une date plus récente que l’import', () => {
    rememberWatchDate('movie:1', 1000, 5_000_000);
    expect(effectiveWatchedAt('movie:1', 0)).toBe(1000);
    expect(effectiveWatchedAt('movie:1', 5_100_000)).toBe(1000);
    expect(effectiveWatchedAt('movie:1', 50_000_000)).toBe(50_000_000);
    expect(effectiveWatchedAt('movie:2', 7)).toBe(7);
  });
});

describe('import des addons', () => {
  const manifest = (over: Record<string, unknown> = {}) => ({ id: 'x', name: 'Catalogues X', resources: ['catalog', 'meta'], types: ['movie'], catalogs: [{ type: 'movie', id: 'top', name: 'Top' }], ...over });
  afterEach(() => { Object.defineProperty(navigator, 'userAgent', { value: 'jsdom', configurable: true }); });

  it('journal par addon : non choisi, officiel, local, injoignable, sources seules, ajouté', async () => {
    const addons = [
      { manifestUrl: 'https://skip.test/manifest.json', name: 'Pas choisi' },
      { manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json', name: 'Cinemeta', official: true },
      { manifestUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', name: 'Local' },
      { manifestUrl: 'https://down.test/manifest.json', name: 'En panne' },
      { manifestUrl: 'https://streams.test/k=SECRET/manifest.json', name: 'Flux' },
      { manifestUrl: 'stremio://cats.test/cfg', name: 'Catalogues' },
    ];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith('https://down.test')) return new Response('nope', { status: 500 });
      if (url.startsWith('https://streams.test')) return new Response(JSON.stringify(manifest({ resources: ['stream'], catalogs: [] })));
      return new Response(JSON.stringify(manifest()));
    });
    const picked = new Set(addons.slice(1).map((a) => a.manifestUrl));
    const log = await importAddons(addons, picked, { fetchFn, now: 1 });
    expect(log.map((l) => [l.name, l.outcome])).toEqual([
      ['Pas choisi', 'ignored'], ['Cinemeta', 'ignored'], ['Local', 'ignored'], ['En panne', 'failed'], ['Catalogues X', 'ignored'], ['Catalogues X', 'added'],
    ]);
    expect(log[3].reason).toMatch(/HTTP 500/);
    expect(log[4].reason).toMatch(/sources de lecture/);
    expect(JSON.stringify(log)).not.toMatch(/SECRET|https?:/);
    expect(fetchFn).toHaveBeenCalledTimes(3); // ni l'addon officiel, ni l'adresse locale, ni l'addon non choisi
    const imported = importedAddons();
    expect(imported).toHaveLength(1);
    expect(imported[0][1]).toMatchObject({ manifestUrl: 'https://cats.test/cfg/manifest.json', home: false, imported: true });
    // Un enregistrement des sources serveur ne retire pas l'addon importé.
    pruneAddonCatalogs([]);
    expect(Object.keys(readAddonCatalogs())).toHaveLength(1);
    // Ré-import : déjà présent.
    expect(precheck(addons[5], readAddonCatalogs())).toMatch(/Déjà présent/);
  });

  it('adresses de manifest', () => {
    expect(manifestUrlOf('stremio://a.test/x/')).toBe('https://a.test/x/manifest.json');
    expect(manifestUrlOf('ftp://a.test')).toBe('');
  });

  it('jamais dans une version de store', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 ' + STORE_UA_MARK + 'play', configurable: true });
    const fetchFn = vi.fn();
    expect(await importAddons([{ manifestUrl: 'https://a.test/manifest.json', name: 'A' }], new Set(['https://a.test/manifest.json']), { fetchFn })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
