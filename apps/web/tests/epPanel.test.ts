import { afterEach, describe, expect, it } from 'vitest';
import { episodesHtml } from '../src/player/panels';
import { bindEpisodeFold } from '../src/player/epfold';

const data = () => ({
  title: 'Show', logo: '', season: 1, seasons: [{ season: 1, count: 3 }], total: 3, watchedCount: 1, query: '',
  loading: false, error: '', current: { season: 1, episode: 2 },
  episodes: [
    { episode: 1, name: 'Pilote', overview: 'Un début.', airDate: '2020-10-24', runtime: 24, still: '', aired: true, watched: true, progress: 0 },
    { episode: 2, name: 'Le départ', overview: 'Un voyage commence.', airDate: '2020-10-31', runtime: 24, still: '', aired: true, watched: false, progress: 0.4 },
    { episode: 3, name: 'Sans synopsis', overview: '', airDate: '2020-11-07', runtime: 0, still: '', aired: true, watched: false, progress: 0 },
    { episode: 4, name: 'À venir', overview: 'Bientôt.', airDate: '2999-01-01', runtime: 0, still: '', aired: false, watched: false, progress: 0 },
  ],
});

// Monte le HTML du panneau dans le document (jsdom) et renvoie l'élément hôte.
const mount = (d = data()) => {
  const host = document.createElement('div');
  host.className = 'lp-panel';
  host.innerHTML = episodesHtml(d);
  document.body.appendChild(host);
  return host;
};

const row = (host: HTMLElement, n: number) => host.querySelector(`.lp-ep-row[data-ep="${n}"]`) as HTMLElement;

afterEach(() => { document.body.innerHTML = ''; });

describe('panneau Épisodes : ligne', () => {
  it('ne contient plus la rangée d’actions au survol', () => {
    const html = episodesHtml(data());
    expect(html).not.toContain('lp-ep-actions');
    expect(html).not.toContain('Marquer non vu');
  });

  it('bouton « vu » : data-* conservés, libellé selon l’état', () => {
    const host = mount();
    const seen1 = row(host, 1).querySelector('button.lp-ep-seen') as HTMLButtonElement;
    expect(seen1.dataset.act).toBe('ep-seen');
    expect(seen1.dataset.season).toBe('1');
    expect(seen1.dataset.episode).toBe('1');
    expect(seen1.dataset.seen).toBe('0');
    expect(seen1.getAttribute('aria-label')).toBe('Marquer comme non vu');
    expect(seen1.title).toBe('Marquer comme non vu');
    expect(seen1.classList.contains('is-on')).toBe(true);

    const seen2 = row(host, 2).querySelector('button.lp-ep-seen') as HTMLButtonElement;
    expect(seen2.dataset.seen).toBe('1');
    expect(seen2.getAttribute('aria-label')).toBe('Marquer comme vu');
    expect(seen2.classList.contains('is-on')).toBe(false);
  });

  it('pas de bouton imbriqué : la lecture et le bouton « vu » sont frères', () => {
    const host = mount();
    expect(host.querySelectorAll('button button').length).toBe(0);
    for (const r of Array.from(host.querySelectorAll('.lp-ep-row'))) {
      const play = r.querySelector('button.lp-ep') as HTMLButtonElement;
      expect(play.dataset.act).toBe('episode');
      expect(play.dataset.season).toBe('1');
      expect(play.querySelector('button')).toBeNull();
      expect(play.parentElement).toBe(r);
    }
  });

  it('pastille « En cours » sur la vignette de l’épisode courant, pas dans le titre', () => {
    const host = mount();
    const now = row(host, 2).querySelector('.lp-ep-still .lp-ep-now');
    expect(now?.textContent).toBe('En cours');
    expect(row(host, 2).querySelector('.lp-ep-name')?.textContent).not.toContain('En cours');
    expect(row(host, 1).querySelector('.lp-ep-now')).toBeNull();
    expect(row(host, 2).classList.contains('is-on')).toBe(true);
  });

  it('synopsis présent sans bouton « Plus » quand il est vide ; épisode à venir sans bouton « vu »', () => {
    const host = mount();
    expect(row(host, 3).querySelector('.lp-ep-more')).toBeNull();
    expect(row(host, 1).querySelector('.lp-ep-more')).not.toBeNull();
    expect(row(host, 4).querySelector('.lp-ep-seen')).toBeNull();
    expect((row(host, 4).querySelector('button.lp-ep') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('panneau Épisodes : dépliage du synopsis', () => {
  const ep = (host: HTMLElement, n: number) => row(host, n);
  const more = (host: HTMLElement, n: number) => ep(host, n).querySelector('.lp-ep-more') as HTMLButtonElement;
  const expanded = (host: HTMLElement, n: number) => more(host, n).getAttribute('aria-expanded');

  it('un seul épisode déplié à la fois, re-clic pour replier, aria-expanded à jour', () => {
    const host = mount();
    bindEpisodeFold(host);
    expect(expanded(host, 1)).toBe('false');

    more(host, 1).click();
    expect(expanded(host, 1)).toBe('true');
    expect(ep(host, 1).classList.contains('is-open')).toBe(true);

    more(host, 2).click();
    expect(expanded(host, 1)).toBe('false');
    expect(ep(host, 1).classList.contains('is-open')).toBe(false);
    expect(expanded(host, 2)).toBe('true');
    expect(host.querySelectorAll('.lp-ep-row.is-open').length).toBe(1);

    more(host, 2).click();
    expect(expanded(host, 2)).toBe('false');
    expect(host.querySelectorAll('.lp-ep-row.is-open').length).toBe(0);
  });

  it('le clic sur « Plus » ne déclenche pas la lecture de l’épisode', () => {
    const host = mount();
    bindEpisodeFold(host);
    let played = 0;
    host.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-act="episode"]')) played++;
    });
    more(host, 2).click();
    expect(played).toBe(0);
    more(host, 2).click(); // replié : le module garde l’état entre les tests
  });

  it('l’état déplié survit à un nouveau rendu du panneau', () => {
    const host = mount();
    bindEpisodeFold(host);
    more(host, 2).click();
    host.innerHTML = episodesHtml(data());
    expect(row(host, 2).classList.contains('is-open')).toBe(true);
    expect(expanded(host, 2)).toBe('true');
    // Remise à zéro pour les autres tests.
    more(host, 2).click();
    expect(expanded(host, 2)).toBe('false');
  });
});

