import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import {
  buildQueries,
  detectYear,
  getTitleVariants,
  stripAccents,
  stripPunctuation,
  yearMatches,
  type TitleCache,
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
    [`${API}/movie/693134?language=en-US`]: () =>
      json({ title: 'Dune: Part Two', original_title: 'Dune: Part Two', release_date: '2024-02-27' }),
    [`${API}/movie/693134?language=fr-FR`]: () =>
      json({ title: 'Dune : Deuxième Partie', original_title: 'Dune: Part Two', release_date: '2024-02-27' }),
  };
}

/** Severance (TMDB 4242) : série dont les titres anglais et français sont identiques. */
function severanceTable(): Record<string, Handler> {
  return {
    [`${API}/find/tt9000001?external_source=imdb_id`]: () => json({ movie_results: [], tv_results: [{ id: 4242 }] }),
    [`${API}/tv/4242?language=en-US`]: () =>
      json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
    [`${API}/tv/4242?language=fr-FR`]: () =>
      json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
  };
}

describe('getTitleVariants : TMDB (en-US, fr-FR, original)', () => {
  it('film : original, anglais et français dédupliqués, année de sortie ; jeton en Bearer, jamais dans l’URL', async () => {
    const { fetch, mock } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, { tmdbToken: TOKEN, fetch, cache: new Map() });

    expect(variants).toEqual({ titles: ['Dune: Part Two', 'Dune : Deuxième Partie'], year: 2024 });
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`${API}/movie/693134?language=en-US`);
    expect(urls).toContain(`${API}/movie/693134?language=fr-FR`);
    expect(urls.some((url) => url.includes(TOKEN))).toBe(false);
    const init = mock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('série : name et original_name (dédupliqués), année de première diffusion', async () => {
    const { fetch } = tmdb(severanceTable());

    const variants = await getTitleVariants(SERIES, { tmdbToken: TOKEN, fetch, cache: new Map() });

    expect(variants).toEqual({ titles: ['Severance'], year: 2022 });
  });

  it('sans jeton : aucun appel TMDB, repli sur fallbackTitle', async () => {
    const { fetch, mock } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, {
      fetch,
      cache: new Map(),
      fallbackTitle: { title: 'Dune Part Two', year: 2024 },
    });

    expect(variants).toEqual({ titles: ['Dune Part Two'], year: 2024 });
    expect(mock).not.toHaveBeenCalled();
  });

  it('TMDB en erreur : repli sur fallbackTitle, sans lever, et résultat non mis en cache', async () => {
    const cache: TitleCache = new Map();
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
      cache: new Map(),
      fallbackTitle: { title: 'Dune Part Two' },
    });

    expect(variants).toEqual({ titles: ['Dune Part Two'] });
  });

  it('le titre de repli s’ajoute aux titres TMDB sans doublon', async () => {
    const { fetch } = tmdb(duneTable());

    const variants = await getTitleVariants(MOVIE, {
      tmdbToken: TOKEN,
      fetch,
      cache: new Map(),
      fallbackTitle: { title: 'dune: part two' },
    });

    expect(variants.titles).toEqual(['Dune: Part Two', 'Dune : Deuxième Partie']);
  });
});

describe('getTitleVariants : cache de 7 jours (horloge injectée)', () => {
  it('résultat réutilisé pendant 7 jours, puis rechargé', async () => {
    let clock = 1_700_000_000_000;
    const { fetch, mock } = tmdb(duneTable());
    const cache: TitleCache = new Map();
    const options = { tmdbToken: TOKEN, fetch, cache, now: () => clock };

    await getTitleVariants(MOVIE, options);
    expect(mock).toHaveBeenCalledTimes(3); // find, en-US, fr-FR

    clock += SEVEN_DAYS_MS - 1;
    await getTitleVariants(MOVIE, options);
    expect(mock).toHaveBeenCalledTimes(3);

    clock += 1; // exactement 7 jours : expiré
    const again = await getTitleVariants(MOVIE, options);
    expect(mock).toHaveBeenCalledTimes(6);
    expect(again.titles).toEqual(['Dune: Part Two', 'Dune : Deuxième Partie']);
  });
});

describe('buildQueries', () => {
  it('film : titres tels quels, puis sans accents, sans ponctuation, sans accents ni ponctuation ; année ajoutée', () => {
    const queries = buildQueries({ titles: ['Dune: Part Two', 'Dune : Deuxième Partie'], year: 2024 }, MOVIE);

    expect(queries).toEqual([
      'Dune: Part Two 2024',
      'Dune : Deuxième Partie 2024',
      'Dune : Deuxieme Partie 2024',
      'Dune Part Two 2024',
      'Dune Deuxième Partie 2024',
      'Dune Deuxieme Partie 2024',
    ]);
  });

  it('film sans année : le titre seul', () => {
    expect(buildQueries({ titles: ['Dune'] }, MOVIE)).toEqual(['Dune']);
  });

  it('série épisode : « Titre S01E02 », « Titre Saison 1 », « Titre S01 » (pack), variantes sans accents', () => {
    const queries = buildQueries({ titles: ['Le Problème à trois corps'] }, EPISODE);

    expect(queries).toEqual([
      'Le Problème à trois corps S01E02',
      'Le Problème à trois corps Saison 1',
      'Le Problème à trois corps S01',
      'Le Probleme a trois corps S01E02',
      'Le Probleme a trois corps Saison 1',
      'Le Probleme a trois corps S01',
    ]);
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

    expect(queries).toHaveLength(8);
    expect(queries.slice(0, 5)).toEqual(['A: B 2024', 'C-D 2024', 'E F 2024', 'G’H 2024', 'I.J 2024']);
    expect(queries[5]).toBe('A B 2024');
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
