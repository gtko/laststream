import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeUserBackend } from '../src/platform/node/user-backend.js';
import { type MetaBlob, type MetaBlobStore } from '../src/lt/meta.js';
import { baseKey, l10nKey, legacyKey, ratingsKey, type Subject, ttlMs } from '../src/lt/meta-policy.js';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const MDB = 'https://api.mdblist.com';
const DAY = 24 * 3600e3;
const HOUR = 3600e3;
/** Clés des trois couches d'un film (langue française par défaut). */
const MATRIX_KEYS = { base: baseKey('movie', 603), l10n: l10nKey('movie', 603, 'fr-FR'), ratings: ratingsKey('movie', 603) };

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

const meta = (type: string, id: string, token: string, headers: Record<string, string> = {}, query = ''): Promise<Response> =>
  fetch(`${app.baseUrl}/${token}/lt/meta/${type}/${id}${query}`, { headers });

/** Objet JSON stocké sous une clé. */
const layerOf = (key: string): Record<string, unknown> => JSON.parse((blobs.items.get(key) as MetaBlob).body) as Record<string, unknown>;
/** Fait expirer un objet (échéance dépassée de `ago` ms) sans toucher à son contenu. */
const expire = (key: string, ago = 1): void => {
  blobs.items.set(key, { ...(blobs.items.get(key) as MetaBlob), expiresAt: Date.now() - ago });
};

describe('fiche partagée : construction et stockage', () => {
  it('première demande : fiche normalisée, ETag fort, stockée en trois couches v2', async () => {
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

    // Trois couches, une seule fois chacune ; aucune ancienne clé n'est écrite.
    expect([...blobs.items.keys()].sort()).toEqual([MATRIX_KEYS.base, MATRIX_KEYS.l10n, MATRIX_KEYS.ratings].sort());
    expect(blobs.puts).toBe(3);
    // Base : chemins d'images seulement (jamais d'URL), le choix de la taille se fait à l'assemblage.
    const base = blobs.items.get(MATRIX_KEYS.base) as MetaBlob;
    expect(JSON.parse(base.body)).toMatchObject({ schema: 2, type: 'movie', imdbId: 'tt0133093', cast: [{ id: 6384, profilePath: '/k.jpg' }] });
    expect(base.body).not.toContain('image.tmdb.org');
    expect(layerOf(MATRIX_KEYS.l10n)).toMatchObject({ schema: 2, lang: 'fr-FR', title: 'Matrix', posterPath: '/m.jpg', backdropPath: '/b.jpg', genres: ['Science-Fiction'] });
    expect(layerOf(MATRIX_KEYS.ratings)).toMatchObject({ schema: 2, partial: false, ratings: { ratings: { imdb: 8.7 } } });
    // Film sorti en 1999 : base et traduction 180 jours, notes 30 jours (meta-policy), ttl enregistré avec l'objet.
    const layers = [MATRIX_KEYS.base, MATRIX_KEYS.l10n, MATRIX_KEYS.ratings].map((key) => blobs.items.get(key) as MetaBlob);
    expect(layers.map((blob) => blob.ttl)).toEqual([180 * DAY, 180 * DAY, 30 * DAY]);
    for (const blob of layers) expect(Math.abs(blob.expiresAt - Date.now() - blob.ttl)).toBeLessThan(60e3);
    // Un seul appel TMDB : aucun champ vide, donc pas de repli en-US.
    expect(upstream.callsTo(MATRIX_ID)).toHaveLength(1);
    const tmdbCall = upstream.callsTo(MATRIX_ID)[0]?.url.searchParams;
    expect(tmdbCall?.get('language')).toBe('fr-FR');
    expect(tmdbCall?.get('include_image_language')).toBe('fr,en,null');
    expect(await backend.meta().find('movie', 603)).toMatchObject({ type: 'movie', tmdbId: 603, imdbId: 'tt0133093', title: 'Matrix', year: 1999 });
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
    // Fiche inchangée et non expirée : aucun put de plus.
    expect(blobs.puts).toBe(3);
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
    // Base et traduction : une heure ; les notes (clé MDBList présente, fiche sans date de sortie complète) suivent leur propre durée.
    for (const key of [baseKey('tv', 1399), l10nKey('tv', 1399, 'fr-FR')]) {
      const remaining = (blobs.items.get(key)?.expiresAt ?? 0) - Date.now();
      expect(remaining).toBeGreaterThanOrEqual(HOUR - 60e3);
      expect(remaining).toBeLessThanOrEqual(HOUR + 60e3);
    }
    // Les épisodes sont répartis : structure dans la base, textes dans la traduction.
    expect(layerOf(baseKey('tv', 1399)).episodes).not.toBeNull();
    expect(layerOf(l10nKey('tv', 1399, 'fr-FR'))).toMatchObject({ lang: 'fr-FR', title: 'Game of Thrones' });
  });

  it('sans clé MDBList (ni du compte ni du serveur) : fiche partielle, notes relues sous un jour', async () => {
    const res = await meta('movie', '603', tokenFor({ tmdbToken: KEYS.tmdbToken }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Matrix', ratings: null, partial: true });
    // Seule la couche des notes est courte : base et traduction restent à leur durée normale.
    expect(layerOf(MATRIX_KEYS.ratings)).toMatchObject({ ratings: null, partial: true });
    expect((blobs.items.get(MATRIX_KEYS.ratings)?.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(DAY + 60e3);
    expect(blobs.items.get(MATRIX_KEYS.base)?.ttl).toBe(180 * DAY);
    expect(upstream.callsTo(`${MDB}/imdb/movie/tt0133093`)).toHaveLength(0);
  });

  it('couche des notes sans clé : relue par le compte suivant qui a une clé, sans réécrire base ni traduction', async () => {
    await (await meta('movie', '603', tokenFor({ tmdbToken: KEYS.tmdbToken }))).text();
    const puts = blobs.puts;
    const base = blobs.items.get(MATRIX_KEYS.base);
    const res = await meta('movie', '603', accountA());
    expect(await res.json()).toMatchObject({ ratings: null });
    await until(() => (blobs.items.get(MATRIX_KEYS.ratings)?.body ?? '').includes('"partial":false'), 'notes relues');
    expect(blobs.puts).toBe(puts + 1);
    expect(blobs.items.get(MATRIX_KEYS.base)).toBe(base);
    const again = await (await meta('movie', '603', accountB())).json();
    expect(again).toMatchObject({ ratings: { ratings: { imdb: 8.7 } }, partial: false });
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
      expect(blobs.items.has(MATRIX_KEYS.base)).toBe(true);
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

  it('traduction périmée : servie aussitôt (no-cache), reconstruite seule en arrière-plan, nouvelle empreinte et index à jour', async () => {
    // L'horloge avance de 13 h : au-delà de la fenêtre périmée du cache TMDB (6 h + 6 h), la reconstruction relit TMDB.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await meta('movie', '603', accountA());
      const oldEtag = first.headers.get('etag');
      const oldBody = await first.text();
      vi.setSystemTime(Date.now() + 13 * HOUR);
      // Échéance dépassée, et TMDB annonce désormais un autre titre.
      expire(MATRIX_KEYS.l10n);
      const baseBefore = blobs.items.get(MATRIX_KEYS.base);
      const ratingsBefore = blobs.items.get(MATRIX_KEYS.ratings);
      const puts = blobs.puts;
      movieTitle = 'Matrix Reloaded';
      const callsBefore = sourceCalls(upstream);

      const stale = await meta('movie', '603', accountB());
      expect(stale.status).toBe(200);
      expect(stale.headers.get('cache-control')).toBe('private, no-cache');
      expect(await stale.text()).toBe(oldBody);

      await until(() => blobs.puts > puts, 'reconstruction');
      expect(sourceCalls(upstream)).toBeGreaterThan(callsBefore);
      const rebuilt = blobs.items.get(MATRIX_KEYS.l10n) as MetaBlob;
      expect(JSON.parse(rebuilt.body)).toMatchObject({ title: 'Matrix Reloaded' });
      expect(rebuilt.expiresAt).toBeGreaterThan(Date.now() + DAY);
      expect(await backend.meta().find('movie', 603)).toMatchObject({ title: 'Matrix Reloaded' });
      // Seule la traduction est réécrite : base et notes saines gardent leur objet.
      expect(blobs.puts).toBe(puts + 1);
      expect(blobs.items.get(MATRIX_KEYS.base)).toBe(baseBefore);
      expect(blobs.items.get(MATRIX_KEYS.ratings)).toBe(ratingsBefore);

      const fresh = await meta('movie', '603', accountA());
      expect(fresh.headers.get('etag')).not.toBe(oldEtag);
      expect(await fresh.json()).toMatchObject({ title: 'Matrix Reloaded' });
      expect(fresh.headers.get('cache-control')).toBe('private, max-age=300');
    } finally {
      vi.useRealTimers();
    }
  });

  it('couche périmée au contenu identique : renouvelée sans changer l’empreinte, les autres couches intactes', async () => {
    const first = await meta('movie', '603', accountA());
    const etag = first.headers.get('etag');
    const before = blobs.items.get(MATRIX_KEYS.l10n) as MetaBlob;
    const baseBefore = blobs.items.get(MATRIX_KEYS.base);
    expire(MATRIX_KEYS.l10n);
    const puts = blobs.puts;
    await (await meta('movie', '603', accountB())).text();
    await until(() => (blobs.items.get(MATRIX_KEYS.l10n)?.expiresAt ?? 0) > Date.now(), 'renouvellement');
    expect(blobs.items.get(MATRIX_KEYS.l10n)?.etag).toBe(before.etag);
    expect(blobs.puts).toBe(puts + 1);
    expect(blobs.items.get(MATRIX_KEYS.base)).toBe(baseBefore);
    expect((await meta('movie', '603', accountB())).headers.get('etag')).toBe(etag);
  });

  it('notes périmées seules : lues à nouveau et réécrites seules, base et traduction ne sont pas réécrites', async () => {
    await (await meta('movie', '603', accountA())).text();
    const baseBefore = blobs.items.get(MATRIX_KEYS.base);
    const l10nBefore = blobs.items.get(MATRIX_KEYS.l10n);
    expire(MATRIX_KEYS.ratings);
    const puts = blobs.puts;
    const res = await meta('movie', '603', accountB());
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    await until(() => (blobs.items.get(MATRIX_KEYS.ratings)?.expiresAt ?? 0) > Date.now(), 'notes renouvelées');
    expect(blobs.puts).toBe(puts + 1);
    expect(blobs.items.get(MATRIX_KEYS.base)).toBe(baseBefore);
    expect(blobs.items.get(MATRIX_KEYS.l10n)).toBe(l10nBefore);
  });

  it('couche morte : reconstruite avant la réponse (servie à jour, pas périmée)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await (await meta('movie', '603', accountA())).text();
      vi.setSystemTime(Date.now() + 13 * HOUR);
      // Échue depuis plus de 30 jours : au-delà de la fenêtre de service périmé.
      expire(MATRIX_KEYS.l10n, 31 * DAY);
      movieTitle = 'Matrix Revolutions';
      const res = await meta('movie', '603', accountB());
      expect(res.headers.get('cache-control')).toBe('private, max-age=300');
      expect(await res.json()).toMatchObject({ title: 'Matrix Revolutions' });
      expect(JSON.parse((blobs.items.get(MATRIX_KEYS.l10n) as MetaBlob).body)).toMatchObject({ title: 'Matrix Revolutions' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('couche morte et jeton refusé par TMDB (échec amont) : l’objet périmé est servi avec stale (no-cache), pas une erreur', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await meta('movie', '605', accountA());
      const body = await first.text();
      vi.setSystemTime(Date.now() + 13 * HOUR);
      expire(l10nKey('movie', 605, 'fr-FR'), 31 * DAY);
      const res = await meta('movie', '605', accountB());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(await res.text()).toBe(body);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fiche partagée : langue et reprise des anciennes fiches', () => {
  it('langue hors liste (ou absente) : fr-FR ; en : couche en-US seule, base et notes réutilisées', async () => {
    await (await meta('movie', '603', accountA(), {}, '?language=de')).text();
    expect([...blobs.items.keys()].sort()).toEqual([MATRIX_KEYS.base, MATRIX_KEYS.l10n, MATRIX_KEYS.ratings].sort());
    expect(upstream.callsTo(MATRIX_ID)[0]?.url.searchParams.get('language')).toBe('fr-FR');

    const puts = blobs.puts;
    const base = blobs.items.get(MATRIX_KEYS.base);
    const english = await meta('movie', '603', accountB(), {}, '?language=en');
    expect(english.status).toBe(200);
    expect(await english.json()).toMatchObject({ title: 'Matrix', ratings: { score: 85 } });
    const en = upstream.callsTo(MATRIX_ID).at(-1)?.url.searchParams;
    expect(en?.get('language')).toBe('en-US');
    expect(en?.get('include_image_language')).toBe('en,null');
    // Une seule couche de plus (en-US) ; la base saine n'est pas réécrite.
    expect(blobs.puts).toBe(puts + 1);
    expect(layerOf(l10nKey('movie', 603, 'en-US'))).toMatchObject({ lang: 'en-US' });
    expect(blobs.items.get(MATRIX_KEYS.base)).toBe(base);
    // Les deux langues ont des ETag distincts mais restent stables d'une demande à l'autre.
    const fr = await meta('movie', '603', accountA());
    const en2 = await meta('movie', '603', accountA(), {}, '?language=EN-us');
    expect(fr.headers.get('etag')).not.toBe(en2.headers.get('etag'));
    expect(blobs.puts).toBe(puts + 1);
  });

  it('champ vide dans la langue demandée : repli sur en-US (un appel de plus), puis sur le titre original', async () => {
    const id = 606;
    const handler = (call: { url: URL }) => {
      const english = call.url.searchParams.get('language') === 'en-US';
      return json({
        ...movieDetails(),
        id,
        title: english ? 'English title' : '',
        original_title: 'Titre original',
        overview: english ? 'English synopsis' : '',
        tagline: english ? 'English tagline' : '',
      });
    };
    const local = mockUpstream({
      [`${TMDB}/movie/${id}`]: handler,
      [`${MDB}/imdb/movie/tt0133093`]: () => json({ ratings: [], score: 1 }),
    });
    const backendLocal = createNodeUserBackend({ path: ':memory:' });
    const running = await startApp({ fetch: local.fetch, lookupHost: fakeLookup(), extra: { metaBlobs: blobs, userBackend: backendLocal } });
    try {
      const res = await fetch(`${running.baseUrl}/${accountA()}/lt/meta/movie/${id}`);
      expect(await res.json()).toMatchObject({ title: 'English title', overview: 'English synopsis' });
      expect(local.callsTo(`${TMDB}/movie/${id}`)).toHaveLength(2);
      expect(layerOf(l10nKey('movie', id, 'fr-FR'))).toMatchObject({ title: 'English title', tagline: 'English tagline' });
    } finally {
      await running.close();
    }

    // Titre vide aussi en en-US : le titre original.
    const bare = mockUpstream({ [`${TMDB}/movie/607`]: () => json({ ...movieDetails(), id: 607, title: '', original_title: 'Titre original', overview: 'Synopsis' }) });
    const running2 = await startApp({ fetch: bare.fetch, lookupHost: fakeLookup(), extra: { userBackend: createNodeUserBackend({ path: ':memory:' }) } });
    try {
      const res = await fetch(`${running2.baseUrl}/${accountA()}/lt/meta/movie/607`);
      expect(await res.json()).toMatchObject({ title: 'Titre original', overview: 'Synopsis' });
    } finally {
      await running2.close();
    }
  });

  it('reprise v1 : les notes de l’ancien objet sont reprises sans appel MDBList, l’ancien objet n’est jamais écrit', async () => {
    const legacyBody = JSON.stringify({ v: 1, type: 'movie', tmdbId: 603, ratings: { ratings: { imdb: 7.7 }, score: 70 }, ratingsDueAt: 0 });
    const legacy: MetaBlob = { body: legacyBody, etag: '"ancien"', expiresAt: Date.now() - DAY, ttl: 0 };
    blobs.items.set(legacyKey('movie', 603), legacy);
    const res = await meta('movie', '603', accountA());
    expect(await res.json()).toMatchObject({ ratings: { ratings: { imdb: 7.7 }, score: 70 } });
    expect(upstream.callsTo(`${MDB}/imdb/movie/tt0133093`)).toHaveLength(0);
    expect(blobs.items.get(legacyKey('movie', 603))).toBe(legacy);
    expect(blobs.items.size).toBe(4);
    const stored = blobs.items.get(MATRIX_KEYS.ratings) as MetaBlob;
    expect(JSON.parse(stored.body)).toMatchObject({ schema: 2, partial: false, ratings: { score: 70 } });
    // Échéance courte : relues dans la journée.
    expect(stored.expiresAt - Date.now()).toBeLessThanOrEqual(DAY + 60e3);
    expect(stored.ttl).toBe(DAY);
  });

  it('film non sorti : aucun appel MDBList, ratings null, aucune couche de notes', async () => {
    const future = mockUpstream({ [`${TMDB}/movie/608`]: () => json({ ...movieDetails(), id: 608, title: 'À venir', release_date: '2999-01-01' }) });
    const running = await startApp({ fetch: future.fetch, lookupHost: fakeLookup(), extra: { metaBlobs: blobs, userBackend: createNodeUserBackend({ path: ':memory:' }) } });
    try {
      const res = await fetch(`${running.baseUrl}/${accountA()}/lt/meta/movie/608`);
      expect(await res.json()).toMatchObject({ title: 'À venir', ratings: null });
      expect(future.calls.some((c) => c.url.hostname === 'api.mdblist.com')).toBe(false);
      expect(blobs.items.has(ratingsKey('movie', 608))).toBe(false);
    } finally {
      await running.close();
    }
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
    blobs.items.set(MATRIX_KEYS.base, { body: 'pas du json', etag: '"x"', expiresAt: Date.now() + DAY, ttl: DAY });
    const res = await meta('movie', '603', accountA());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Matrix' });
    expect(JSON.parse((blobs.items.get(MATRIX_KEYS.base) as MetaBlob).body)).toMatchObject({ schema: 2, tmdbId: 603 });
  });

  it('couche d’un autre schéma : traitée comme absente', async () => {
    blobs.items.set(MATRIX_KEYS.l10n, { body: JSON.stringify({ schema: 1, title: 'Ancien' }), etag: '"x"', expiresAt: Date.now() + DAY, ttl: DAY });
    expect(await (await meta('movie', '603', accountA())).json()).toMatchObject({ title: 'Matrix' });
  });

  it('fiche périmée et TMDB en panne : une seule tentative pendant le délai de nouvel essai', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await meta('movie', '604', accountA());
      expect(first.status).toBe(200);
      const body = await first.text();
      // Horloge +13 h : le cache TMDB ne sert plus rien, la reconstruction interroge TMDB (panne).
      vi.setSystemTime(Date.now() + 13 * HOUR);
      expire(l10nKey('movie', 604, 'fr-FR'));
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
      expect(blobs.items.get(l10nKey('movie', 604, 'fr-FR'))?.expiresAt).toBeLessThan(Date.now());
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

describe('durées de vie des couches (meta-policy)', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const tv: Subject = { kind: 'tv', status: 'Returning Series', releaseDate: '2011-04-17', nextAirDate: null };

  it('série terminée ou annulée : 180 jours pour la base, 30 jours pour les notes', () => {
    for (const subject of [{ ...tv, status: 'Ended' }, { ...tv, status: 'Canceled' }, { ...tv, ended: true }]) {
      expect(ttlMs('base', subject, now)).toBe(180 * DAY);
      expect(ttlMs('ratings', subject, now)).toBe(30 * DAY);
    }
  });

  it('série en cours : base jusqu’au prochain épisode (6 h minimum, 30 jours maximum), 14 jours si inconnu', () => {
    expect(ttlMs('base', { ...tv, nextAirDate: '2026-10-21' }, now)).toBe(42 * HOUR);
    expect(ttlMs('base', { ...tv, nextAirDate: '2026-10-19' }, now)).toBe(6 * HOUR);
    expect(ttlMs('base', { ...tv, nextAirDate: '2027-03-30' }, now)).toBe(30 * DAY);
    expect(ttlMs('base', tv, now)).toBe(14 * DAY);
  });

  it('film sorti depuis plus d’un an : 180 jours ; film non sorti ou sans date : aucune note', () => {
    const movie: Subject = { kind: 'movie', status: 'Released', releaseDate: '1999-03-31' };
    expect(ttlMs('base', movie, now)).toBe(180 * DAY);
    expect(ttlMs('ratings', { ...movie, releaseDate: '2027-01-01' }, now)).toBe(0);
    expect(ttlMs('ratings', { ...movie, releaseDate: null }, now)).toBe(0);
  });

  it('fiche incomplète : base et traduction une heure, notes un jour', () => {
    const movie: Subject = { kind: 'movie', status: 'Released', releaseDate: '1999-03-31', partial: true };
    expect(ttlMs('base', movie, now)).toBe(HOUR);
    expect(ttlMs('l10n', movie, now)).toBe(HOUR);
    expect(ttlMs('ratings', movie, now)).toBe(DAY);
  });
});
