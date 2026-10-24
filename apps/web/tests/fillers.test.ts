// Épisodes filler et récap d'anime : marquage, enchaînement, « prochain non vu », badge et réglage (ODY-302).
import { beforeEach, describe, expect, it } from 'vitest';
import { applyFillers, autoNextEpisode, firstUnseen, type EpisodeInfo } from '../src/player/episodes';
import { episodesHtml } from '../src/player/panels';
import { getSkipPref, setSkipPref } from '../src/data/prefs';
import { applyPrefs, snapshotPrefs } from '../src/data/prefsSync';

const ep = (episode: number, extra: Partial<EpisodeInfo> = {}): EpisodeInfo => ({
  episode, name: 'É' + episode, runtime: null, overview: '', still: '', airDate: '2020-01-01', aired: true, playable: true, ...extra,
});

/** Saison 1 : 1 canon, 2-3 filler, 4 canon ; saison 2 : 1 récap, 2 canon. */
const series = (): Map<number, EpisodeInfo[]> => {
  const eps = new Map<number, EpisodeInfo[]>([[1, [ep(1), ep(2), ep(3), ep(4)]], [2, [ep(1), ep(2)]]]);
  applyFillers(eps, { fillers: [
    { season: 1, episode: 2, kind: 'filler' }, { season: 1, episode: 3, kind: 'filler' }, { season: 2, episode: 1, kind: 'recap' },
  ] });
  return eps;
};

describe('applyFillers', () => {
  it('marque les épisodes connus et ignore le reste', () => {
    const eps = new Map<number, EpisodeInfo[]>([[1, [ep(1), ep(2)]]]);
    applyFillers(eps, { fillers: [
      { season: 1, episode: 2, kind: 'recap' }, { season: 1, episode: 9, kind: 'filler' }, { season: 1, episode: 1, kind: 'canon' }, null, 'x',
    ] });
    expect(eps.get(1)!.map((e) => e.filler)).toEqual([undefined, 'recap']);
  });
  it('réponse inexploitable : rien ne change', () => {
    const eps = new Map<number, EpisodeInfo[]>([[1, [ep(1)]]]);
    for (const r of [null, undefined, {}, { fillers: 'x' }, []]) applyFillers(eps, r);
    expect(eps.get(1)![0].filler).toBeUndefined();
  });
});

describe('autoNextEpisode avec skipFillers', () => {
  it('réglage inactif : le filler est enchaîné comme avant', () => {
    expect(autoNextEpisode({ season: 1, episode: 2 }, series())).toEqual({ season: 1, episode: 2 });
  });
  it('saute les fillers de la saison', () => {
    expect(autoNextEpisode({ season: 1, episode: 2 }, series(), true)).toEqual({ season: 1, episode: 4 });
  });
  it('saute un récap en début de saison suivante', () => {
    expect(autoNextEpisode({ season: 2, episode: 1 }, series(), true)).toEqual({ season: 2, episode: 2 });
  });
  it('épisode canon : inchangé', () => {
    expect(autoNextEpisode({ season: 1, episode: 4 }, series(), true)).toEqual({ season: 1, episode: 4 });
  });
  it('premier épisode canon pas encore diffusé : aucun enchaînement', () => {
    const eps = series();
    eps.get(1)![3] = ep(4, { aired: false });
    expect(autoNextEpisode({ season: 1, episode: 2 }, eps, true)).toBeNull();
  });
  it('rien que des fillers jusqu’à la fin de la liste chargée : aucun enchaînement', () => {
    const eps = new Map<number, EpisodeInfo[]>([[1, [ep(1), ep(2, { filler: 'filler' })]]]);
    expect(autoNextEpisode({ season: 1, episode: 2 }, eps, true)).toBeNull();
  });
});

describe('firstUnseen avec skipFillers', () => {
  const seasons = [{ season: 1, count: 4 }, { season: 2, count: 2 }];
  const seen = (s: number, e: number): boolean => s === 1 && e === 1;
  it('réglage inactif : le filler compte', () => {
    expect(firstUnseen(seasons, series(), 1, seen)).toEqual({ season: 1, episode: 2 });
  });
  it('réglage actif : premier épisode canon non vu', () => {
    expect(firstUnseen(seasons, series(), 1, seen, true)).toEqual({ season: 1, episode: 4 });
    expect(firstUnseen(seasons, series(), 2, () => false, true)).toEqual({ season: 2, episode: 2 });
  });
});

describe('badge du panneau Épisodes', () => {
  it('affiche « Filler » et « Récap », rien pour un épisode canon', () => {
    const host = document.createElement('div');
    host.innerHTML = episodesHtml({
      title: 'Show', logo: '', season: 1, seasons: [{ season: 1, count: 3 }], total: 3, watchedCount: 0, query: '',
      loading: false, error: '', current: { season: 1, episode: 1 },
      episodes: [
        { ...ep(1), watched: false, progress: 0 },
        { ...ep(2, { filler: 'filler' }), watched: false, progress: 0 },
        { ...ep(3, { filler: 'recap' }), watched: false, progress: 0 },
      ],
    } as unknown as Parameters<typeof episodesHtml>[0]);
    const badge = (n: number): string | undefined => host.querySelector('.lp-ep-row[data-ep="' + n + '"] .lp-ep-filler')?.textContent ?? undefined;
    expect([badge(1), badge(2), badge(3)]).toEqual([undefined, 'Filler', 'Récap']);
  });
});

describe('réglage « Passer les épisodes filler »', () => {
  beforeEach(() => localStorage.removeItem('laststream.skip.filler'));
  it('désactivé par défaut', () => {
    expect(getSkipPref('filler')).toBe(false);
  });
  it('synchronisé avec le profil (skipFiller)', () => {
    setSkipPref('filler', true);
    expect(snapshotPrefs().skipFiller).toBe(true);
    applyPrefs({ skipFiller: false });
    expect(getSkipPref('filler')).toBe(false);
  });
});
