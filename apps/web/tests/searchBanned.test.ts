import { describe, expect, it } from 'vitest';
import { rankResults, splitBanned } from '../src/ui/searchRank.js';

const TODAY = '2026-10-18';
const BANNED = new Set([27]); // horreur
type Raw = { id: number; genre_ids?: number[] };
const isBanned = (r: object): boolean => ((r as Raw).genre_ids ?? []).some((g) => BANNED.has(g));
const idsOf = (list: object[]): number[] => list.map((r) => (r as Raw).id);

const movie = (id: number, title: string, genre_ids: number[], extra: Record<string, unknown> = {}): object => ({
  id,
  media_type: 'movie',
  title,
  original_title: title,
  popularity: 10,
  vote_count: 500,
  release_date: '2010-01-01',
  genre_ids,
  ...extra,
});

describe('résultats de genre banni dans la recherche', () => {
  it('garde l’ordre du classement dans chaque groupe', () => {
    const list = [movie(1, 'A', [27]), movie(2, 'B', [18]), movie(3, 'C', [27]), movie(4, 'D', [35])];
    const { keep, banned } = splitBanned(list, isBanned);
    expect(idsOf(keep)).toEqual([2, 4]);
    expect(idsOf(banned)).toEqual([1, 3]);
  });

  it('le meilleur résultat n’est jamais banni tant qu’un autre résultat ne l’est pas', () => {
    const raw = [
      movie(1, 'Dune', [27], { popularity: 900, vote_count: 9000 }), // exact et très populaire, mais banni
      movie(2, 'Dune Films', [878], { popularity: 50 }),
    ];
    const ranked = rankResults(raw, 'Dune', { today: TODAY });
    expect(idsOf(ranked)[0]).toBe(1); // le classement seul le met en tête
    const { keep, banned } = splitBanned(ranked, isBanned);
    const ordered = [...keep, ...banned];
    expect(isBanned(ordered[0])).toBe(false);
    expect(idsOf(ordered)).toEqual([2, 1]);
  });

  it('si tous les résultats sont bannis, ils gardent leur ordre et aucun n’est écarté', () => {
    const list = [movie(5, 'X', [27]), movie(6, 'Y', [27, 53])];
    const { keep, banned } = splitBanned(list, isBanned);
    expect(keep).toEqual([]);
    expect(idsOf(banned)).toEqual([5, 6]);
  });

  it('une liste vide ou absente donne deux groupes vides', () => {
    expect(splitBanned([], isBanned)).toEqual({ keep: [], banned: [] });
    expect(splitBanned(null as unknown as object[], isBanned)).toEqual({ keep: [], banned: [] });
  });
});
