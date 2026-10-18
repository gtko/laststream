import { describe, expect, it } from 'vitest';
import type { HiddenEntry } from '../src/data/homeFilters';
import { foldText, hiddenCounts, hiddenView } from '../src/data/hiddenView';

const WORDS = ['Amélie Poulain', 'Été 42', 'Éléphant', 'Zorro', 'Œuvre', 'Lawrence d’Arabie', 'Ça', 'Nosferatu', 'Hôtel', 'Ëmile'];
const BIG: HiddenEntry[] = Array.from({ length: 5000 }, (_, i) => ({
  key: (i % 3 === 0 ? 'tv:' : 'movie:') + (100000 + i),
  title: WORDS[i % WORDS.length] + ' ' + i,
  poster: i % 7 === 0 ? '' : '/p' + i + '.jpg',
  addedAt: 1700000000000 + ((i * 7919) % 5000) * 1000,
}));
const yearOf = (key: string): string => (Number(key.split(':')[1]) % 4 === 0 ? '' : String(1960 + (Number(key.split(':')[1]) % 60)));

describe('recherche sans accents ni casse', () => {
  it('foldText retire les accents et met en minuscules', () => {
    expect(foldText('  Amélie   Poulain ')).toBe('amelie poulain');
    expect(foldText('ŒUVRE Ça')).toBe('oeuvre ca');
  });

  it('le texte cherché retrouve un titre accentué, quelle que soit la casse', () => {
    const list: HiddenEntry[] = [
      { key: 'movie:1', title: 'Amélie Poulain', poster: '', addedAt: 1 },
      { key: 'tv:2', title: 'Été 42', poster: '', addedAt: 2 },
      { key: 'movie:3', title: 'Zorro', poster: '', addedAt: 3 },
    ];
    expect(hiddenView(list, { query: 'AMELIE' }).map((h) => h.key)).toEqual(['movie:1']);
    expect(hiddenView(list, { query: 'ete' }).map((h) => h.key)).toEqual(['tv:2']);
    expect(hiddenView(list, { query: '   ' })).toHaveLength(3);
  });
});

describe('filtre par type et compteurs', () => {
  it('compteurs total, films et séries, pour le texte cherché', () => {
    const all = hiddenCounts(BIG);
    expect(all.all).toBe(5000);
    expect(all.movie + all.tv).toBe(5000);
    expect(all.tv).toBe(BIG.filter((h) => h.key.startsWith('tv:')).length);
    const q = hiddenCounts(BIG, 'zorro');
    expect(q.all).toBe(q.movie + q.tv);
    expect(q.all).toBe(BIG.filter((h) => foldText(h.title).includes('zorro')).length);
  });

  it('type « Séries » ne garde que les clés tv:', () => {
    const tv = hiddenView(BIG, { type: 'tv' });
    expect(tv.length).toBe(hiddenCounts(BIG).tv);
    expect(tv.every((h) => h.key.startsWith('tv:'))).toBe(true);
  });
});

describe('tri', () => {
  it('« Masqués récemment » : le plus récent d’abord', () => {
    const out = hiddenView(BIG, { sort: 'recent' });
    for (let i = 1; i < out.length; i++) expect(out[i - 1].addedAt).toBeGreaterThanOrEqual(out[i].addedAt);
  });

  it('« Titre A→Z » ignore les accents et la casse', () => {
    const list: HiddenEntry[] = [
      { key: 'movie:1', title: 'Zorro', poster: '', addedAt: 1 },
      { key: 'movie:2', title: 'Été', poster: '', addedAt: 2 },
      { key: 'movie:3', title: 'alpha', poster: '', addedAt: 3 },
      { key: 'movie:4', title: 'Ecume', poster: '', addedAt: 4 },
    ];
    expect(hiddenView(list, { sort: 'title' }).map((h) => h.title)).toEqual(['alpha', 'Ecume', 'Été', 'Zorro']);
  });

  it('« Année » : les plus récentes d’abord, les titres sans année en dernier', () => {
    const out = hiddenView(BIG, { sort: 'year', yearOf });
    const years = out.map((h) => yearOf(h.key));
    const firstUnknown = years.indexOf('');
    expect(firstUnknown).toBeGreaterThan(0);
    expect(years.slice(firstUnknown).every((y) => y === '')).toBe(true);
    const known = years.slice(0, firstUnknown).map(Number);
    for (let i = 1; i < known.length; i++) expect(known[i - 1]).toBeGreaterThanOrEqual(known[i]);
  });

  it('ne modifie pas la liste d’origine', () => {
    const copy = BIG.slice();
    hiddenView(BIG, { sort: 'title', query: 'a', type: 'movie' });
    expect(BIG).toEqual(copy);
  });
});

describe('performance sur 5000 entrées', () => {
  it('filtre, tri et compteurs en moins de 50 ms', () => {
    hiddenView(BIG, { query: 'warm', sort: 'title', yearOf }); // amorce le cache de mise en forme
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      hiddenCounts(BIG, 'ele');
      hiddenView(BIG, { query: 'ele', type: 'movie', sort: 'title', yearOf });
      hiddenView(BIG, { query: 'ele', type: 'all', sort: 'year', yearOf });
      hiddenView(BIG, { type: 'tv', sort: 'recent' });
      runs.push(performance.now() - t0);
    }
    expect(Math.max(...runs)).toBeLessThan(50);
  });
});
