// ODY-244 : la carte d'un titre ou d'un extrait partagé montre toujours une image (message, sinon résolue par l'identifiant),
// et un repli en dégradé avec le titre quand aucune image n'existe (jamais un fond uni).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tmdb: vi.fn() }));
vi.mock('../src/data/lt', () => ({ tmdb: h.tmdb }));

import { messageRow } from '../src/ui/socialConvDom.js';
import { resolveArt, resetArt, cachedArt } from '../src/ui/socialArt.js';
import { buildShareInput, normalizeMedia } from '../src/ui/shareModel.js';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const ctx: any = { me: 'me', info: { kind: 'dm' }, s: {}, byId: new Map(), act: { playMoment: vi.fn(), read: vi.fn(), addToList: vi.fn(), inList: () => false, react: vi.fn(), reply: vi.fn(), toggleBar: vi.fn() }, barFor: null, mobile: true };
const moment = (extra: object = {}) => ({ id: 'm1', from: 'p1', kind: 'moment', reactions: [], body: 'test', moment: { type: 'series', tmdbId: 1, title: 'Spartacus', pos: 351, end: 379, ...extra } });
const title = (extra: object = {}) => ({ id: 't1', from: 'p1', kind: 'title', reactions: [], title: { type: 'movie', tmdbId: 7, title: 'Dune', ...extra } });

beforeEach(() => {
  h.tmdb.mockReset();
  resetArt();
});

describe('carte « extrait » du chat', () => {
  it('affiche le visuel du message quand il existe', () => {
    const el = messageRow(moment({ still: '/s.jpg' }), ctx);
    expect(el.querySelector('.cvm-shot img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w500/s.jpg');
    expect(el.querySelector('.cvm-shot')?.classList.contains('is-empty')).toBe(false);
    expect(h.tmdb).not.toHaveBeenCalled();
  });

  it('sans visuel : repli avec le titre, puis fond du titre retrouvé par son identifiant', async () => {
    h.tmdb.mockResolvedValue({ backdrop_path: '/b.jpg', poster_path: '/p.jpg' });
    const el = messageRow(moment(), ctx);
    const shot = el.querySelector('.cvm-shot')!;
    expect(shot.classList.contains('is-empty')).toBe(true);
    expect(shot.querySelector('.cvm-shot-empty')?.textContent).toBe('Spartacus');
    await flush();
    expect(h.tmdb).toHaveBeenCalledWith('tv/1');
    expect(shot.querySelector('img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w500/b.jpg');
    expect(shot.classList.contains('is-empty')).toBe(false);
  });

  it('sans fond, utilise l’affiche du titre', async () => {
    h.tmdb.mockResolvedValue({ poster_path: '/p.jpg' });
    const el = messageRow(moment(), ctx);
    await flush();
    expect(el.querySelector('.cvm-shot img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
  });

  it('si l’image du message ne charge pas, résout le visuel du titre', async () => {
    h.tmdb.mockResolvedValue({ backdrop_path: '/b.jpg' });
    const el = messageRow(moment({ still: '/cassee.jpg' }), ctx);
    el.querySelector('.cvm-shot img')!.dispatchEvent(new Event('error'));
    await flush();
    expect(el.querySelector('.cvm-shot img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w500/b.jpg');
  });

  it('aucune image nulle part : le repli (dégradé + titre) reste, sans erreur', async () => {
    h.tmdb.mockRejectedValue(new Error('réseau'));
    const el = messageRow(moment(), ctx);
    await flush();
    const shot = el.querySelector('.cvm-shot')!;
    expect(shot.querySelector('img')).toBeNull();
    expect(shot.classList.contains('is-empty')).toBe(true);
    expect(shot.querySelector('.cvm-shot-empty')?.textContent).toBe('Spartacus');
  });
});

describe('carte « titre » du chat', () => {
  it('retrouve l’affiche d’un ancien message sans affiche', async () => {
    h.tmdb.mockResolvedValue({ poster_path: '/p.jpg' });
    const el = messageRow(title(), ctx);
    const poster = el.querySelector('.cvm-poster')!;
    expect(poster.textContent).toBe('Dune');
    await flush();
    expect(h.tmdb).toHaveBeenCalledWith('movie/7');
    expect(poster.querySelector('img')?.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
    expect(poster.textContent).toBe('');
  });

  it('garde l’affiche du message sans appel réseau', () => {
    const el = messageRow(title({ poster: '/p.jpg' }), ctx);
    expect(el.querySelector('.cvm-poster img')).not.toBeNull();
    expect(h.tmdb).not.toHaveBeenCalled();
  });
});

describe('resolveArt', () => {
  it('met en cache (mémoire) et ne rappelle pas le réseau', async () => {
    h.tmdb.mockResolvedValue({ backdrop_path: '/b.jpg', poster_path: '/p.jpg' });
    expect(await resolveArt('series', 9)).toEqual({ poster: '/p.jpg', backdrop: '/b.jpg' });
    expect(await resolveArt('tv', 9)).toEqual({ poster: '/p.jpg', backdrop: '/b.jpg' });
    expect(h.tmdb).toHaveBeenCalledTimes(1);
    expect(cachedArt('tv', 9)).not.toBeNull();
  });

  it('refuse les chemins qui ne sont pas des images TMDB et les identifiants invalides', async () => {
    h.tmdb.mockResolvedValue({ backdrop_path: 'https://evil.test/x.jpg', poster_path: '/../x' });
    expect(await resolveArt('movie', 3)).toEqual({ poster: '', backdrop: '' });
    expect(await resolveArt('movie', -1)).toEqual({ poster: '', backdrop: '' });
    expect(await resolveArt('movie', 'abc')).toEqual({ poster: '', backdrop: '' });
  });
});

describe('envoi d’un extrait', () => {
  it('enregistre le fond du titre dans le message quand il est connu', () => {
    const media = normalizeMedia({ type: 'movie', tmdbId: 5, title: 'Dune', backdrop: '/b.jpg' });
    const input: any = buildShareInput({ keys: ['p:a'], media, mode: 'moment', pos: 10 });
    expect(input.moment.still).toBe('/b.jpg');
  });

  it('n’ajoute pas de visuel invalide', () => {
    const media = normalizeMedia({ type: 'movie', tmdbId: 5, title: 'Dune', backdrop: 'http://x.test/b.jpg' });
    const input: any = buildShareInput({ keys: ['p:a'], media, mode: 'moment', pos: 10 });
    expect(input.moment.still).toBeUndefined();
  });
});
