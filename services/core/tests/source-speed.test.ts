import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LruCache } from '../src/cache/lru.js';
import { parseConfig as parseConfigBase } from '../src/config/schema.js';
import { packEpisodeCount, getStreams, getStreamsStatus, type PipelineContext, type PipelineResult } from '../src/pipeline.js';
import { releaseScope, repairMojibake, scopeCovers } from '../src/parse/scope.js';
import { collectStreams, clearUpstreamTasks } from '../src/sources/collect.js';
import type { FetchFn } from '../src/sources/http.js';
import { IndexerHealth } from '../src/sources/indexer-health.js';
import type { LocalProwlarr } from '../src/sources/local-prowlarr.js';
import { clearProwlarrDiscoveryCache, searchProwlarrDetailed, type ProwlarrSource } from '../src/sources/prowlarr.js';
import type { ContentRef } from '../src/types.js';

// Anciennes sources torrent (indexeurs, Prowlarr) : réactivées pour ces tests seulement (désactivées par défaut).
process.env.LASTADDON_LEGACY_INDEXERS = '1';

// Le Prowlarr local est désactivé par défaut : ces tests couvrent l'ancien mode, qui l'active explicitement.
const parseConfig = (input: Record<string, unknown> = {}) =>
  parseConfigBase({ autoProwlarr: true, ...input, localProwlarr: { enabled: true, ...(input.localProwlarr as object | undefined) } });

/* Vitesse des sources : recherche par indexeur à échéance douce, indexeurs lents en arrière-plan, packs de série,
 * provenances. Aucun réseau : fetch simulé, délais courts. */

const SOURCE: ProwlarrSource = { name: 'Prowlarr', baseUrl: 'https://prowlarr.example.com', apiKey: 'SPEED-KEY-1234' };
const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const EPISODE: ContentRef = { type: 'series', id: 'tt0903747:4:4', imdbId: 'tt0903747', season: 4, episode: 4 };
/** Politique « débrideur obligatoire » : les tests de pipeline configurent une clé AllDebrid factice (sinon aucun torrent n'est livré). */
const DEBRID = { service: 'alldebrid', apiKey: 'cle-factice-tests' };
const FAST_HASH = 'a'.repeat(40);
const SLOW_HASH = 'b'.repeat(40);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const indexer = (id: number, name: string, withId = false) => ({
  id,
  name,
  protocol: 'torrent',
  enable: true,
  privacy: 'public',
  capabilities: { movieSearchParams: withId ? ['q', 'imdbId'] : ['q'], tvSearchParams: ['q', 'season', 'ep'] },
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Faux Prowlarr : `search` reçoit l'URL de chaque recherche ; les requêtes sont enregistrées dans l'ordre d'arrivée. */
function fakeProwlarr(indexers: unknown[], search: (url: URL) => Promise<Response> | Response) {
  const searches: URL[] = [];
  const mock = vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/api/v1/indexer') return Promise.resolve(json(indexers));
    if (url.pathname === '/api/v1/search') {
      searches.push(url);
      return Promise.resolve(search(url));
    }
    return Promise.resolve(new Response('?', { status: 404 }));
  });
  return { fetch: mock as unknown as FetchFn, searches };
}

beforeEach(() => {
  clearProwlarrDiscoveryCache();
  clearUpstreamTasks();
});

describe('Prowlarr : échéance douce par indexeur', () => {
  const fastRelease = { title: 'Film.2024.1080p', indexer: 'Fast', indexerId: 1, infoHash: FAST_HASH, protocol: 'torrent' };
  const slowRelease = { title: 'Film.2024.2160p', indexer: 'Slow', indexerId: 2, infoHash: SLOW_HASH, protocol: 'torrent' };
  const route = (url: URL): Promise<Response> | Response => {
    if (url.searchParams.get('indexerIds') === '2') return sleep(250).then(() => json([slowRelease]));
    return json([fastRelease]);
  };

  it('rend les flux des indexeurs rapides à l’échéance, nomme les lents (pending) et fusionne leur suite dans done', async () => {
    const { fetch } = fakeProwlarr([indexer(1, 'Fast'), indexer(2, 'Slow')], route);

    const started = Date.now();
    const outcome = await searchProwlarrDetailed(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' }, softMs: 60, health: new IndexerHealth() });

    expect(Date.now() - started).toBeLessThan(200);
    expect(outcome.streams.map((stream) => stream.infoHash)).toEqual([FAST_HASH]);
    expect(outcome.pending).toEqual(['Slow']);
    expect(outcome.busy).toBe(true);
    const all = await outcome.done;
    expect(all.map((stream) => stream.infoHash).sort()).toEqual([FAST_HASH, SLOW_HASH]);
  });

  it('une seconde recherche identique reprend la recherche en cours : aucune requête de plus, résultat complet ensuite', async () => {
    const { fetch, searches } = fakeProwlarr([indexer(1, 'Fast'), indexer(2, 'Slow')], route);
    const opts = { fetch, titleInfo: { title: 'Film' }, softMs: 60, health: new IndexerHealth() };

    const first = await searchProwlarrDetailed(SOURCE, MOVIE, opts);
    const sent = searches.length;
    const second = await searchProwlarrDetailed(SOURCE, MOVIE, opts);
    expect(searches.length).toBe(sent);
    expect(second.pending).toEqual(['Slow']);
    await first.done;
    const third = await searchProwlarrDetailed(SOURCE, MOVIE, opts);
    expect(third.pending).toEqual([]);
    expect(third.streams).toHaveLength(2);
  });

  it('un indexeur lent d’après la latence moyenne (EWMA) ne retarde pas la réponse et part en premier', async () => {
    const health = new IndexerHealth();
    health.record('Prowlarr', 2, { ok: true, latencyMs: 9000 });
    const { fetch, searches } = fakeProwlarr([indexer(1, 'Fast'), indexer(2, 'Slow')], (url) =>
      url.searchParams.get('indexerIds') === '2' ? sleep(400).then(() => json([slowRelease])) : sleep(20).then(() => json([fastRelease])),
    );

    const started = Date.now();
    const outcome = await searchProwlarrDetailed(SOURCE, MOVIE, {
      fetch,
      titleInfo: { title: 'Film' },
      softMs: 2000,
      health,
    });

    expect(searches[0]?.searchParams.get('indexerIds')).toBe('2');
    // La réponse n'attend pas l'indexeur lent (400 ms), bien que l'échéance douce soit de 2 s.
    expect(Date.now() - started).toBeLessThan(300);
    expect(outcome.streams.map((stream) => stream.infoHash)).toEqual([FAST_HASH]);
    expect(outcome.pending).toEqual(['Slow']);
    await outcome.done;
  });

  it('rien d’arrivé à l’échéance : l’attente se prolonge jusqu’au premier résultat', async () => {
    const { fetch } = fakeProwlarr([indexer(2, 'Slow')], route);

    const outcome = await searchProwlarrDetailed(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' }, softMs: 150, health: new IndexerHealth() });

    expect(outcome.streams.map((stream) => stream.infoHash)).toEqual([SLOW_HASH]);
    expect(outcome.pending).toEqual([]);
  });

  it('sans softMs : attend tous les indexeurs', async () => {
    const { fetch } = fakeProwlarr([indexer(1, 'Fast'), indexer(2, 'Slow')], route);

    const outcome = await searchProwlarrDetailed(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' }, health: new IndexerHealth() });

    expect(outcome.streams).toHaveLength(2);
    expect(outcome.pending).toEqual([]);
  });
});

describe('Prowlarr : moins de requêtes par indexeur', () => {
  it('requêtes dédoublonnées ; l’id répond : pas de requête texte de plus pour un film', async () => {
    const release = { title: 'Film.2024.1080p', indexer: 'Alpha', indexerId: 1, infoHash: FAST_HASH, protocol: 'torrent' };
    const { fetch, searches } = fakeProwlarr([indexer(1, 'Alpha', true)], () => json([release]));

    await searchProwlarrDetailed(SOURCE, MOVIE, { fetch, titles: { titles: ['Film', 'Film'], year: 2024 }, health: new IndexerHealth() });

    expect(searches).toHaveLength(1);
    expect(searches[0]?.searchParams.has('imdbId')).toBe(true);
  });

  it('série : jamais deux fois la même requête pour un indexeur, intégrale seulement après l’id si rien n’est arrivé', async () => {
    const { fetch, searches } = fakeProwlarr([indexer(1, 'Beta')], () => json([]));

    await searchProwlarrDetailed(SOURCE, EPISODE, { fetch, titles: { titles: ['Breaking Bad'] }, health: new IndexerHealth() });

    const keys = searches.map((url) => url.searchParams.toString());
    expect(new Set(keys).size).toBe(keys.length);
    expect(searches.map((url) => url.searchParams.get('query'))).toEqual(
      expect.arrayContaining(['Breaking Bad S04', 'Breaking Bad S04E04', 'Breaking Bad Saison 4', 'Breaking Bad Intégrale']),
    );
  });
});

describe('Portée des packs de série', () => {
  it('Intégrale, Complete, S01-S05 et Saison N couvrent S04E04', () => {
    for (const name of [
      'Breaking Bad S04 MULTi 1080p',
      'Breaking Bad Saison 4 FRENCH',
      'Breaking Bad Saison 04 Complète Multi',
      'Breaking Bad Intégrale FRENCH mHD 720p',
      'Breaking Bad Complete Series 1080p',
      'Breaking Bad S01-S05 MULTi',
      'Breaking Bad Saisons 1 à 5',
    ]) {
      expect(scopeCovers(releaseScope(name), 4, 4), name).toBe(true);
    }
    expect(scopeCovers(releaseScope('Breaking Bad S05 MULTi'), 4, 4)).toBe(false);
  });

  it('titre UTF-8 relu en latin-1 (« IntÃ©grale ») : réparé, l’intégrale est reconnue', () => {
    expect(repairMojibake('Breaking Bad IntÃ©grale')).toBe('Breaking Bad Intégrale');
    expect(repairMojibake('Plain ASCII')).toBe('Plain ASCII');
    expect(releaseScope('Breaking Bad IntÃ©grale FRENCH mHD 720p')).toEqual({ pack: 'complete' });
    expect(releaseScope('Breaking Bad Saison 03 ComplÃ¨te Multi')).toMatchObject({ pack: 'season', season: 3 });
  });

  it('nombre d’épisodes d’un pack : Cinemeta d’abord, sinon valeurs par défaut', () => {
    const counts = new Map([[1, 7], [2, 13], [3, 13], [4, 13]]);
    expect(packEpisodeCount({ pack: 'season', season: 4 }, counts)).toBe(13);
    expect(packEpisodeCount({ pack: 'season', season: 9 }, counts)).toBe(10);
    expect(packEpisodeCount({ pack: 'complete', seasons: { from: 1, to: 2 } }, counts)).toBe(20);
    expect(packEpisodeCount({ pack: 'complete' }, counts)).toBe(46);
    expect(packEpisodeCount({ pack: 'complete' }, new Map())).toBe(50);
  });
});

describe('pipeline : packs, partiel, provenances', () => {
  const ctxFor = (fetch: FetchFn, extra: Partial<PipelineContext> = {}): PipelineContext => ({
    playBaseUrl: 'https://addon.test',
    configToken: 'TOKEN',
    secret: 'speed-pipeline-secret-0123456789',
    fetch,
    probe: async () => null,
    ...extra,
  });
  const LOCAL: LocalProwlarr = { baseUrl: 'https://prowlarr.example.com', apiKey: 'SPEED-KEY-1234', indexerCount: 2 };

  /** Cinemeta (titre, saisons de 13 épisodes) + Prowlarr à deux indexeurs. */
  function world(search: (url: URL) => Promise<Response> | Response) {
    const prowlarr = fakeProwlarr([indexer(1, 'Fast'), indexer(2, 'Slow')], search);
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === 'v3-cinemeta.strem.io') {
        const videos = Array.from({ length: 13 }, (_unused, index) => ({ season: 4, episode: index + 1 }));
        return Promise.resolve(json({ meta: { name: 'Breaking Bad', releaseInfo: '2008', videos } }));
      }
      return (prowlarr.fetch as typeof globalThis.fetch)(input, init);
    });
    return { fetch: fetch as unknown as FetchFn, searches: prowlarr.searches };
  }

  const pack = (indexerName: string, id: number, hash: string, title: string, size: number) => ({
    title,
    indexer: indexerName,
    indexerId: id,
    infoHash: hash,
    protocol: 'torrent',
    size,
    seeders: 10,
  });

  it('pack de saison de 60 Go sous un plafond de 10 Go : gardé avec une taille estimée par épisode', async () => {
    const release = pack('Fast', 1, FAST_HASH, 'Breaking.Bad.S04.MULTI.VFF.1080p.WEB.x264-GRP', 60 * 1024 ** 3);
    const { fetch } = world(() => json([release]));
    const config = parseConfig({ debrid: DEBRID, size: { maxGb: 10 }, sources: [{ type: 'prowlarr', name: 'Prowlarr', baseUrl: SOURCE.baseUrl, apiKey: SOURCE.apiKey }] });

    const result = await getStreams(config, EPISODE, ctxFor(fetch, { cache: false, wait: 'full' }));

    expect(result.streams).toHaveLength(1);
    const meta = result.streams[0]?.laststream as Record<string, unknown>;
    expect(meta).toMatchObject({ pack: 'season', sizeEstimated: true, packSizeBytes: 60 * 1024 ** 3 });
    expect(meta.sizeBytes).toBe(Math.floor((60 * 1024 ** 3) / 13));
  });

  it('indexeur lent : réponse partielle (partial, pending), puis le cache est remplacé par le résultat complet', async () => {
    const fast = pack('Fast', 1, FAST_HASH, 'Breaking.Bad.S04.MULTI.1080p.WEB.x264-AAA', 20 * 1024 ** 3);
    const slow = pack('Slow', 2, SLOW_HASH, 'Breaking.Bad.S04.MULTI.2160p.WEB.x265-BBB', 50 * 1024 ** 3);
    const { fetch } = world((url) =>
      url.searchParams.get('indexerIds') === '2' ? sleep(200).then(() => json([slow])) : json([fast]),
    );
    const config = parseConfig({ debrid: DEBRID, sources: [{ type: 'prowlarr', name: 'Prowlarr', baseUrl: SOURCE.baseUrl, apiKey: SOURCE.apiKey }] });
    const cache = new LruCache<PipelineResult>({ max: 10, ttlMs: 60_000 });
    const ctx = ctxFor(fetch, { cache, softMs: 50 });

    const first = await getStreams(config, EPISODE, ctx);
    expect(first.partial).toBe(true);
    expect(first.pending).toEqual(['Slow']);
    expect(first.streams).toHaveLength(1);
    expect((first.streams[0]?.laststream as Record<string, unknown>).partial).toBe(true);
    expect(await getStreamsStatus(config, EPISODE, ctx)).toEqual({ pending: ['Slow'], count: 1 });

    // Un appel avec wait=full attend la fin du recalcul en arrière-plan.
    const full = await getStreams(config, EPISODE, { ...ctx, wait: 'full' });
    expect(full.partial).toBeUndefined();
    expect(full.streams).toHaveLength(2);
    expect(await getStreamsStatus(config, EPISODE, ctx)).toEqual({ pending: [], count: 2 });
    // Le cache sert ensuite le résultat complet sans nouvelle recherche.
    expect((await getStreams(config, EPISODE, ctx)).streams).toHaveLength(2);
  });

  it('provenances : addon amont et indexeurs du Prowlarr local, dans laststream.origins et dans la description', async () => {
    const hash = 'c'.repeat(40);
    const fromProwlarr = pack('YggReborn', 1, hash, 'Film.2024.1080p.WEB.x264-GRP', 4 * 1024 ** 3);
    const prowlarr = fakeProwlarr([indexer(1, 'YggReborn', true)], () => json([fromProwlarr]));
    const upstreamStream = { name: 'Lumio', title: 'Film.2024.1080p.WEB.x264-GRP', infoHash: hash, behaviorHints: { videoSize: 4 * 1024 ** 3 } };
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === 'v3-cinemeta.strem.io') return Promise.resolve(json({ meta: { name: 'Film', releaseInfo: '2024' } }));
      if (url.hostname === 'lumio.example.com') {
        expect(url.pathname).toBe('/TOKEN/stream/movie/tt1234567.json');
        return Promise.resolve(json({ streams: [upstreamStream] }));
      }
      return (prowlarr.fetch as typeof globalThis.fetch)(input, init);
    }) as unknown as FetchFn;
    const config = parseConfig({ debrid: DEBRID, sources: [{ type: 'upstream', name: 'Lumio', url: 'https://lumio.example.com/TOKEN/manifest.json' }] });

    const result = await getStreams(config, MOVIE, ctxFor(fetch, { cache: false, wait: 'full', localProwlarr: async () => LOCAL }));

    expect(result.streams).toHaveLength(1);
    const meta = result.streams[0]?.laststream as { origins: { kind: string; name: string }[]; indexers: string[] };
    expect(meta.origins).toEqual([
      { kind: 'addon', name: 'Lumio' },
      { kind: 'prowlarr-local', name: 'YggReborn' },
    ]);
    expect(meta.indexers).toEqual(['YggReborn']);
    expect(result.streams[0]?.description?.split('\n')[0]).toContain('🔎 Lumio · YggReborn');
  });
});

describe('addons amont : échéance douce et isolation des erreurs', () => {
  const config = (urls: string[]) =>
    parseConfig({ sources: urls.map((url, index) => ({ type: 'upstream', name: `Addon${index}`, url })) });
  const stream = (title: string, hash: string) => ({ title, infoHash: hash });

  it('un addon lent est en attente (pending) sans retarder ni retirer les autres ; une erreur n’efface pas les autres résultats', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === 'fast.example.com') return Promise.resolve(json({ streams: [stream('Film.2024.1080p', FAST_HASH)] }));
      if (url.hostname === 'slow.example.com') return sleep(150).then(() => json({ streams: [stream('Film.2024.2160p', SLOW_HASH)] }));
      return Promise.resolve(new Response('boom', { status: 500 }));
    }) as unknown as FetchFn;

    const result = await collectStreams(config(['https://fast.example.com', 'https://slow.example.com', 'https://bad.example.com']), MOVIE, {
      fetch,
      softMs: 20,
    });

    // L'échéance douce d'un addon est d'au moins 6 s : ici l'addon lent répond avant, il n'est pas en attente.
    expect(result.streams.map((s) => s.infoHash).sort()).toEqual([FAST_HASH, SLOW_HASH]);
    expect(result.errors).toEqual([{ source: 'Addon2', error: 'Source "Addon2" : HTTP 500' }]);
    expect(result.pending).toBeUndefined();
  });

  it('série : identifiant Stremio tt…:S:E dans l’URL de l’addon', async () => {
    const urls: string[] = [];
    const fetch = vi.fn((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(json({ streams: [] }));
    }) as unknown as FetchFn;

    await collectStreams(config(['https://fast.example.com/TOKEN/manifest.json']), EPISODE, { fetch });

    expect(urls).toEqual(['https://fast.example.com/TOKEN/stream/series/tt0903747:4:4.json']);
  });
});
