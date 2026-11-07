import { describe, expect, it } from 'vitest';
import { centerLeft, episodeImage, focusEpisode } from '../src/ui/epFocus.js';
import { episodesHtml } from '../src/player/panels';

const ep = (n: number, air = '2020-01-0' + n) => ({ episode_number: n, air_date: air });
const none = () => false;

describe('episodeImage : repli sans carte vide', () => {
  it('still présent (URL complète ou chemin TMDB) : pas de repli', () => {
    expect(episodeImage('https://x.test/a.jpg', '/bg.jpg')).toEqual({ src: 'https://x.test/a.jpg', fallback: false });
    expect(episodeImage('/s.jpg', '/bg.jpg').src).toBe('https://image.tmdb.org/t/p/w500/s.jpg');
  });
  it('sans still : fond de la série + numéro ; sans fond non plus : repli sans image', () => {
    expect(episodeImage(null, '/bg.jpg')).toEqual({ src: 'https://image.tmdb.org/t/p/w780/bg.jpg', fallback: true });
    expect(episodeImage('', '')).toEqual({ src: '', fallback: true });
  });
});

describe('focusEpisode : épisode à mettre en avant', () => {
  const eps = [ep(1), ep(2), ep(3), ep(4, '2999-01-01')];
  const today = '2026-01-01';
  it('premier diffusé non vu', () => {
    expect(focusEpisode(eps, { today, isSeen: (n: number) => n === 1, inProgress: none })).toBe(2);
  });
  it('épisode en cours prioritaire, même après un non vu', () => {
    expect(focusEpisode(eps, { today, isSeen: (n: number) => n === 1, inProgress: (n: number) => n === 3 })).toBe(3);
  });
  it('tout vu : dernier diffusé (les futurs sont ignorés)', () => {
    expect(focusEpisode(eps, { today, isSeen: (n: number) => n <= 3, inProgress: none })).toBe(3);
  });
  it('rien de diffusé : premier ; liste vide : null', () => {
    expect(focusEpisode([ep(1, '2999-01-01')], { today, isSeen: none, inProgress: none })).toBe(1);
    expect(focusEpisode([], { today, isSeen: none, inProgress: none })).toBeNull();
  });
});

describe('centerLeft : défilement horizontal', () => {
  it('centre la carte et borne aux extrémités', () => {
    expect(centerLeft({ cardLeft: 1000, cardWidth: 360, viewWidth: 1000, scrollWidth: 4000 })).toBe(680);
    expect(centerLeft({ cardLeft: 8, cardWidth: 360, viewWidth: 1000, scrollWidth: 4000 })).toBe(0);
    expect(centerLeft({ cardLeft: 3800, cardWidth: 360, viewWidth: 1000, scrollWidth: 4000 })).toBe(3000);
  });
});

describe('panneau Épisodes du lecteur : repli', () => {
  const d = (still: string, backdrop: string) => ({
    title: 'S', logo: '', season: 1, seasons: [{ season: 1, count: 1 }], total: 1, watchedCount: 0, query: '', loading: false, error: '', backdrop,
    current: { season: 1, episode: 1 },
    episodes: [{ episode: 7, name: 'X', overview: '', airDate: '2020-01-01', runtime: 0, still, aired: true, watched: false, progress: 0 }],
  });
  it('sans still : fond de la série + numéro', () => {
    const html = episodesHtml(d('', 'https://img.test/bg.jpg'));
    expect(html).toContain('lp-ep-still is-fb');
    expect(html).toContain('https://img.test/bg.jpg');
    expect(html).toContain('lp-ep-num');
  });
  it('avec still : image seule', () => {
    const html = episodesHtml(d('https://img.test/s.jpg', 'https://img.test/bg.jpg'));
    expect(html).toContain('https://img.test/s.jpg');
    expect(html).not.toContain('is-fb');
  });
});
