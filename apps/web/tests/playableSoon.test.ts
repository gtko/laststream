import { describe, expect, it } from 'vitest';
import { autoNextEpisode, firstUnseen, isPlayable, normalizeCanonical, playableSoon, type EpisodeInfo } from '../src/player/episodes';
import { episodesHtml } from '../src/player/panels';
import { toNativeEpisodes } from '../src/player/native';

const TODAY = '2026-10-18';
/** Ajoute n jours à une date AAAA-MM-JJ (UTC, sans décalage horaire). */
const plus = (n: number): string => new Date(Date.parse(TODAY) + n * 86_400_000).toISOString().slice(0, 10);

describe('playableSoon : fenêtre des 14 prochains jours', () => {
  it('aujourd’hui (0 jour) : diffusé, pas « bientôt »', () => {
    expect(playableSoon(TODAY, TODAY)).toBe(false);
  });
  it('demain (1 jour) : lisible', () => {
    expect(playableSoon(plus(1), TODAY)).toBe(true);
  });
  it('14 jours : borne incluse', () => {
    expect(playableSoon(plus(14), TODAY)).toBe(true);
  });
  it('15 jours : hors fenêtre', () => {
    expect(playableSoon(plus(15), TODAY)).toBe(false);
  });
  it('date passée : pas « bientôt »', () => {
    expect(playableSoon(plus(-3), TODAY)).toBe(false);
  });
  it('sans date : pas « bientôt » (inchangé : diffusé par défaut)', () => {
    expect(playableSoon('', TODAY)).toBe(false);
    expect(isPlayable('', TODAY)).toBe(true);
  });
  it('date ou référence mal formée : false', () => {
    expect(playableSoon('2026-10-1', TODAY)).toBe(false);
    expect(playableSoon('pas une date', TODAY)).toBe(false);
  });
  it('isPlayable : diffusé ou bientôt, jamais au-delà de 14 jours', () => {
    expect(isPlayable(TODAY, TODAY)).toBe(true);
    expect(isPlayable(plus(14), TODAY)).toBe(true);
    expect(isPlayable(plus(15), TODAY)).toBe(false);
  });
});

describe('normalizeCanonical : indicateurs diffusé / lisible', () => {
  const resp = {
    seasons: [{ number: 1, episodeCount: 4 }],
    episodes: [
      { season: 1, episode: 1, name: 'A', airDate: plus(-7) },
      { season: 1, episode: 2, name: 'B', airDate: plus(5) },
      { season: 1, episode: 3, name: 'C', airDate: plus(60) },
      { season: 1, episode: 4, name: 'D', airDate: '' },
    ],
  };
  it('marque diffusé, lisible et hors fenêtre', () => {
    const eps = normalizeCanonical(resp, TODAY)!.episodes.get(1)!;
    expect(eps.map((e) => [e.episode, e.aired, e.playable])).toEqual([[1, true, true], [2, false, true], [3, false, false], [4, true, true]]);
  });
});

describe('firstUnseen : prend les épisodes lisibles', () => {
  const eps = new Map<number, EpisodeInfo[]>([[1, [
    { episode: 1, name: '', runtime: null, overview: '', still: '', airDate: plus(-7), aired: true, playable: true },
    { episode: 2, name: '', runtime: null, overview: '', still: '', airDate: plus(5), aired: false, playable: true },
    { episode: 3, name: '', runtime: null, overview: '', still: '', airDate: plus(60), aired: false, playable: false },
  ]]]);
  it('saute les épisodes vus et ceux au-delà de 14 jours', () => {
    const seen = (_s: number, e: number) => e === 1;
    expect(firstUnseen([{ season: 1, count: 3 }], eps, 1, seen)).toEqual({ season: 1, episode: 2 });
  });
});

describe('enchaînement automatique : jamais vers un épisode non diffusé', () => {
  const eps = new Map<number, EpisodeInfo[]>([[2, [
    { episode: 1, name: '', runtime: null, overview: '', still: '', airDate: plus(-1), aired: true, playable: true },
    { episode: 2, name: '', runtime: null, overview: '', still: '', airDate: plus(3), aired: false, playable: true },
  ]]]);
  it('épisode suivant diffusé : enchaînement permis', () => {
    expect(autoNextEpisode({ season: 2, episode: 1 }, eps)).toEqual({ season: 2, episode: 1 });
  });
  it('épisode suivant pas encore diffusé (même lisible) : saute, lancement manuel seulement', () => {
    expect(autoNextEpisode({ season: 2, episode: 2 }, eps)).toBeNull();
  });
  it('épisode non chargé : inchangé, la recherche de sources décide', () => {
    expect(autoNextEpisode({ season: 3, episode: 1 }, eps)).toEqual({ season: 3, episode: 1 });
  });
  it('pas de suivant : null', () => {
    expect(autoNextEpisode(null, eps)).toBeNull();
  });
});

const panelData = (): Parameters<typeof episodesHtml>[0] => ({
  title: 'Show', logo: '', season: 1, seasons: [{ season: 1, count: 3 }], total: 3, watchedCount: 0, query: '',
  loading: false, error: '', current: { season: 1, episode: 1 },
  episodes: [
    { episode: 1, name: 'Dans 5 jours', overview: '', airDate: plus(5), runtime: 0, still: '', aired: false, playable: true, watched: false, progress: 0 },
    { episode: 2, name: 'Dans 30 jours', overview: '', airDate: plus(30), runtime: 0, still: '', aired: false, playable: false, watched: false, progress: 0 },
    { episode: 3, name: 'Diffusé', overview: '', airDate: plus(-2), runtime: 0, still: '', aired: true, playable: true, watched: false, progress: 0 },
  ],
}) as unknown as Parameters<typeof episodesHtml>[0];

const mountPanel = (): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = episodesHtml(panelData());
  return host;
};

describe('panneau Épisodes : rangée cliquable', () => {
  it('épisode dans les 14 jours : bouton actif et badge « déjà en ligne ? »', () => {
    const host = mountPanel();
    const btn = host.querySelector('.lp-ep-row[data-ep="1"] button.lp-ep') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(host.querySelector('.lp-ep-row[data-ep="1"] .lp-ep-soon')?.textContent).toMatch(/^Diffusion TV le \d{1,2} \S+\.? · déjà en ligne \?$/);
    expect(host.querySelector('.lp-ep-row[data-ep="1"]')!.classList.contains('is-soon')).toBe(false);
  });
  it('épisode au-delà de 14 jours : désactivé, badge « Bientôt »', () => {
    const host = mountPanel();
    const btn = host.querySelector('.lp-ep-row[data-ep="2"] button.lp-ep') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(host.querySelector('.lp-ep-row[data-ep="2"] .lp-ep-soon')?.textContent).toBe('Bientôt');
  });
  it('épisode diffusé : pas de badge', () => {
    const host = mountPanel();
    expect(host.querySelector('.lp-ep-row[data-ep="3"] .lp-ep-soon')).toBeNull();
    expect((host.querySelector('.lp-ep-row[data-ep="3"] button.lp-ep') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('natif : épisode lisible transmis comme diffusé', () => {
  it('aired suit playable quand il est fourni', () => {
    const loaded = new Map<number, EpisodeInfo[]>([[1, [
      { episode: 1, name: 'A', runtime: null, overview: '', still: '', airDate: plus(5), aired: false, playable: true },
      { episode: 2, name: 'B', runtime: null, overview: '', still: '', airDate: plus(30), aired: false, playable: false },
    ]]]);
    const out = toNativeEpisodes([{ season: 1, count: 2 }], loaded, { season: 1, episode: 1 }, () => ({ watched: false, progress: 0 }))!;
    expect(out.items.map((e) => e.aired)).toEqual([true, false]);
  });
});
