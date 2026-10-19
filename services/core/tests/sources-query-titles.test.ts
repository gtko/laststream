import { TtlCache } from '../src/cache/ttl-cache.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import {
  buildQueries,
  detectYear,
  getTitleVariants,
  idQueryOf,
  stripAccents,
  stripPunctuation,
  yearMatches,
} from '../src/sources/query-titles.js';
import type { ContentRef } from '../src/types.js';

const TOKEN = 'tmdb-read-token-XYZ123';
const API = 'https://api.themoviedb.org/3';
const MOVIE: ContentRef = { type: 'movie', id: 'tt15239678', imdbId: 'tt15239678' };
const EPISODE: ContentRef = { type: 'series', id: 'tt9000001:1:2', imdbId: 'tt9000001', season: 1, episode: 2 };
const SERIES: ContentRef = { type: 'series', id: 'tt9000001', imdbId: 'tt9000001' };
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type Handler = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch TMDB : une réponse par URL exacte ; toute URL non prévue répond 500. Aucun réseau. */
function tmdb(table: Record<string, Handler>) {
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const handler = table[String(input)];
    return handler ? handler() : new Response('unexpected', { status: 500 });
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

/** Dune Deuxième Partie (TMDB 693134) : titre anglais, titre français avec accent et ponctuation, original anglais. */
function duneTable(): Record<string, Handler> {
  return {
    [`${API}/find/tt15239678?external_source=imdb_id`]: () => json({ movie_results: [{ id: 693134 }], tv_results: [] }),
    [`${API}/movie/693134?language=en-US&append_to_response=alternative_titles`]: () =>
      json({ title: 'Dune: Part Two', original_title: 'Dune: Part Two', release_date: '2024-02-27' }),
    [`${API}/movie/693134?language=fr-FR`]: () =>
      json({ title: 'Dune : Deuxième Partie', original_title: 'Dune: Part Two', release_date: '2024-02-27' }),
  };
}

/** Severance (TMDB 4242) : série dont les titres anglais et français sont identiques. */
function severanceTable(): Record<string, Handler> {
  return {
    [`${API}/find/tt9000001?external_source=imdb_id`]: () => json({ movie_results: [], tv_results: [{ id: 4242 }] }),
    [`${API}/tv/4242?language=en-US&append_to_response=alternative_titles`]: () =>
      json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
    [`${API}/tv/4242?language=fr-FR`]: () =>
      json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
  };
}

describe('getTitleVariants : TMDB (en-US, fr-FR, original)', () => {
  it('film : original, anglais et français dédupliqués, année de sortie ; jeton en Bearer, jamais dans l’URL', async () => {
    const { fetch, mock } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants).toEqual({
      titles: ['Dune: Part Two', 'Dune : Deuxième Partie'],
      year: 2024,
      fr: 'Dune : Deuxième Partie',
      en: 'Dune: Part Two',
    });
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`${API}/movie/693134?language=en-US&append_to_response=alternative_titles`);
    expect(urls).toContain(`${API}/movie/693134?language=fr-FR`);
    expect(urls.some((url) => url.includes(TOKEN))).toBe(false);
    const init = mock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('série : name et original_name (dédupliqués), année de première diffusion', async () => {
    const { fetch } = tmdb(severanceTable());

    const variants = await getTitleVariants(SERIES, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants).toEqual({ titles: ['Severance'], year: 2022, fr: 'Severance', en: 'Severance' });
  });

  it('sans jeton : aucun appel TMDB, repli sur fallbackTitle', async () => {
    const { fetch, mock } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, {
      fetch,
      cache: new TtlCache(),
      fallbackTitle: { title: 'Dune Part Two', year: 2024 },
    });

    expect(variants).toEqual({ titles: ['Dune Part Two'], year: 2024 });
    expect(mock).not.toHaveBeenCalled();
  });

  it('TMDB en erreur : repli sur fallbackTitle, sans lever, et résultat non mis en cache', async () => {
    const cache = new TtlCache();
    const failing = tmdb({ [`${API}/find/tt15239678?external_source=imdb_id`]: () => new Response('x', { status: 500 }) });

    const first = await getTitleVariants(MOVIE, {
      tmdbToken: TOKEN,
      fetch: failing.fetch,
      cache,
      fallbackTitle: { title: 'Dune Part Two', year: 2024 },
    });
    const second = await getTitleVariants(MOVIE, { tmdbToken: TOKEN, fetch: failing.fetch, cache });

    expect(first).toEqual({ titles: ['Dune Part Two'], year: 2024 });
    expect(second).toEqual({ titles: [] });
    expect(failing.mock).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('fetch qui rejette : ne lève jamais, renvoie le repli', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('réseau coupé'))) as unknown as FetchFn;

    const variants = await getTitleVariants(MOVIE, {
      tmdbToken: TOKEN,
      fetch,
      cache: new TtlCache(),
      fallbackTitle: { title: 'Dune Part Two' },
    });

    expect(variants).toEqual({ titles: ['Dune Part Two'] });
  });

  it('le titre de repli s’ajoute aux titres TMDB sans doublon', async () => {
    const { fetch } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, {
      tmdbToken: TOKEN,
      fetch,
      cache: new TtlCache(),
      fallbackTitle: { title: 'dune: part two' },
    });

    expect(variants.titles).toEqual(['Dune: Part Two', 'Dune : Deuxième Partie']);
  });
});

describe('getTitleVariants : cache de 7 jours (horloge simulée)', () => {
  afterEach(() => vi.useRealTimers());

  it('résultat réutilisé pendant 7 jours ; au-delà, servi périmé puis rechargé en arrière-plan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const { fetch, mock } = tmdb(duneTable());
    const cache = new TtlCache();
    const options = { tmdbToken: TOKEN, fetch, cache };

    await getTitleVariants(MOVIE, options);
    expect(mock).toHaveBeenCalledTimes(3); // find, en-US, fr-FR

    vi.setSystemTime(Date.now() + SEVEN_DAYS_MS - 1);
    await getTitleVariants(MOVIE, options);
    expect(mock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(Date.now() + 1); // exactement 7 jours : périmé, servi puis rafraîchi
    const again = await getTitleVariants(MOVIE, options);
    expect(again.titles).toEqual(['Dune: Part Two', 'Dune : Deuxième Partie']);
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(6));
  });
});

describe('getTitleVariants : requêtes simultanées', () => {
  it('deux appels simultanés pour un même titre : une seule série de requêtes TMDB', async () => {
    const { fetch, mock } = tmdb(duneTable());
    const cache = new TtlCache();
    const options = { tmdbToken: TOKEN, fetch, cache };

    const [first, second] = await Promise.all([getTitleVariants(MOVIE, options), getTitleVariants(MOVIE, options)]);

    expect(mock).toHaveBeenCalledTimes(3); // find, en-US, fr-FR
    expect(second).toEqual(first);
  });
});

describe('buildQueries', () => {
  it('film : titre français sans année puis avec, titre anglais avec puis sans, puis accents, puis accents et ponctuation', () => {
    const queries = buildQueries(
      { titles: ['Dune: Part Two', 'Dune : Deuxième Partie'], year: 2024, fr: 'Dune : Deuxième Partie', en: 'Dune: Part Two' },
      MOVIE,
    );

    expect(queries).toEqual([
      'Dune : Deuxième Partie',
      'Dune : Deuxième Partie 2024',
      'Dune: Part Two 2024',
      'Dune: Part Two',
      'Dune : Deuxieme Partie',
      'Dune : Deuxieme Partie 2024',
      'Dune Deuxieme Partie',
      'Dune Deuxieme Partie 2024',
    ]);
  });

  it('film sans langue connue : chaque titre sans année puis avec, dans l’ordre reçu', () => {
    expect(buildQueries({ titles: ['Dune', 'Dune Part Two'], year: 2024 }, MOVIE)).toEqual([
      'Dune',
      'Dune 2024',
      'Dune Part Two',
      'Dune Part Two 2024',
    ]);
  });

  it('film sans année : le titre seul', () => {
    expect(buildQueries({ titles: ['Dune'] }, MOVIE)).toEqual(['Dune']);
  });

  it('série épisode : packs et intégrale d’abord, « Titre S01E02 » ensuite, puis variantes sans accents', () => {
    const queries = buildQueries({ titles: ['Le Problème à trois corps'] }, EPISODE);

    expect(queries).toEqual([
      'Le Problème à trois corps S01',
      'Le Problème à trois corps Saison 1',
      'Le Problème à trois corps Intégrale',
      'Le Problème à trois corps complete',
      'Le Problème à trois corps S01E02',
      'Le Probleme a trois corps S01',
      'Le Probleme a trois corps Saison 1',
      'Le Probleme a trois corps Integrale',
    ]);
  });

  it('série épisode : titre français puis original, familles du français en tête', () => {
    const queries = buildQueries({ titles: ['Breaking Bad', 'Breaking Bad Original'], fr: 'Breaking Bad' }, EPISODE);

    expect(queries.slice(0, 5)).toEqual([
      'Breaking Bad S01',
      'Breaking Bad Saison 1',
      'Breaking Bad Intégrale',
      'Breaking Bad complete',
      'Breaking Bad S01E02',
    ]);
    expect(queries).toContain('Breaking Bad Original S01');
  });

  it('série : titre sans lettre latine (japonais) écarté des requêtes ; titre latin conservé', () => {
    const queries = buildQueries({ titles: ['葬送のフリーレン', 'Frieren'] }, EPISODE);

    expect(queries.some((query) => query.includes('葬'))).toBe(false);
    expect(queries[0]).toBe('Frieren S01');
  });

  it('idQueryOf : titre français, sinon anglais ou original latin ; undefined sans titre latin', () => {
    expect(
      idQueryOf({ titles: ['Dune: Part Two', 'Dune : Deuxième Partie'], fr: 'Dune : Deuxième Partie', en: 'Dune: Part Two' }),
    ).toBe('Dune : Deuxième Partie');
    expect(idQueryOf({ titles: ['Frieren'] })).toBe('Frieren');
    expect(idQueryOf({ titles: ['葬送のフリーレン'] })).toBeUndefined();
    expect(idQueryOf({ titles: [] })).toBeUndefined();
  });

  it('série sans épisode connu : saison puis pack, pas de SxxEyy', () => {
    const queries = buildQueries({ titles: ['Severance'] }, { type: 'series', id: 'tt9000001:1', imdbId: 'tt9000001', season: 1 });

    expect(queries).toEqual(['Severance Saison 1', 'Severance S01']);
  });

  it('série sans saison : le titre seul', () => {
    expect(buildQueries({ titles: ['Severance'] }, SERIES)).toEqual(['Severance']);
  });

  it('plafonne à 8 requêtes, dans l’ordre de priorité (titres tels quels d’abord)', () => {
    const queries = buildQueries({ titles: ['A: B', 'C-D', 'E F', 'G’H', 'I.J'], year: 2024 }, MOVIE);

    expect(queries).toEqual(['A: B', 'A: B 2024', 'C-D', 'C-D 2024', 'E F', 'E F 2024', 'G’H', 'G’H 2024']);
  });

  it('aucun titre exploitable : aucune requête', () => {
    expect(buildQueries({ titles: ['   ', ''] }, MOVIE)).toEqual([]);
  });
});

describe('stripAccents / stripPunctuation', () => {
  it('retire les accents (NFD) et la ponctuation courante, réduit les espaces', () => {
    expect(stripAccents('Été Déjà Où Œuvre')).toBe('Ete Deja Ou Œuvre');
    expect(stripPunctuation("L'Odyssée : Spider-Man (2024), « Vol » !")).toBe('L Odyssée Spider Man 2024 Vol');
  });
});

describe('yearMatches', () => {
  it('accepte l’année exacte et à ±1 ; rejette au-delà', () => {
    expect(yearMatches('Dune.Part.Two.2024.2160p.WEB-DL', 2024)).toBe(true);
    expect(yearMatches('Dune.2023.1080p', 2024)).toBe(true);
    expect(yearMatches('Dune.2025.1080p', 2024)).toBe(true);
    expect(yearMatches('Dune.1984.1080p', 2024)).toBe(false);
    expect(yearMatches('Dune.2022.1080p', 2024)).toBe(false);
  });

  it('année absente du titre ou année attendue inconnue : accepté', () => {
    expect(yearMatches('Dune.Part.Two.1080p', 2024)).toBe(true);
    expect(yearMatches('Dune.1984.1080p', undefined)).toBe(true);
  });

  it('prend la dernière année isolée du titre ; ignore 1920x1080 et les numéros collés', () => {
    expect(detectYear('Blade.Runner.2049.2017.1080p')).toBe(2017);
    expect(yearMatches('Blade.Runner.2049.2017.1080p', 2017)).toBe(true);
    expect(detectYear('Film.1920x1080.mkv')).toBeUndefined();
    expect(detectYear('Film.2024p.mkv')).toBeUndefined();
  });
});

/** Frieren (série, TMDB 209867) : titres alternatifs TMDB (romaji, titre d'exportation) hors de `titles`. */
const FRIEREN: ContentRef = { type: 'series', id: 'tt9100001:1:5', imdbId: 'tt9100001', season: 1, episode: 5 };

const FRIEREN_ALTERNATIVES = [
  { iso_3166_1: 'JP', title: 'Sousou no Frieren', type: '' },
  { iso_3166_1: 'US', title: "Frieren: Beyond Journey's End", type: '' },
  { iso_3166_1: 'FR', title: 'Frieren, au-delà du voyage', type: '' },
  { iso_3166_1: 'JP', title: '  Sousou   no Frieren ', type: '' },
  { iso_3166_1: 'XX', title: '', type: '' },
];

function frierenTable(alternatives: unknown[] = FRIEREN_ALTERNATIVES): Record<string, Handler> {
  return {
    [`${API}/find/tt9100001?external_source=imdb_id`]: () => json({ movie_results: [], tv_results: [{ id: 209867 }] }),
    [`${API}/tv/209867?language=en-US&append_to_response=alternative_titles`]: () =>
      json({
        name: "Frieren: Beyond Journey's End",
        original_name: '葬送のフリーレン',
        first_air_date: '2023-09-29',
        alternative_titles: { results: alternatives },
      }),
    [`${API}/tv/209867?language=fr-FR`]: () =>
      json({ name: 'Frieren : Au-delà du voyage', original_name: '葬送のフリーレン', first_air_date: '2023-09-29' }),
  };
}

describe('getTitleVariants : titres alternatifs TMDB (aliases), hors des requêtes', () => {
  it('série : alternative_titles.results en alias, dédupliqués et nettoyés ; titles ne grossit pas et ne sert pas aux requêtes', async () => {
    const { fetch, mock } = tmdb(frierenTable());

    const variants = await getTitleVariants(FRIEREN, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants.aliases).toEqual(['Sousou no Frieren', 'Frieren, au-delà du voyage']);
    expect(variants.titles).toEqual(['葬送のフリーレン', "Frieren: Beyond Journey's End", 'Frieren : Au-delà du voyage']);
    expect(variants.titles).not.toContain('Sousou no Frieren');
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`${API}/tv/209867?language=en-US&append_to_response=alternative_titles`);
    expect(buildQueries(variants, FRIEREN).some((query) => query.includes('Sousou'))).toBe(false);
  });

  it('film : alternative_titles.titles en alias ; titres vides, non textuels ou déjà connus ignorés', async () => {
    const { fetch } = tmdb({
      ...duneTable(),
      [`${API}/movie/693134?language=en-US&append_to_response=alternative_titles`]: () =>
        json({
          title: 'Dune: Part Two',
          original_title: 'Dune: Part Two',
          release_date: '2024-02-27',
          alternative_titles: {
            titles: [
              { iso_3166_1: 'DE', title: 'Dune 2', type: '' },
              { iso_3166_1: 'US', title: 'Dune: Part Two', type: '' },
              { iso_3166_1: 'FR', title: '  Dune   2 ', type: '' },
              { iso_3166_1: 'ES', title: 'Dune Parte Dos', type: '' },
              { iso_3166_1: 'XX', title: '', type: '' },
              { iso_3166_1: 'XX', title: 42, type: '' },
            ],
          },
        }),
    });

    const variants = await getTitleVariants(MOVIE, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants.aliases).toEqual(['Dune 2', 'Dune Parte Dos']);
    expect(variants.titles).toEqual(['Dune: Part Two', 'Dune : Deuxième Partie']);
  });

  it('aliases limités à 30', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ iso_3166_1: 'XX', title: `Alias ${index + 1}`, type: '' }));
    const { fetch } = tmdb(frierenTable(many));

    const variants = await getTitleVariants(FRIEREN, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants.aliases).toHaveLength(30);
    expect(variants.aliases?.[0]).toBe('Alias 1');
    expect(variants.aliases?.at(-1)).toBe('Alias 30');
  });

  it('aliases mis en cache avec les titres : un second appel les renvoie sans appel TMDB', async () => {
    const cache = new TtlCache();
    const first = tmdb(frierenTable());
    await getTitleVariants(FRIEREN, { tmdbToken: TOKEN, fetch: first.fetch, cache });
    const offline = tmdb({});

    const second = await getTitleVariants(FRIEREN, { tmdbToken: TOKEN, fetch: offline.fetch, cache });

    expect(second.aliases).toEqual(['Sousou no Frieren', 'Frieren, au-delà du voyage']);
    expect(offline.mock).not.toHaveBeenCalled();
  });

  it('sans alias TMDB : aucun champ aliases', async () => {
    const { fetch } = tmdb(severanceTable());

    const variants = await getTitleVariants(SERIES, { tmdbToken: TOKEN, fetch, cache: new TtlCache() });

    expect(variants).not.toHaveProperty('aliases');
  });
});
