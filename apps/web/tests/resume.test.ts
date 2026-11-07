// Reprise de lecture : timecode et pourcentage sur les vignettes (épisodes de la fiche, « Reprendre la lecture », films).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatResume, fmtTimecode, progressResume } from '../src/ui/resume.js';

const { EPS } = vi.hoisted(() => ({
  EPS: [
    { episode_number: 1, name: 'Pilote', air_date: '2020-01-01', still_path: null, runtime: 42, overview: '' },
    { episode_number: 2, name: 'Deux', air_date: '2020-01-08', still_path: '/s2.jpg', runtime: 42, overview: '' },
    { episode_number: 3, name: 'Trois', air_date: '2020-01-15', still_path: null, runtime: 42, overview: '' },
    { episode_number: 4, name: 'Quatre', air_date: '2020-01-22', still_path: null, runtime: 42, overview: '' },
  ],
}));

vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/ui/seasons.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/seasons.js')>()),
  seasonEpisodes: async () => ({ poster_path: null, episodes: EPS }),
}));

describe('fmtTimecode', () => {
  it('mm:ss sous une heure, h:mm:ss à partir d’une heure', () => {
    expect(fmtTimecode(1421)).toBe('23:41');
    expect(fmtTimecode(5)).toBe('00:05');
    expect(fmtTimecode(3599)).toBe('59:59');
    expect(fmtTimecode(3600)).toBe('1:00:00');
    expect(fmtTimecode(3723)).toBe('1:02:03');
  });

  it('tronque les secondes fractionnaires', () => {
    expect(fmtTimecode(1421.9)).toBe('23:41');
  });
});

describe('formatResume', () => {
  it('secondes : timecode et pourcentage affichés', () => {
    const r = formatResume(1421, 3023);
    expect(r?.label).toBe('23:41 · 47 %');
    expect(r?.ratio).toBeCloseTo(1421 / 3023, 6);
    expect(formatResume(125, 1000)?.label).toBe('02:05 · 13 %');
  });

  it('heures : format h:mm:ss', () => {
    expect(formatResume(3723, 7200)?.label).toBe('1:02:03 · 52 %');
    expect(formatResume(3600, 7200)?.label).toBe('1:00:00 · 50 %');
  });

  it('arrondi : pourcentage au plus proche, timecode tronqué', () => {
    expect(formatResume(1, 3)?.label).toBe('00:01 · 33 %');
    expect(formatResume(89.4, 100)?.label).toBe('01:29 · 89 %');
    expect(formatResume(89.5, 100)).toBeNull(); // affiché 90 % : déjà vu
  });

  it('borne basse : 2 % inclus, 1 % exclu', () => {
    expect(formatResume(2, 100)?.label).toBe('00:02 · 2 %');
    expect(formatResume(1.4, 100)).toBeNull();
  });

  it('borne haute : 89 % affiché, 90 % et plus exclus (vu)', () => {
    expect(formatResume(89, 100)?.label).toBe('01:29 · 89 %');
    expect(formatResume(90, 100)).toBeNull();
    expect(formatResume(99, 100)).toBeNull();
  });

  it('durée inconnue ou invalide : rien', () => {
    expect(formatResume(100, 0)).toBeNull();
    expect(formatResume(100, -5)).toBeNull();
    expect(formatResume(100, NaN)).toBeNull();
    expect(formatResume(100, undefined as unknown as number)).toBeNull();
  });

  it('position invalide ou au-delà de la durée : rien', () => {
    expect(formatResume(NaN, 100)).toBeNull();
    expect(formatResume(-1, 100)).toBeNull();
    expect(formatResume(150, 100)).toBeNull();
  });

  it('progressResume : entrée absente ou valide', () => {
    expect(progressResume(null)).toBeNull();
    expect(progressResume({ position: 1421, duration: 3023 })?.label).toBe('23:41 · 47 %');
  });
});

const CHILD = /<\/?[a-z]/i; // garde-fou : le HTML rendu n’est pas vide
let detailSeason: (m: unknown, n: number, token: number) => Promise<void>;
let refreshWatched: () => void;
let userStore: typeof import('../src/data/userStore').userStore;
let stateMod: typeof import('../src/ui/state.js').state;
let continueCardHTML: (p: unknown) => string;
let posterCard: (it: unknown, o?: unknown) => string;
let toItem: (raw: unknown, type: string) => unknown;

const M = { key: 'tv:1399', id: 1399, type: 'tv', name: 'Série test', backdropPath: '', posterPath: '', seasons: [], lastAired: null };
const showEp = (n: number, e: number, position: number, duration = 3023) =>
  userStore.setProgress({ key: 'tv:1399', type: 'tv', id: 1399, title: 'Série test', poster: '', season: n, episode: e, position, duration });
const li = (e: number) => document.querySelector<HTMLElement>('#f-eplist .ep[data-ep="1:' + e + '"]')!;
// `state.model` (fiche ouverte) n’est pas déclaré dans state.js : accès typé ici seulement.
const setModel = (m: unknown) => { (stateMod as unknown as Record<string, unknown>).model = m; };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.innerHTML = '<ul id="f-eplist"></ul>';
  // Les modules touchent au DOM à l’import : on les charge après avoir posé la page.
  ({ userStore } = await import('../src/data/userStore'));
  ({ loadSeason: detailSeason } = await import('../src/ui/ficheSections.js'));
  ({ refreshWatchedUI: refreshWatched } = await import('../src/ui/watched.js'));
  ({ continueCardHTML } = await import('../src/ui/continue.js'));
  ({ posterCard } = await import('../src/ui/tiles.js'));
  ({ toItem } = await import('../src/ui/catalog.js'));
  ({ state: stateMod } = await import('../src/ui/state.js'));
});

beforeEach(() => {
  localStorage.clear();
  document.getElementById('f-eplist')!.innerHTML = '';
  setModel(null);
});

describe('fiche série : cartes d’épisodes avec reprise', () => {
  it('pastille et barre pour un épisode entamé, rien pour un épisode non commencé', async () => {
    showEp(1, 2, 1421); // 47 %
    await detailSeason(M, 1, stateMod.token);

    const pill = li(2).querySelector('.ep-still .resume-pill');
    expect(pill?.textContent).toBe('23:41 · 47 %');
    expect(pill?.getAttribute('aria-hidden')).toBe('true');
    expect((li(2).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('47%');
    expect(li(2).querySelector('.ep-main')!.getAttribute('aria-label')).toContain('reprise à 23:41 · 47 %');

    expect(li(1).querySelector('.resume-pill')).toBeNull();
    expect((li(1).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('0%');
  });

  it('au-delà de 90 % : aucune pastille, la barre reste vide', async () => {
    showEp(1, 4, 2900); // 96 %
    await detailSeason(M, 1, stateMod.token);
    expect(li(4).querySelector('.resume-pill')).toBeNull();
    expect((li(4).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('0%');
  });

  it('épisode vu : l’état « vu » prévaut (barre pleine, pas de reprise annoncée)', async () => {
    showEp(1, 3, 100); // 3 %, mais marqué vu
    userStore.setWatched('tv:1399', [{ season: 1, episode: 3 }], true);
    await detailSeason(M, 1, stateMod.token);
    expect(li(3).classList.contains('is-seen')).toBe(true);
    expect((li(3).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('100%');
    expect(li(3).querySelector('.ep-main')!.getAttribute('aria-label')).not.toContain('reprise');
  });

  it('marquer vu puis non vu : la barre passe à 100 %, puis revient à la progression', async () => {
    showEp(1, 2, 1421);
    await detailSeason(M, 1, stateMod.token);
    setModel(M);
    userStore.setWatched('tv:1399', [{ season: 1, episode: 2 }], true);
    refreshWatched();
    expect((li(2).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('100%');
    userStore.setWatched('tv:1399', [{ season: 1, episode: 2 }], false);
    refreshWatched();
    expect((li(2).querySelector('.ep-bar > span') as HTMLElement).style.width).toBe('47%');
  });
});

describe('« Reprendre la lecture » : timecode et pourcentage dans la ligne de temps', () => {
  it('affiche « 23:41 · 47 % · reste 27 min »', () => {
    const html = continueCardHTML({ key: 'movie:550', type: 'movie', id: 550, title: 'Fight Club', poster: '', backdrop: '', position: 1421, duration: 3023, updatedAt: 1 });
    expect(CHILD.test(html)).toBe(true);
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector('.cont-left');
    expect(el?.textContent).toBe('23:41 · 47 % · reste 27 min');
  });

  it('au-delà de 90 % : seulement le temps restant', () => {
    const html = continueCardHTML({ key: 'movie:550', type: 'movie', id: 550, title: 'Fight Club', poster: '', backdrop: '', position: 2900, duration: 3023, updatedAt: 1 });
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector('.cont-left');
    expect(el?.textContent).toBe('reste 2 min');
  });
});

describe('tuiles poster des films entamés', () => {
  it('pastille, barre de reprise et libellé pour un film à 47 %', () => {
    userStore.setProgress({ key: 'movie:550', type: 'movie', id: 550, title: 'Fight Club', poster: '', position: 1421, duration: 3023 });
    const it = toItem({ id: 550, title: 'Fight Club', poster_path: '/fc.jpg', backdrop_path: '', release_date: '1999-10-15' }, 'movie');
    const doc = new DOMParser().parseFromString(posterCard(it), 'text/html');
    expect(doc.querySelector('.resume-pill')?.textContent).toBe('23:41 · 47 %');
    expect(doc.querySelector('.resume-progress > span')?.getAttribute('style')).toBe('width:47%');
    expect(doc.querySelector('[data-tile]')?.getAttribute('aria-label')).toContain('reprise 23:41 · 47 %');
  });

  it('sans progression : aucune pastille ni barre', () => {
    const it = toItem({ id: 551, title: 'Autre', poster_path: '/a.jpg', backdrop_path: '', release_date: '1999-10-15' }, 'movie');
    const doc = new DOMParser().parseFromString(posterCard(it), 'text/html');
    expect(doc.querySelector('.resume-pill')).toBeNull();
    expect(doc.querySelector('.resume-progress')).toBeNull();
  });
});
