import { describe, expect, it } from 'vitest';
import { normTitle, rankResults, titleMatch } from '../src/ui/searchRank.js';

const TODAY = '2026-10-18';
const movie = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  media_type: 'movie', id, title, original_title: title, popularity: 10, vote_count: 500, release_date: '1990-01-01', ...extra,
});
const tv = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  media_type: 'tv', id, name, original_name: name, popularity: 10, vote_count: 500, first_air_date: '1990-01-01', ...extra,
});
const titles = (list: any[]) => list.map((r) => r.title ?? r.name);

describe('recherche : normalisation et correspondance', () => {
  it('ignore casse, accents et ponctuation', () => {
    expect(normTitle('Amélie')).toBe('amelie');
    expect(normTitle('Star Trek: Strange New Worlds')).toBe('star trek strange new worlds');
    expect(normTitle('L’Équipe')).toBe('l equipe');
  });

  it('donne 100 pour une correspondance exacte, 60 pour un préfixe, 35 pour tous les mots, 20 pour un contenu', () => {
    expect(titleMatch(movie(1, 'Dune'), 'dune')).toBe(100);
    expect(titleMatch(movie(1, 'Dune: Part Two'), 'dune')).toBe(60);
    expect(titleMatch(movie(1, 'The Lord of the Rings'), 'rings lord')).toBe(35);
    expect(titleMatch(movie(1, 'Blade Runner'), 'runner')).toBe(35);
    expect(titleMatch(movie(1, 'Blade Runner'), 'lade runn')).toBe(20);
    expect(titleMatch(movie(1, 'Alien'), 'dune')).toBe(0);
  });

  it('retient le titre original quand il correspond exactement', () => {
    const r = { media_type: 'movie', id: 9, title: 'Le Fabuleux Destin', original_title: 'Amélie' };
    expect(titleMatch(r, 'amelie')).toBe(100);
  });
});

describe('rankResults', () => {
  it('« star trek » : la série de 1966 (titre exact) passe avant la suite Strange New Worlds', () => {
    const results = [
      tv(65000, 'Star Trek: Strange New Worlds', { popularity: 300, vote_count: 1200, first_air_date: '2022-05-05' }),
      movie(1, 'Star Trek', { popularity: 30, vote_count: 4000, release_date: '1979-12-07' }),
      tv(253, 'Star Trek', { popularity: 40, vote_count: 3000, first_air_date: '1966-09-08' }),
    ];
    const out = rankResults(results, 'star trek', { today: TODAY });
    expect(out.map((r: any) => r.id)).toEqual([253, 1, 65000]);
  });

  it('« dune » : Dune (2021, populaire) passe avant un Dune obscur sans votes', () => {
    const results = [
      movie(999, 'Dune', { popularity: 0.6, vote_count: 0, release_date: '1984-01-01' }),
      movie(438631, 'Dune', { popularity: 150, vote_count: 9000, release_date: '2021-09-15' }),
    ];
    const out = rankResults(results, 'dune', { today: TODAY });
    expect(out.map((r: any) => r.id)).toEqual([438631, 999]);
  });

  it('« amelie » trouve « Amélie » en correspondance exacte, sans accent', () => {
    const results = [
      movie(1, 'Amélie', { popularity: 20, vote_count: 6000 }),
      movie(2, 'Amélie et la métaphysique des tubes', { popularity: 25, vote_count: 900 }),
    ];
    const out = rankResults(results, 'amelie', { today: TODAY });
    expect(out.map((r: any) => r.id)).toEqual([1, 2]);
  });

  it('le titre original exact passe avant un simple préfixe de titre', () => {
    const results = [
      movie(1, 'Parasites : le film', { original_title: 'Parasites', popularity: 50, vote_count: 800 }),
      movie(2, 'Le Parasite', { original_title: 'Parasite', popularity: 5, vote_count: 80 }),
    ];
    const out = rankResults(results, 'parasite', { today: TODAY });
    expect(out.map((r: any) => r.id)).toEqual([2, 1]);
  });

  it('dédoublonne par type et identifiant, sans confondre un film et une série de même id', () => {
    const results = [movie(7, 'Alpha'), movie(7, 'Alpha (doublon)'), tv(7, 'Alpha')];
    const out = rankResults(results, 'alpha', { today: TODAY });
    expect(out).toHaveLength(2);
    expect(out.map((r: any) => r.media_type)).toEqual(['movie', 'tv']);
  });

  it('classe les personnes après les titres, par correspondance puis popularité', () => {
    const results = [
      { media_type: 'person', id: 10, name: 'Ryan Gosling', popularity: 80 },
      movie(1, 'Gosling Story', { popularity: 3, vote_count: 10 }),
      { media_type: 'person', id: 11, name: 'Gosling Fan Club', popularity: 2 },
      { media_type: 'person', id: 12, name: 'Ryan Gosling Jr', popularity: 1 },
    ];
    const out = rankResults(results, 'gosling', { today: TODAY });
    // Titre d'abord ; puis « Gosling Fan Club » (préfixe), « Ryan Gosling » (mots), « Ryan Gosling Jr » (mots, moins populaire).
    expect(out.map((r: any) => r.id)).toEqual([1, 11, 10, 12]);
  });

  it('pénalise les titres avec moins de 5 votes et donne un léger bonus aux sorties récentes', () => {
    const recent = movie(1, 'Nova', { popularity: 5, vote_count: 40, release_date: '2025-06-01' });
    const old = movie(2, 'Nova', { popularity: 5, vote_count: 40, release_date: '1980-06-01' });
    const unvoted = movie(3, 'Nova', { popularity: 5, vote_count: 2, release_date: '1980-06-01' });
    const out = rankResults([unvoted, old, recent], 'nova', { today: TODAY });
    expect(out.map((r: any) => r.id)).toEqual([1, 2, 3]);
  });

  it('à score égal, garde l’ordre TMDB', () => {
    const results = [movie(1, 'Océan', { popularity: 4, vote_count: 50 }), movie(2, 'Océan', { popularity: 4, vote_count: 50 })];
    expect(rankResults(results, 'ocean', { today: TODAY }).map((r: any) => r.id)).toEqual([1, 2]);
  });

  it('ne modifie pas la liste d’origine et tolère une liste vide', () => {
    const results = [movie(1, 'A'), movie(2, 'B')];
    const copy = results.slice();
    rankResults(results, 'b', { today: TODAY });
    expect(results).toEqual(copy);
    expect(rankResults([], 'x', { today: TODAY })).toEqual([]);
    expect(rankResults(undefined as any, 'x')).toEqual([]);
  });
});
