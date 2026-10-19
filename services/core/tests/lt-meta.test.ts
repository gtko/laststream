import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeUserBackend } from '../src/platform/node/user-backend.js';
import { type MetaBlob, type MetaBlobStore, metaTtlMs, META_TTL } from '../src/lt/meta.js';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const MDB = 'https://api.mdblist.com';
const DAY = 24 * 3600e3;
const HOUR = 3600e3;

/** Stockage R2 simulé : mêmes règles que le binding (clé → corps, empreinte, échéance). Compte les écritures. */
class MemoryBlobs implements MetaBlobStore {
  readonly items = new Map<string, MetaBlob>();
  puts = 0;
  get(key: string): Promise<MetaBlob | undefined> {
    return Promise.resolve(this.items.get(key));
  }
  put(key: string, blob: MetaBlob): Promise<void> {
    this.puts += 1;
    this.items.set(key, blob);
    return Promise.resolve();
  }
}

/** Titre renvoyé par TMDB : modifiable par un test pour simuler une fiche dont le contenu a changé. */
let movieTitle = 'Matrix';
/** Vrai : TMDB répond 503 pour le film 604 (panne simulée). */
let tmdbDown = false;
/** Barrière de la réponse TMDB pour le film 605 : le test la lève pour tenir une construction en vol. */
let gate605: Promise<void> = Promise.resolve();

const movieDetails = () => ({
  id: 603,
  title: movieTitle,
  original_title: 'The Matrix',
  release_date: '1999-03-31',
  status: 'Released',
  overview: 'Simulation',
  genres: [{ id: 878, name: 'Science-Fiction' }],
  runtime: 136,
  poster_path: '/m.jpg',
  backdrop_path: '/b.jpg',
  imdb_id: 'tt0133093',
  external_ids: { imdb_id: 'tt0133093' },
  credits: {
    cast: [
      { id: 6384, name: 'Keanu Reeves', character: 'Neo', profile_path: '/k.jpg' },
      { id: 2, name: '', character: 'Sans nom' },
    ],
  },
});

const seriesDetails = (next: string | null, status: string) => ({
  id: 1399,
  name: 'Game of Thrones',
  original_name: 'Game of Thrones',
  first_air_date: '2011-04-17',
  status,
  overview: 'Des trônes',
  genres: [],
  episode_run_time: [60],
  poster_path: null,
  backdrop_path: null,
  external_ids: { imdb_id: 'tt0944947', tvdb_id: 121361 },
  next_episode_to_air: next === null ? null : { air_date: next },
  seasons: [],
  credits: { cast: [] },
});

const MATRIX_ID = `${TMDB}/movie/603`;
const GOT_ID = `${TMDB}/tv/1399`;

/** Compte le trafic vers les sources (TMDB et MDBList). */
const sourceCalls = (upstream: MockUpstream): number => upstream.calls.length;

/** Attend qu'une condition devienne vraie (travail d'arrière-plan). */
async function until(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Compte A : jeton TMDB et MDBList ; compte B : autre jeton TMDB (même fiche partagée). */
const accountA = () => tokenFor({ tmdbToken: KEYS.tmdbToken, mdblistApiKey: KEYS.mdblistApiKey });
const accountB = () => tokenFor({ tmdbToken: 'autre-jeton-tmdb-789', mdblistApiKey: KEYS.mdblistApiKey });

let upstream: MockUpstream;
let app: RunningApp;
let blobs: MemoryBlobs;
let backend: ReturnType<typeof createNodeUserBackend>;

beforeAll(async () => {
  upstream = mockUpstream({
    [MATRIX_ID]: () => json(movieDetails()),
    [GOT_ID]: () => json(seriesDetails('2026-10-21', 'Returning Series')),
    [`${TMDB}/movie/604`]: () => (tmdbDown ? new Response('panne', { status: 503 }) : json({ ...movieDetails(), id: 604, title: 'Film 604', imdb_id: null })),
    // Film 605 : jeton TMDB refusé (401) pour tout autre jeton que celui du compte A.
    [`${TMDB}/movie/605`]: async (call) => {
      await gate605;
      return call.headers.authorization === `Bearer ${KEYS.tmdbToken}`
        ? json({ ...movieDetails(), id: 605, title: 'Film 605', imdb_id: null })
        : json({ status_message: 'Invalid API key' }, 401);
    },
    [`${MDB}/imdb/movie/tt0133093`]: () => json({ ratings: [{ source: 'imdb', value: 8.7 }, { source: 'tomatoes', value: 88 }], score: 85, released: '1999-03-31' }),
    [`${MDB}/imdb/show/tt0944947`]: () => json({ ratings: [{ source: 'imdb', value: 9.2 }], score: 90 }),
  });
});

beforeEach(async () => {
  movieTitle = 'Matrix';
  tmdbDown = false;
  upstream.calls.length = 0;
  blobs = new MemoryBlobs();
  backend = createNodeUserBackend({ path: ':memory:' });
  if (app !== undefined) await app.close();
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), extra: { metaBlobs: blobs, userBackend: backend } });
});

afterAll(async () => {
  await app?.close();
});

const meta = (type: string, id: string, token: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${app.baseUrl}/${token}/lt/meta/${type}/${id}`, { headers });

describe('fiche partagée : construction et stockage', () => {
  it('première demande : fiche normalisée, ETag fort, stockée sous meta/movie/603.json', async () => {
    const res = await meta('movie', '603', accountA());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const fiche = (await res.json()) as Record<string, unknown>;
    expect(fiche).toMatchObject({
      v: 1,
      type: 'movie',
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'Matrix',
      year: 1999,
      releaseDate: '1999-03-31',
      poster: 'https://image.tmdb.org/t/p/w500/m.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w1280/b.jpg',
      cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profile: 'https://image.tmdb.org/t/p/w185/k.jpg' }],
      ratings: { ratings: { imdb: 8.7, rottentomatoes: 88 }, score: 85 },
      episodes: null,
      partial: false,
    });
    expect(JSON.stringify(fiche)).not.toContain('autre-jeton');
    expect(JSON.stringify(fiche)).not.toContain(KEYS.tmdbToken);

    const stored = blobs.items.get('meta/movie/603.json');
    expect(stored?.etag).toBe(res.headers.get('etag'));
    expect(stored?.body).toBe(JSON.stringify(fiche));
    // Film sorti en 1999 : fiche stable, 30 jours.
    expect(Math.abs((stored?.expiresAt ?? 0) - Date.now() - META_TTL.settled)).toBeLessThan(60e3);
    expect(await backend.meta().find('movie', 603)).toMatchObject({ type: 'movie', tmdbId: 603, imdbId: 'tt0133093', title: 'Matrix', year: 1999, etag: stored?.etag });
  });

  it('deuxième demande, autre compte : aucun appel TMDB ni MDBList, même contenu et même ETag', async () => {
    const first = await meta('movie', '603', accountA());
    const etag = first.headers.get('etag');
    const body = await first.text();
    const callsAfterFirst = sourceCalls(upstream);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await meta('movie', '603', accountB());
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(body);
    expect(second.headers.get('etag')).toBe(etag);
    expect(sourceCalls(upstream)).toBe(callsAfterFirst);
    expect(blobs.puts).toBe(1);
  });

  it('If-None-Match identique : 304 sans corps, avec ETag et Cache-Control', async () => {
    const first = await meta('movie', '603', accountA());
    const etag = first.headers.get('etag') as string;
    const res = await meta('movie', '603', accountB(), { 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await res.text()).toBe('');
    // Empreinte différente ou liste contenant la bonne : 200 ou 304 selon le cas.
    expect((await meta('movie', '603', accountB(), { 'if-none-match': '"autre"' })).status).toBe(200);
    expect((await meta('movie', '603', accountB(), { 'if-none-match': `"x", W/${etag}` })).status).toBe(304);
  });

  it('série en cours sans clé TVDB (ni du compte ni du serveur) : fiche partielle, stockée une heure au plus', async () => {
    const res = await meta('series', '1399', accountA());
    expect(res.status).toBe(200);
    const fiche = (await res.json()) as { type: string; status: string; nextAirDate: string; imdbId: string; tvdbId: number; episodes: unknown; partial: boolean };
    expect(fiche).toMatchObject({ type: 'series', status: 'Returning Series', nextAirDate: '2026-10-21', imdbId: 'tt0944947', tvdbId: 121361, partial: true });
    expect(fiche.episodes).not.toBeNull();
    const stored = blobs.items.get('meta/series/1399.json');
    const remaining = (stored?.expiresAt ?? 0) - Date.now();
    expect(remaining).toBeGreaterThanOrEqual(META_TTL.partial - 60e3);
    expect(remaining).toBeLessThanOrEqual(META_TTL.partial + 60e3);
  });

  it('sans clé MDBList (ni du compte ni du serveur) : fiche partielle, jamais stockée plus d une heure', async () => {
    const res = await meta('movie', '603', tokenFor({ tmdbToken: KEYS.tmdbToken }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Matrix', ratings: null, partial: true });
    const remaining = (blobs.items.get('meta/movie/603.json')?.expiresAt ?? 0) - Date.now();
    expect(remaining).toBeLessThanOrEqual(META_TTL.partial + 60e3);
  });

  it('construction partagée : l échec du jeton d un compte n est pas transmis à celui qui rejoint la construction', async () => {
    let release = (): void => undefined;
    gate605 = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refused = meta('movie', '605', tokenFor({ tmdbToken: 'jeton-refuse-000', mdblistApiKey: KEYS.mdblistApiKey }));
    await until(() => upstream.callsTo(`${TMDB}/movie/605`).length > 0, 'construction en vol');
    // Le compte A rejoint la construction en vol (bloquée) ; le lâcher n'arrive qu'après son arrivée.
    const accepted = meta('movie', '605', accountA());
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    expect((await refused).status).not.toBe(200);
    const ok = await accepted;
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ title: 'Film 605' });
  });

  it('index en panne : la fiche reste stockée et servie, et l échec est signalé comme un échec d index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Seul `upsert` échoue : le dépôt réel répond pour le reste (le proxy de dépôt n'accepte pas de spy direct).
    const real = backend.meta();
    const metaSpy = vi.spyOn(backend, 'meta').mockReturnValue(
      new Proxy(real, { get: (target, prop, receiver) => (prop === 'upsert' ? () => Promise.reject(new Error('index indisponible')) : Reflect.get(target, prop, receiver)) }),
    );
    try {
      const res = await meta('movie', '603', accountA());
      expect(res.status).toBe(200);
      expect(blobs.items.has('meta/movie/603.json')).toBe(true);
      const messages = warn.mock.calls.map((args) => String(args[0]));
      expect(messages.some((message) => message.includes('index'))).toBe(true);
      expect(messages.some((message) => message.includes('écriture du stockage échouée'))).toBe(false);
    } finally {
      metaSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('écriture R2 en échec : la fiche est servie, sans ligne d index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(blobs, 'put').mockRejectedValue(new Error('r2 indisponible'));
    try {
      const res = await meta('movie', '603', accountA());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title: 'Matrix' });
      expect(await backend.meta().find('movie', 603)).toBeUndefined();
      expect(warn.mock.calls.some((args) => String(args[0]).includes('écriture du stockage échouée'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('fiche périmée : servie aussitôt (no-cache), reconstruite en arrière-plan, nouvelle empreinte et index à jour', async () => {
    // L'horloge avance de 13 h : au-delà de la fenêtre périmée du cache TMDB (6 h + 6 h), la reconstruction relit TMDB.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await meta('movie', '603', accountA());
      const oldEtag = first.headers.get('etag');
      const oldBody = await first.text();
      vi.setSystemTime(Date.now() + 13 * HOUR);
      // Échéance dépassée, et TMDB annonce désormais un autre titre.
      blobs.items.set('meta/movie/603.json', { ...(blobs.items.get('meta/movie/603.json') as MetaBlob), expiresAt: Date.now() - 1 });
      movieTitle = 'Matrix Reloaded';
      const callsBefore = sourceCalls(upstream);

      const stale = await meta('movie', '603', accountB());
      expect(stale.status).toBe(200);
      expect(stale.headers.get('cache-control')).toBe('private, no-cache');
      expect(await stale.text()).toBe(oldBody);

      await until(() => (blobs.items.get('meta/movie/603.json')?.etag ?? oldEtag) !== oldEtag, 'reconstruction');
      expect(sourceCalls(upstream)).toBeGreaterThan(callsBefore);
      const rebuilt = blobs.items.get('meta/movie/603.json') as MetaBlob;
      expect(JSON.parse(rebuilt.body)).toMatchObject({ title: 'Matrix Reloaded' });
      expect(rebuilt.expiresAt).toBeGreaterThan(Date.now() + DAY);
      expect(await backend.meta().find('movie', 603)).toMatchObject({ title: 'Matrix Reloaded', etag: rebuilt.etag });

      const fresh = await meta('movie', '603', accountA());
      expect(fresh.headers.get('etag')).toBe(rebuilt.etag);
      expect(fresh.headers.get('cache-control')).toBe('private, max-age=300');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fiche périmée au contenu identique : renouvelée sans changer l’empreinte ni l’index', async () => {
    await (await meta('movie', '603', accountA())).text();
    const before = blobs.items.get('meta/movie/603.json') as MetaBlob;
    blobs.items.set('meta/movie/603.json', { ...before, expiresAt: Date.now() - 1 });
    const puts = blobs.puts;
    await (await meta('movie', '603', accountB())).text();
    await until(() => (blobs.items.get('meta/movie/603.json')?.expiresAt ?? 0) > Date.now(), 'renouvellement');
    expect(blobs.items.get('meta/movie/603.json')?.etag).toBe(before.etag);
    expect(blobs.puts).toBe(puts + 1);
  });
});

describe('fiche partagée : entrées et repli', () => {
  it('type ou identifiant invalide : 404 not_found', async () => {
    expect((await meta('person', '603', accountA())).status).toBe(404);
    expect((await meta('movie', 'abc', accountA())).status).toBe(404);
    expect((await meta('movie', '0', accountA())).status).toBe(404);
  });

  it('sans clé TMDB et sans fiche stockée : 404 service_not_configured', async () => {
    const res = await meta('movie', '603', tokenFor({ mdblistApiKey: KEYS.mdblistApiKey }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'service_not_configured', service: 'tmdb' });
    expect(blobs.items.size).toBe(0);
  });

  it('enregistrement R2 illisible : traité comme absent, reconstruit et réécrit', async () => {
    blobs.items.set('meta/movie/603.json', { body: 'pas du json', etag: '"x"', expiresAt: Date.now() + DAY });
    const res = await meta('movie', '603', accountA());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Matrix' });
    expect(JSON.parse((blobs.items.get('meta/movie/603.json') as MetaBlob).body)).toMatchObject({ title: 'Matrix' });
  });

  it('fiche périmée et TMDB en panne : une seule tentative pendant le délai de nouvel essai', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await meta('movie', '604', accountA());
      expect(first.status).toBe(200);
      const body = await first.text();
      // Horloge +13 h : le cache TMDB ne sert plus rien, la reconstruction interroge TMDB (panne).
      vi.setSystemTime(Date.now() + 13 * HOUR);
      blobs.items.set('meta/movie/604.json', { ...(blobs.items.get('meta/movie/604.json') as MetaBlob), expiresAt: Date.now() - 1 });
      tmdbDown = true;
      const callsBefore = sourceCalls(upstream);
      expect(await (await meta('movie', '604', accountB())).text()).toBe(body);
      await until(() => sourceCalls(upstream) > callsBefore, 'tentative de reconstruction');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const attempted = sourceCalls(upstream);
      // Les demandes suivantes servent la fiche périmée sans relancer les sources pendant le délai.
      for (let i = 0; i < 3; i++) expect(await (await meta('movie', '604', accountB())).text()).toBe(body);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sourceCalls(upstream)).toBe(attempted);
      expect(blobs.items.get('meta/movie/604.json')?.expiresAt).toBeLessThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('sans stockage R2 : fiche construite à chaque demande, même ETag, aucun écrit', async () => {
    const plain = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), extra: { userBackend: createNodeUserBackend({ path: ':memory:' }) } });
    try {
      const first = await fetch(`${plain.baseUrl}/${accountA()}/lt/meta/movie/603`);
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      expect(blobs.items.size).toBe(0);
      const again = await fetch(`${plain.baseUrl}/${accountB()}/lt/meta/movie/603`, { headers: { 'if-none-match': etag as string } });
      expect(again.status).toBe(304);
    } finally {
      await plain.close();
    }
  });
});

describe('TTL des fiches (metaTtlMs)', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const base = { type: 'series' as const, status: 'Returning Series', releaseDate: '2011-04-17', nextAirDate: null, tvdb: null, partial: false };

  it('série terminée ou annulée : 30 jours', () => {
    expect(metaTtlMs({ ...base, status: 'Ended' }, now)).toBe(30 * DAY);
    expect(metaTtlMs({ ...base, status: 'Canceled' }, now)).toBe(30 * DAY);
    expect(metaTtlMs({ ...base, tvdb: { status: 'Ended', seasonCount: 8, nextAired: '', lastAired: '2019-05-19' } }, now)).toBe(30 * DAY);
  });

  it('série en cours : jusqu’au prochain épisode, minimum 6 h, maximum 7 jours, 24 h si inconnu', () => {
    expect(metaTtlMs({ ...base, nextAirDate: '2026-10-21' }, now)).toBe(36 * HOUR);
    expect(metaTtlMs({ ...base, nextAirDate: '2026-10-19' }, now)).toBe(META_TTL.inProgressMin);
    expect(metaTtlMs({ ...base, nextAirDate: '2026-11-30' }, now)).toBe(META_TTL.inProgressMax);
    expect(metaTtlMs({ ...base, nextAirDate: null }, now)).toBe(DAY);
    expect(metaTtlMs({ ...base, status: null, nextAirDate: null }, now)).toBe(DAY);
  });

  it('film sorti depuis plus d’un an : 30 jours ; film récent ou sans date : 24 h', () => {
    const movie = { type: 'movie' as const, status: 'Released', releaseDate: '1999-03-31', nextAirDate: null, tvdb: null, partial: false };
    expect(metaTtlMs(movie, now)).toBe(30 * DAY);
    expect(metaTtlMs({ ...movie, releaseDate: '2026-06-01' }, now)).toBe(DAY);
    expect(metaTtlMs({ ...movie, releaseDate: null }, now)).toBe(DAY);
  });

  it('fiche incomplète : au plus une heure', () => {
    expect(metaTtlMs({ type: 'movie', status: 'Released', releaseDate: '1999-03-31', nextAirDate: null, tvdb: null, partial: true }, now)).toBe(HOUR);
  });
});
