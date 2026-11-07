// Préchargement de l'épisode à regarder (ODY-260) : un seul à la fois, aucun doublon avec la feuille « Télécharger », aucune
// rafale. La recherche d'addons (fetchStreamsResult) et la résolution IMDb sont simulées ; le temps l'est aussi (fake timers).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userStore } from '../src/data/userStore';
import { clearSourceCache, loadSources, preloadSources } from '../src/sources/load';

const h = vi.hoisted(() => ({ fetched: [] as number[] }));

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return {
    ...actual,
    fetchStreamsResult: vi.fn((_type: string, _imdb: string, _season: number | null, episode: number | null) => {
      h.fetched.push(episode ?? -1);
      return new Promise((resolve) => setTimeout(() => resolve({ streams: [], pending: [] }), 5));
    }),
  };
});

vi.mock('../src/data/imdbResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/imdbResolve')>();
  return { ...actual, resolveImdbId: vi.fn(() => Promise.resolve({ imdb: 'tt0944947', failed: false, tried: [] })) };
});

let preloadNextEpisode: typeof import('../src/ui/ficheSections.js').preloadNextEpisode;

// Le module de fiche lit le DOM à l'import : la page (index.html) doit exister avant de le charger.
beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  ({ preloadNextEpisode } = await import('../src/ui/ficheSections.js'));
});

const req = (episode: number) => ({ type: 'tv' as const, id: '1399', name: 'Série', season: 1, episode, key: 'tv:1399' });
const series = { key: 'tv:1399', type: 'tv', id: 1399, name: 'Série', seasons: [{ season_number: 1, episode_count: 3, air_date: '2001-01-01' }] };
const eps = (airDate = '2001-01-01') => [
  { episode_number: 1, air_date: airDate },
  { episode_number: 2, air_date: airDate },
  { episode_number: 3, air_date: airDate },
];
const TODAY = '2026-10-23';

/** Fait tourner le temps simulé : la recherche simulée (5 ms) et les promesses qui en découlent se terminent. */
const settle = () => vi.advanceTimersByTimeAsync(50);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearSourceCache();
  h.fetched = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('préchargement de l’épisode à regarder (ODY-260)', () => {
  it('ouverture de la saison : les sources de l’épisode à regarder sont cherchées une fois', async () => {
    preloadNextEpisode(series, 1, eps(), TODAY);
    await settle();
    expect(h.fetched).toEqual([1]);
  });

  it('autre saison que celle à regarder, ou épisode pas encore diffusé : rien n’est cherché', async () => {
    preloadNextEpisode(series, 2, eps(), TODAY);
    preloadNextEpisode(series, 1, eps('2030-01-01'), TODAY);
    await settle();
    expect(h.fetched).toEqual([]);
  });

  it('épisode déjà vu : rien n’est cherché, même quand c’est le dernier diffusé', async () => {
    await userStore.setWatched(series.key, [{ season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 1, episode: 3 }], true);
    preloadNextEpisode(series, 1, eps(), TODAY);
    await settle();
    expect(h.fetched).toEqual([]);
  });

  it('un seul préchargement à la fois : les demandes pendant la recherche sont ignorées (aucune rafale)', async () => {
    expect(preloadSources(req(2))).toBe(true);
    expect(preloadSources(req(3))).toBe(false);
    expect(preloadSources(req(1))).toBe(false);
    await settle();
    expect(h.fetched).toEqual([2]);
  });

  it('le préchargement suivant part une fois le précédent terminé', async () => {
    preloadSources(req(2));
    await settle();
    expect(preloadSources(req(3))).toBe(true);
    await settle();
    expect(h.fetched).toEqual([2, 3]);
  });

  it('pas de doublon : la feuille « Télécharger » reprend la recherche préchargée sans nouvelle requête', async () => {
    preloadSources(req(2));
    const pending = loadSources(req(2));
    await settle();
    await pending;
    expect(h.fetched).toEqual([2]);
  });

  it('déjà en cache : un nouveau préchargement du même épisode ne relance pas la recherche', async () => {
    preloadSources(req(2));
    await settle();
    expect(preloadSources(req(3))).toBe(true); // le premier est fini, son résultat est en cache
    await settle();
    expect(preloadSources(req(2))).toBe(false);
    await settle();
    expect(h.fetched).toEqual([2, 3]);
  });
});
