import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache/ttl-cache.js';
import type { FetchFn } from '../src/sources/http.js';
import { filterByYear, getTitleVariants, movieNotYetDigital, movieReleaseFits, type TitleVariants } from '../src/sources/query-titles.js';
import type { ContentRef, RawStream } from '../src/types.js';

/** Année des films de ce fichier : 19 octobre 2026. Dates fixes, sans horloge réelle. */
const NOW = Date.UTC(2026, 9, 19, 12);
const API = 'https://api.themoviedb.org/3';
const TOKEN = 'tmdb-read-token-TEST';

/** « L'Odyssée » (2026, Nolan) : pas encore sortie en numérique. Homonymes : « The Odyssey » (1997, STV), ancien film. */
const ODYSSEY_IN_CINEMAS: TitleVariants = { titles: ["L'Odyssée", 'The Odyssey'], year: 2026, digitalKnown: true };
const ODYSSEY_DIGITAL: TitleVariants = { ...ODYSSEY_IN_CINEMAS, digitalDate: '2026-02-10' };
/** Film ancien (1995), sortie numérique passée. */
const HEAT: TitleVariants = { titles: ['Heat'], year: 1995, digitalKnown: true, digitalDate: '1996-04-01' };

const movie = (title: string): RawStream => ({ sourceName: 'test', sourceKind: 'torznab', title });

describe('films : année de la release (movieReleaseFits)', () => {
  it('film pas encore sorti en numérique : rejette l’homonyme d’une autre année et la release sans année', () => {
    expect(movieNotYetDigital(ODYSSEY_IN_CINEMAS, NOW)).toBe(true);
    expect(movieReleaseFits('The.Odyssey.1997.STV.DVDRip', ODYSSEY_IN_CINEMAS, NOW)).toBe(false);
    expect(movieReleaseFits('The.Odyssey.1968.1080p', ODYSSEY_IN_CINEMAS, NOW)).toBe(false);
    expect(movieReleaseFits('The.Odyssey.STV.1080p.WEB', ODYSSEY_IN_CINEMAS, NOW)).toBe(false);
  });

  it('film pas encore sorti en numérique : garde l’année exacte', () => {
    expect(movieReleaseFits('The.Odyssey.2026.2160p.WEB-DL', ODYSSEY_IN_CINEMAS, NOW)).toBe(true);
    expect(movieReleaseFits('The.Odyssey.2025.1080p', ODYSSEY_IN_CINEMAS, NOW)).toBe(false);
  });

  it('film sorti en numérique : année à ±1 an de la sortie originale ou numérique ; hors fenêtre, écartée', () => {
    expect(movieNotYetDigital(ODYSSEY_DIGITAL, NOW)).toBe(false);
    expect(movieReleaseFits('The.Odyssey.2026.1080p', ODYSSEY_DIGITAL, NOW)).toBe(true);
    expect(movieReleaseFits('The.Odyssey.1997.1080p', ODYSSEY_DIGITAL, NOW)).toBe(false);
  });

  it('film ancien, correctement apparié : l’année à ±1 an passe, sans année passe, une autre année est écartée', () => {
    expect(movieNotYetDigital(HEAT, NOW)).toBe(false);
    expect(movieReleaseFits('Heat.1995.1080p.BluRay', HEAT, NOW)).toBe(true);
    expect(movieReleaseFits('Heat.1996.DVDRip', HEAT, NOW)).toBe(true);
    expect(movieReleaseFits('Heat.BluRay.x264', HEAT, NOW)).toBe(true);
    expect(movieReleaseFits('Heat.2001.1080p', HEAT, NOW)).toBe(false);
  });

  it('ancien film sans date numérique dans TMDB : pas « pas encore disponible » (hors fenêtre récente)', () => {
    const old: TitleVariants = { titles: ['Old Film'], year: 1994, digitalKnown: true };
    expect(movieNotYetDigital(old, NOW)).toBe(false);
    expect(movieReleaseFits('Old.Film.1995.DVDRip', old, NOW)).toBe(true);
  });

  it('sans donnée de sortie TMDB (digitalKnown absent) : règle de l’année à ±1 an seulement', () => {
    const plain: TitleVariants = { titles: ['Plain'], year: 2026 };
    expect(movieNotYetDigital(plain, NOW)).toBe(false);
    expect(movieReleaseFits('Plain.STV.1080p', plain, NOW)).toBe(true);
  });
});

describe('films : filterByYear', () => {
  it('ne garde que les releases compatibles avec l’année du film pas encore sorti', () => {
    const streams = [movie('The.Odyssey.1997.STV.DVDRip'), movie('The.Odyssey.2026.2160p.WEB'), movie('The.Odyssey.STV.1080p')];
    const kept = filterByYear(streams, { type: 'movie', id: 'tt1', imdbId: 'tt1' } as ContentRef, ODYSSEY_IN_CINEMAS, NOW);
    expect(kept.map((s) => s.title)).toEqual(['The.Odyssey.2026.2160p.WEB']);
  });

  it('séries : liste inchangée', () => {
    const streams = [movie('Show.1997.S01E01')];
    const series = { type: 'series', id: 'tt2', imdbId: 'tt2', season: 1, episode: 1 } as ContentRef;
    expect(filterByYear(streams, series, ODYSSEY_IN_CINEMAS, NOW)).toBe(streams);
  });
});

/** TMDB simulé : une réponse par URL exacte. */
function tmdb(table: Record<string, unknown>): FetchFn {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const body = table[String(input)];
    return body === undefined ? new Response('unexpected', { status: 500 }) : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as FetchFn;
}

const FILM: ContentRef = { type: 'movie', id: 'tt9999001', imdbId: 'tt9999001' };

function filmTable(releaseDates: unknown, providers?: unknown): Record<string, unknown> {
  const table: Record<string, unknown> = {
    [`${API}/find/tt9999001?external_source=imdb_id`]: { movie_results: [{ id: 999 }], tv_results: [] },
    [`${API}/movie/999?language=en-US&append_to_response=alternative_titles`]: { title: "L'Odyssée", original_title: 'The Odyssey', release_date: '2026-07-17' },
    [`${API}/movie/999?language=fr-FR`]: { title: "L'Odyssée", original_title: 'The Odyssey', release_date: '2026-07-17' },
    [`${API}/movie/999/release_dates`]: releaseDates,
  };
  if (providers !== undefined) table[`${API}/movie/999/watch/providers`] = providers;
  return table;
}

describe('getTitleVariants : dates de sortie des films', () => {
  it('sortie numérique FR future ou absente : digitalKnown, sans date passée', async () => {
    const releases = { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: '2026-07-17T00:00:00.000Z' }] }] };
    const variants = await getTitleVariants(FILM, { tmdbToken: TOKEN, fetch: tmdb(filmTable(releases)), cache: new TtlCache() });
    expect(variants.year).toBe(2026);
    expect(variants.digitalKnown).toBe(true);
    expect(variants.digitalDate).toBeUndefined();
    expect(movieNotYetDigital(variants, NOW)).toBe(true);
  });

  it('sortie numérique FR : date (AAAA-MM-JJ) retenue ; région FR vide : repli US', async () => {
    const fr = { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: '2026-11-18T00:00:00.000Z' }] }] };
    const variants = await getTitleVariants(FILM, { tmdbToken: TOKEN, fetch: tmdb(filmTable(fr)), cache: new TtlCache() });
    expect(variants.digitalDate).toBe('2026-11-18');

    const us = { results: [{ iso_3166_1: 'US', release_dates: [{ type: 5, release_date: '2026-09-01T00:00:00.000Z' }] }] };
    const fallback = await getTitleVariants(FILM, { tmdbToken: TOKEN, fetch: tmdb(filmTable(us)), cache: new TtlCache() });
    expect(fallback.digitalDate).toBe('2026-09-01');
    expect(movieNotYetDigital(fallback, NOW)).toBe(false);
  });

  it('fournisseur dans la région (watch/providers) : pas « pas encore disponible », même sans date numérique', async () => {
    const releases = { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: '2026-07-17T00:00:00.000Z' }] }] };
    const providers = { results: { FR: { flatrate: [{ provider_name: 'Svc' }] } } };
    const variants = await getTitleVariants(FILM, { tmdbToken: TOKEN, fetch: tmdb(filmTable(releases, providers)), cache: new TtlCache() });
    expect(variants.watchable).toBe(true);
    expect(movieNotYetDigital(variants, NOW)).toBe(false);
    expect(movieReleaseFits('The.Odyssey.STV.1080p', variants, NOW)).toBe(true);
  });

  it('appel release_dates en échec : digitalKnown absent, résultat toujours utilisable', async () => {
    const variants = await getTitleVariants(FILM, { tmdbToken: TOKEN, fetch: tmdb(filmTable(undefined)), cache: new TtlCache() });
    expect(variants.digitalKnown).toBeUndefined();
    expect(variants.year).toBe(2026);
    expect(movieNotYetDigital(variants, NOW)).toBe(false);
  });
});
