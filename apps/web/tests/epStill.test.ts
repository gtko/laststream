import { afterEach, describe, expect, it } from 'vitest';
import { episodesHtml } from '../src/player/panels';
import { localDay } from '../src/player/episodes';
import { stillFallback } from '../src/ui/epStill';

const data = (eps: Record<string, unknown>[], backdrop = '') => ({
  title: 'Show', logo: '', season: 3, seasons: [{ season: 3, count: eps.length }], total: eps.length, watchedCount: 0, query: '',
  loading: false, error: '', backdrop, current: { season: 3, episode: 99 }, episodes: eps,
}) as unknown as Parameters<typeof episodesHtml>[0];

const ep = (episode: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  episode, name: 'E' + episode, overview: '', airDate: '2020-01-01', runtime: 0, still: '', aired: true, playable: true, watched: false, progress: 0, ...over,
});

const mount = (eps: Record<string, unknown>[], backdrop = ''): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = episodesHtml(data(eps, backdrop));
  document.body.appendChild(host);
  return host;
};

const row = (host: HTMLElement, n: number) => host.querySelector(`.lp-ep-row[data-ep="${n}"]`) as HTMLElement;
const fire = (el: Element) => el.dispatchEvent(new Event('error'));
const dayOffset = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDay(d);
};

afterEach(() => { document.body.innerHTML = ''; });

describe('vignette qui ne charge pas : repli, jamais d’image cassée', () => {
  it('sans vignette ni fond : aucune image, dégradé et numéro', () => {
    const host = mount([ep(208, { aired: false, playable: false, airDate: '2999-01-01' })]);
    expect(host.querySelector('img')).toBeNull();
    const still = row(host, 208).querySelector('.lp-ep-still') as HTMLElement;
    expect(still.classList.contains('is-fb')).toBe(true);
    expect(row(host, 208).querySelector('.lp-ep-num')?.textContent).toBe('É208');
  });

  it('vignette en erreur : bascule sur le fond de la série, puis retrait si lui aussi échoue', () => {
    const host = mount([ep(5, { still: 'https://img.test/s5.jpg' })], 'https://img.test/bg.jpg');
    const img = row(host, 5).querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://img.test/s5.jpg');
    fire(img);
    expect(img.isConnected).toBe(true);
    expect(img.getAttribute('src')).toBe('https://img.test/bg.jpg');
    expect((row(host, 5).querySelector('.lp-ep-still') as HTMLElement).classList.contains('is-fb')).toBe(true);
    fire(img);
    expect(row(host, 5).querySelector('img')).toBeNull();
    expect(row(host, 5).querySelector('.lp-ep-still')!.classList.contains('is-fb')).toBe(true);
  });

  it('pas de vignette, fond qui ne charge pas : image retirée, dégradé', () => {
    const host = mount([ep(6)], 'https://img.test/bg.jpg');
    const img = row(host, 6).querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://img.test/bg.jpg');
    fire(img);
    expect(row(host, 6).querySelector('img')).toBeNull();
    expect(row(host, 6).querySelector('.lp-ep-still')!.classList.contains('is-fb')).toBe(true);
  });

  it('une image hors liste (sans data-still) n’est pas touchée', () => {
    const other = document.createElement('img');
    other.src = 'https://img.test/autre.jpg';
    document.body.appendChild(other);
    fire(other);
    expect(other.isConnected).toBe(true);
    expect(other.getAttribute('src')).toBe('https://img.test/autre.jpg');
  });

  it('stillFallback renvoie le conteneur de la vignette', () => {
    const host = mount([ep(7, { still: 'https://img.test/s7.jpg' })]);
    const img = row(host, 7).querySelector('img') as HTMLImageElement;
    expect(stillFallback(img)).toBe(row(host, 7).querySelector('.lp-ep-still'));
  });
});

describe('pastille de diffusion sur la vignette', () => {
  it('épisode du jour : « Aujourd’hui », point de la couleur d’accent', () => {
    const host = mount([ep(1, { airDate: localDay(new Date()) })]);
    const pill = row(host, 1).querySelector('.lp-ep-soon') as HTMLElement;
    expect(pill.textContent).toBe('Aujourd’hui');
    expect(pill.classList.contains('is-today')).toBe(true);
  });

  it('diffusion proche : « À venir · date », « peut-être déjà en ligne » seulement dans l’infobulle', () => {
    const host = mount([ep(2, { airDate: dayOffset(3), aired: false, playable: true })]);
    const pill = row(host, 2).querySelector('.lp-ep-soon') as HTMLElement;
    expect(pill.textContent).toMatch(/^À venir · \d{1,2} \S+\.?$/);
    expect(pill.title).toMatch(/peut-être déjà en ligne$/);
    expect(pill.classList.contains('is-today')).toBe(false);
  });

  it('au-delà de la fenêtre : « Bientôt » ; épisode déjà diffusé : aucune pastille', () => {
    const host = mount([ep(3, { airDate: dayOffset(60), aired: false, playable: false }), ep(4, { airDate: '2020-01-01' })]);
    expect(row(host, 3).querySelector('.lp-ep-soon')?.textContent).toBe('Bientôt');
    expect(row(host, 4).querySelector('.lp-ep-soon')).toBeNull();
  });
});
