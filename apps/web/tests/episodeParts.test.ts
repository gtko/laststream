import { describe, expect, it } from 'vitest';
import { episodeParts, partLabel } from '../src/data/episodeParts';
import { markParts, nextCardLabels, nextPart, normalizeCanonical, type EpisodeInfo } from '../src/player/episodes';
import { episodesHtml } from '../src/player/panels.js';
import { episodeImage } from '../src/ui/epFocus.js';

const eps = (names: string[], from = 1) => names.map((name, i) => ({ season: 21, episode: from + i, name }));

describe('episodeParts : émissions diffusées en deux parties', () => {
  it('reconnaît « (1) » puis « (2) » sur deux épisodes consécutifs', () => {
    const r = episodeParts(eps(['Émission 1 : les auditions', 'Émission 2 : les auditions (1)', 'Émission 2 : les auditions (2)']));
    expect(r[0]).toBeNull();
    expect(r[1]).toEqual({ index: 1, total: 2, title: 'Émission 2 : les auditions' });
    expect(r[2]).toEqual({ index: 2, total: 2, title: 'Émission 2 : les auditions' });
    expect(partLabel(r[1]!)).toBe('Partie 1/2');
  });

  it('accepte « 1/2 » et « partie 1 », liste dans le désordre (sortie alignée sur l’entrée)', () => {
    const r = episodeParts([{ season: 1, episode: 6, name: 'Finale – Partie 2' }, { season: 1, episode: 5, name: 'Finale – Partie 1' }]);
    expect(r.map((p) => p && [p.index, p.total])).toEqual([[2, 2], [1, 2]]);
    expect(episodeParts([{ episode: 1, name: 'Le gala 1/2' }])[0]).toEqual({ index: 1, total: 2, title: 'Le gala' });
  });

  it('« 2/2 » seul (partie 1 hors liste) reste une partie', () => {
    expect(episodeParts([{ episode: 8, name: 'Le gala 2/2' }])[0]).toMatchObject({ index: 2, total: 2 });
  });

  it('ne prend pas un « (1) » isolé, un autre titre, une autre saison ou des épisodes non consécutifs pour une partie', () => {
    expect(episodeParts([{ episode: 1, name: 'Rocky (1)' }])[0]).toBeNull();
    expect(episodeParts([{ season: 1, episode: 1, name: 'Duel (1)' }, { season: 1, episode: 2, name: 'Autre (2)' }])).toEqual([null, null]);
    expect(episodeParts([{ season: 1, episode: 9, name: 'Duel (1)' }, { season: 2, episode: 10, name: 'Duel (2)' }])).toEqual([null, null]);
    expect(episodeParts([{ episode: 1, name: 'Duel (1)' }, { episode: 3, name: 'Duel (2)' }])).toEqual([null, null]);
  });

  it('une fraction nue au-delà de 3 (« quart de finale 1/4 ») n’est pas une partie', () => {
    expect(episodeParts([{ episode: 1, name: 'Coupe, quart de finale 1/4' }])[0]).toBeNull();
    expect(episodeParts([{ episode: 1, name: 'Le gala (1/4)' }])[0]).toMatchObject({ index: 1, total: 4 });
  });

  it('gère trois parties', () => {
    const r = episodeParts(eps(['Saga (1)', 'Saga (2)', 'Saga (3)']));
    expect(r.map((p) => p && [p.index, p.total])).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
});

describe('player/episodes : parties dans la saison', () => {
  const canonical = {
    episodes: [
      { season: 21, episode: 3, name: 'Émission 2 : les auditions (1)' }, { season: 21, episode: 4, name: 'Émission 2 : les auditions (2)' },
      { season: 21, episode: 5, name: 'Émission 3 : les auditions (1)' }, { season: 21, episode: 6, name: 'Émission 3 : les auditions (2)' },
    ],
  };

  it('marque les parties à la normalisation canonique', () => {
    const list = normalizeCanonical(canonical, '2026-10-22')!.episodes.get(21)!;
    expect(list.map((e) => e.part && [e.part.index, e.part.total])).toEqual([[1, 2], [2, 2], [1, 2], [2, 2]]);
  });

  it('nextPart : la suite directe seulement depuis la partie 1', () => {
    const list = normalizeCanonical(canonical, '2026-10-22')!.episodes.get(21)!;
    expect(nextPart(list, 3)?.episode).toBe(4);
    expect(nextPart(list, 4)).toBeNull(); // dernière partie : rien à enchaîner
    expect(nextPart(list, 5)?.episode).toBe(6);
    expect(nextPart(undefined, 3)).toBeNull();
    expect(nextPart(markParts([{ episode: 1, name: 'Seul' } as EpisodeInfo]), 1)).toBeNull();
  });
});

describe('panneau des épisodes : partie et image de repli', () => {
  const base = { episode: 5, name: 'Émission 3 (1)', runtime: 47, overview: '', still: '', airDate: '2026-10-21', aired: true, playable: true, watched: false, progress: 0 };
  const data = (backdrop: string, poster = '') => ({
    seasons: [{ season: 21, count: 2 }], season: 21, current: { season: 21, episode: 5 }, loading: false, error: false, query: '', title: 'Série',
    logo: '', backdrop, poster, total: 2, watchedCount: 0,
    episodes: [{ ...base, part: { index: 1, total: 2, title: 'Émission 3' } }, { ...base, episode: 6, name: 'Émission 3 (2)', part: { index: 2, total: 2, title: 'Émission 3' } }],
  }) as unknown as Parameters<typeof episodesHtml>[0];

  it('affiche « Partie 1/2 » et le titre sans suffixe', () => {
    const html = episodesHtml(data('https://i/bg.jpg'));
    expect(html).toContain('<span class="lp-ep-part">Partie 1/2</span>');
    expect(html).toContain('Partie 2/2');
    expect(html).not.toContain('(1)');
  });

  it('épisode sans vignette : fond de la série, sinon affiche', () => {
    expect(episodesHtml(data('https://i/bg.jpg'))).toContain('src="https://i/bg.jpg"');
    expect(episodesHtml(data('', 'https://i/poster.jpg'))).toContain('src="https://i/poster.jpg"');
  });
});

describe('episodeImage : affiche en dernier repli', () => {
  it('fond de la série, puis affiche, puis rien', () => {
    expect(episodeImage('', '/bg.jpg', 'w500', '/p.jpg').src).toBe('https://image.tmdb.org/t/p/w780/bg.jpg');
    expect(episodeImage('', '', 'w500', '/p.jpg')).toEqual({ src: 'https://image.tmdb.org/t/p/w500/p.jpg', fallback: true });
    expect(episodeImage('', '', 'w500').src).toBe('');
  });
});

describe('nextCardLabels : carte de fin d’épisode', () => {
  const part2 = { part: { index: 2, total: 2, title: 'Émission 3' } };
  const part1 = { part: { index: 1, total: 2, title: 'Émission 4' } };

  it('suite directe d’une émission : « Partie 2/2 · suite de l’émission »', () => {
    expect(nextCardLabels(true, part2)).toEqual({ kicker: 'Partie 2/2 · suite de l’émission', playLabel: 'Lire la partie 2' });
  });

  it('épisode ordinaire ou première partie d’une autre émission : jamais « suite »', () => {
    expect(nextCardLabels(false, undefined)).toEqual({ kicker: '', playLabel: '' });
    expect(nextCardLabels(false, {})).toEqual({ kicker: '', playLabel: '' });
    expect(nextCardLabels(false, part1)).toEqual({ kicker: 'Épisode suivant · Partie 1/2', playLabel: '' });
  });
});
