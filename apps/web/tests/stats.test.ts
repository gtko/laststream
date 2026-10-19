// Statistiques du profil (src/data/stats.ts) : agrégations pures. Dates construites en heure locale, donc indépendantes du fuseau.
import { describe, expect, it } from 'vitest';
import {
  computeStats, DETAIL_LIMIT, dayStreaks, daypartOf, lastMonths, localDayKey, median, META_CACHE_KEY, metaFromTmdb,
  pickDetailTargets, readMetaCache, titleMinutes, writeMetaCache, type TitleMeta, type TmdbTitleRaw,
} from '../src/data/stats';
import type { WatchedTitle } from '../src/data/watchedHistory';

const at = (y: number, mo: number, d: number, h = 12, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const movie = (id: number, watched: number, lastWatchedAt: number): WatchedTitle => ({ key: `movie:${id}`, type: 'movie', id, watched, lastWatchedAt });
const tv = (id: number, watched: number, lastWatchedAt: number): WatchedTitle => ({ key: `tv:${id}`, type: 'tv', id, watched, lastWatchedAt });

const meta = (key: string, over: Partial<TitleMeta> = {}): TitleMeta => ({
  key, name: key, year: 2000, runtime: 0, episodeRuntime: 0, episodes: 0, genres: [], people: [], ...over,
});

/** Maintenant : 19 octobre 2026, midi (un lundi). */
const NOW = at(2026, 10, 19);

describe('temps regardé', () => {
  it('additionne la durée TMDB d’un film et les épisodes vus × durée d’épisode', () => {
    const titles = [movie(1, 1, at(2026, 10, 1)), tv(2, 10, at(2026, 10, 2))];
    const metas = new Map([
      ['movie:1', meta('movie:1', { runtime: 120 })],
      ['tv:2', meta('tv:2', { episodeRuntime: 45, episodes: 20 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.totals.minutes).toBe(120 + 10 * 45);
    expect(s.totals.estimatedMinutes).toBe(0);
    expect(s.totals.detailed).toBe(2);
  });

  it('estime les titres non détaillés avec la médiane des titres détaillés', () => {
    const titles = [movie(1, 1, 0), movie(2, 1, 0), movie(3, 1, 0)];
    const metas = new Map([
      ['movie:1', meta('movie:1', { runtime: 90 })],
      ['movie:2', meta('movie:2', { runtime: 150 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.estimate.movieMinutes).toBe(120);
    expect(s.totals.minutes).toBe(90 + 150 + 120);
    expect(s.totals.estimatedMinutes).toBe(120);
  });

  it('sans aucune donnée TMDB : durées par défaut (110 min film, 45 min épisode)', () => {
    expect(titleMinutes(movie(1, 1, 0), undefined, { movieMinutes: 110, episodeMinutes: 45 })).toEqual({ minutes: 110, estimated: true });
    expect(titleMinutes(tv(2, 4, 0), undefined, { movieMinutes: 110, episodeMinutes: 45 })).toEqual({ minutes: 180, estimated: true });
  });

  it('median ignore les valeurs nulles et se replie sur la valeur par défaut', () => {
    expect(median([0, 0], 45)).toBe(45);
    expect(median([30, 0, 50, 40], 45)).toBe(40);
    expect(median([30, 50], 45)).toBe(40);
  });
});

describe('mois et jours', () => {
  it('lastMonths donne 12 mois, du plus ancien au plus récent', () => {
    const months = lastMonths(NOW);
    expect(months).toHaveLength(12);
    expect(months[0].key).toBe('2025-11');
    expect(months[11].key).toBe('2026-10');
  });

  it('range chaque titre dans le mois de sa dernière lecture ; un mois trop ancien sort de la fenêtre', () => {
    const titles = [
      movie(1, 1, at(2026, 10, 3)), // octobre 2026 : 120 min
      tv(2, 5, at(2026, 1, 15)), // janvier 2026 : 5 × 40 min
      movie(3, 1, at(2025, 9, 30)), // hors fenêtre (septembre 2025)
    ];
    const metas = new Map([
      ['movie:1', meta('movie:1', { runtime: 120 })],
      ['movie:3', meta('movie:3', { runtime: 100 })],
      ['tv:2', meta('tv:2', { episodeRuntime: 40, episodes: 10 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    const byKey = Object.fromEntries(s.months.map((m) => [m.key, m.minutes]));
    expect(byKey['2026-10']).toBe(120);
    expect(byKey['2026-01']).toBe(200);
    expect(Object.values(byKey).reduce((a, b) => a + b, 0)).toBe(320);
  });

  it('dayStreaks : série en cours qui se termine aujourd’hui, record plus ancien', () => {
    const stamps = [
      at(2026, 10, 1), at(2026, 10, 2), at(2026, 10, 3), at(2026, 10, 4), at(2026, 10, 5), // record : 5
      at(2026, 10, 17, 22), at(2026, 10, 18, 9), at(2026, 10, 19, 8), // en cours : 3
    ];
    expect(dayStreaks(stamps, NOW)).toEqual({ current: 3, best: 5 });
  });

  it('la série en cours tient si la dernière lecture est d’hier', () => {
    expect(dayStreaks([at(2026, 10, 17), at(2026, 10, 18)], NOW)).toEqual({ current: 2, best: 2 });
  });

  it('une lecture avant-hier rompt la série en cours', () => {
    expect(dayStreaks([at(2026, 10, 16), at(2026, 10, 17)], NOW)).toEqual({ current: 0, best: 2 });
  });

  it('plusieurs lectures le même jour ne comptent qu’une fois', () => {
    expect(dayStreaks([at(2026, 10, 19, 1), at(2026, 10, 19, 23)], NOW)).toEqual({ current: 1, best: 1 });
  });

  it('localDayKey et daypartOf suivent l’heure locale', () => {
    expect(localDayKey(at(2026, 3, 7, 23, 30))).toBe('2026-03-07');
    expect([daypartOf(7), daypartOf(14), daypartOf(20), daypartOf(2)]).toEqual([0, 1, 2, 3]);
  });

  it('jour de la semaine et tranche : d’après la dernière lecture (lundi en premier)', () => {
    // 17 octobre 2026 : un samedi, en soirée.
    const titles = [movie(1, 1, at(2026, 10, 17, 21))];
    const metas = new Map([['movie:1', meta('movie:1', { runtime: 100 })]]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.weekday).toEqual([0, 0, 0, 0, 0, 100, 0]);
    expect(s.dayparts).toEqual([0, 0, 100, 0]);
    expect(s.hasDates).toBe(true);
  });
});

describe('genres, décennies, personnes', () => {
  it('top genres : par nombre de titres, à égalité par ordre alphabétique, huit au plus', () => {
    const titles = [movie(1, 1, 0), movie(2, 1, 0), movie(3, 1, 0)];
    const metas = new Map([
      ['movie:1', meta('movie:1', { genres: ['Drame', 'Action'] })],
      ['movie:2', meta('movie:2', { genres: ['Drame', 'Thriller', 'Comédie', 'Horreur', 'Western', 'Policier', 'Animation', 'Histoire', 'Musique'] })],
      ['movie:3', meta('movie:3', { genres: ['Drame', 'Action'] })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.genres).toHaveLength(8);
    expect(s.genres[0]).toEqual({ name: 'Drame', count: 3 });
    expect(s.genres[1]).toEqual({ name: 'Action', count: 2 });
    // Les genres à un titre : ordre alphabétique (Animation avant Comédie).
    expect(s.genres.slice(2, 4).map((g) => g.name)).toEqual(['Animation', 'Comédie']);
  });

  it('décennies contiguës du début à la fin, avec les vides à zéro', () => {
    const titles = [movie(1, 1, 0), movie(2, 1, 0)];
    const metas = new Map([
      ['movie:1', meta('movie:1', { year: 1994 })],
      ['movie:2', meta('movie:2', { year: 2019 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.decades).toEqual([
      { decade: 1990, count: 1 }, { decade: 2000, count: 0 }, { decade: 2010, count: 1 },
    ]);
  });

  it('personnes : durée cumulée, rôle de réalisateur conservé, dix au plus', () => {
    const cast = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: 'Acteur ' + i, role: 'cast' as const }));
    const titles = [movie(1, 1, 0), tv(2, 4, 0)];
    const metas = new Map([
      ['movie:1', meta('movie:1', { runtime: 100, people: [{ id: 7, name: 'Réal', role: 'director' }, ...cast.slice(0, 6)] })],
      ['tv:2', meta('tv:2', { episodeRuntime: 50, episodes: 9, people: [{ id: 7, name: 'Réal', role: 'cast' }, ...cast.slice(6)] })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.people).toHaveLength(10);
    const real = s.people.find((p) => p.id === 7)!;
    expect(real).toMatchObject({ role: 'director', titles: 2, minutes: 100 + 200 });
    expect(s.people[0].id).toBe(7); // la plus grande durée
  });
});

describe('séries et repères', () => {
  it('séries terminées et en cours, série la plus regardée, dernier visionnage', () => {
    const titles = [
      tv(1, 10, at(2026, 10, 10)), // terminée (10/10)
      tv(2, 3, at(2026, 10, 18)), // en cours
      tv(3, 5, at(2026, 9, 1)), // non détaillée : en cours
      movie(4, 1, at(2026, 10, 12)),
    ];
    const metas = new Map([
      ['tv:1', meta('tv:1', { name: 'Série A', episodeRuntime: 40, episodes: 10 })],
      ['tv:2', meta('tv:2', { name: 'Série B', episodeRuntime: 30, episodes: 24 })],
      ['movie:4', meta('movie:4', { name: 'Film C', runtime: 90 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 2, now: NOW });
    expect(s.totals).toMatchObject({ movies: 1, episodes: 18, seriesDone: 1, seriesOngoing: 2, rated: 2, titles: 4, detailed: 3 });
    // La série non détaillée (5 épisodes) ne peut pas être « la plus regardée » : elle n'a pas de nom ; Série A (10 épisodes) gagne.
    expect(s.topSeries).toEqual({ key: 'tv:1', name: 'Série A', watched: 10, episodes: 10, complete: true, minutes: 400 });
    expect(s.lastWatch).toEqual({ key: 'tv:2', type: 'tv', name: 'Série B', at: at(2026, 10, 18) });
  });

  it('série la plus regardée parmi les titres détaillés, à égalité par durée', () => {
    const titles = [tv(1, 6, at(2026, 10, 1)), tv(2, 6, at(2026, 10, 2))];
    const metas = new Map([
      ['tv:1', meta('tv:1', { name: 'Courte', episodeRuntime: 20, episodes: 30 })],
      ['tv:2', meta('tv:2', { name: 'Longue', episodeRuntime: 60, episodes: 30 })],
    ]);
    const s = computeStats({ titles, metas, ratings: 0, now: NOW });
    expect(s.topSeries).toMatchObject({ name: 'Longue', watched: 6, complete: false, minutes: 360 });
  });

  it('une série est terminée quand le total TMDB est atteint', () => {
    const titles = [tv(1, 8, at(2026, 10, 1))];
    const metas = new Map([['tv:1', meta('tv:1', { name: 'Mini', episodeRuntime: 30, episodes: 8 })]]);
    expect(computeStats({ titles, metas, ratings: 0, now: NOW }).topSeries?.complete).toBe(true);
    expect(computeStats({ titles, metas, ratings: 0, now: NOW }).totals.seriesDone).toBe(1);
  });
});

describe('historique vide ou sans dates', () => {
  it('aucun titre vu : état vide, totaux à zéro', () => {
    const s = computeStats({ titles: [], metas: new Map(), ratings: 3, now: NOW });
    expect(s.empty).toBe(true);
    expect(s.hasDates).toBe(false);
    expect(s.totals).toMatchObject({ minutes: 0, movies: 0, episodes: 0, titles: 0, rated: 3 });
    expect(s.months).toHaveLength(12);
    expect(s.streak).toEqual({ current: 0, best: 0 });
    expect(s.topSeries).toBeNull();
    expect(s.lastWatch).toBeNull();
  });

  it('historique local (pas de dates) : totaux présents, rythme et repères vides', () => {
    const titles = [movie(1, 1, 0), tv(2, 3, 0)];
    const s = computeStats({ titles, metas: new Map(), ratings: 0, now: NOW });
    expect(s.empty).toBe(false);
    expect(s.hasDates).toBe(false);
    expect(s.totals.minutes).toBe(110 + 3 * 45);
    expect(s.weekday.every((m) => m === 0)).toBe(true);
    expect(s.months.every((m) => m.minutes === 0)).toBe(true);
    expect(s.lastWatch).toBeNull();
    expect(s.streak).toEqual({ current: 0, best: 0 });
  });

  it('les titres à zéro lecture sont ignorés', () => {
    const s = computeStats({ titles: [movie(1, 0, 0)], metas: new Map(), ratings: 0, now: NOW });
    expect(s.empty).toBe(true);
  });
});

describe('détail TMDB et cache', () => {
  it('pickDetailTargets : au plus DETAIL_LIMIT, les plus récents et les plus vus en alternance', () => {
    // 60 titres récents et peu vus, puis une série très vue ancienne : elle doit être détaillée.
    const recent = Array.from({ length: 60 }, (_, i) => movie(1000 + i, 1, at(2026, 10, 1) + i * 1000));
    const star = tv(9, 200, at(2025, 1, 1));
    const picked = pickDetailTargets([...recent, star]);
    expect(picked).toHaveLength(DETAIL_LIMIT);
    expect(picked.map((t) => t.key)).toContain('tv:9');
    expect(new Set(picked.map((t) => t.key)).size).toBe(DETAIL_LIMIT);
    expect(picked[0].key).toBe('movie:1059'); // le plus récent d'abord
  });

  it('metaFromTmdb : film (réalisateur, dix premiers acteurs) et série (créateur, épisodes)', () => {
    const cast = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: 'Acteur ' + i }));
    const film: TmdbTitleRaw = {
      title: 'Film', release_date: '1999-03-31', runtime: 136, genres: [{ name: 'Action' }, { name: '' }],
      credits: { cast, crew: [{ id: 50, name: 'Réalisatrice', job: 'Director' }, { id: 51, name: 'Monteur', job: 'Editor' }] },
    };
    const f = metaFromTmdb('movie', 'movie:1', film);
    expect(f).toMatchObject({ name: 'Film', year: 1999, runtime: 136, episodeRuntime: 0, episodes: 0, genres: ['Action'] });
    expect(f.people.filter((p) => p.role === 'cast')).toHaveLength(10);
    expect(f.people[0]).toEqual({ id: 50, name: 'Réalisatrice', role: 'director' });
    expect(f.people.some((p) => p.name === 'Monteur')).toBe(false);

    const show: TmdbTitleRaw = {
      name: 'Série', first_air_date: '2008-01-20', episode_run_time: [47], number_of_episodes: 62,
      created_by: [{ id: 90, name: 'Créateur' }], credits: { cast: [{ id: 91, name: 'Acteur' }] },
    };
    const t = metaFromTmdb('tv', 'tv:2', show);
    expect(t).toMatchObject({ name: 'Série', year: 2008, runtime: 0, episodeRuntime: 47, episodes: 62 });
    expect(t.people).toEqual([{ id: 90, name: 'Créateur', role: 'creator' }, { id: 91, name: 'Acteur', role: 'cast' }]);
  });

  it('le cache des fiches : aller-retour, entrées illisibles ignorées, 300 entrées au plus', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    const entries = new Map<string, { at: number; meta: TitleMeta }>();
    entries.set('movie:1', { at: 1000, meta: meta('movie:1', { name: 'Un' }) });
    writeMetaCache(storage, entries);
    expect(readMetaCache(storage).get('movie:1')).toEqual({ at: 1000, meta: meta('movie:1', { name: 'Un' }) });

    store.set(META_CACHE_KEY, '{pas du json');
    expect(readMetaCache(storage).size).toBe(0);
    store.set(META_CACHE_KEY, JSON.stringify({ 'movie:2': { at: 'x', meta: {} }, 'movie:3': { at: 5, meta: { name: 'Ok', genres: [], people: [] } } }));
    expect([...readMetaCache(storage).keys()]).toEqual(['movie:3']);

    const many = new Map<string, { at: number; meta: TitleMeta }>();
    for (let i = 0; i < 320; i++) many.set(`movie:${i}`, { at: i, meta: meta(`movie:${i}`) });
    writeMetaCache(storage, many);
    const kept = readMetaCache(storage);
    expect(kept.size).toBe(300);
    expect(kept.has('movie:319')).toBe(true);
    expect(kept.has('movie:0')).toBe(false);
  });
});
