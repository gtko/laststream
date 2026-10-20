// Social v3 (F4) : page publique d'un lien (#/t/<code>) et page d'une liste partagée (#/list/<id>).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ detail: null as any, st: {} as any, subs: new Set<(s: any) => void>() }));

vi.mock('../src/ui/dom.js', () => {
  const el = document.createElement('div');
  h.detail = el;
  return { detailEl: el, toast: vi.fn() };
});
vi.mock('../src/ui/fiche.js', () => ({ teardownFiche: vi.fn() }));
vi.mock('../src/data/auth', () => ({ isKidProfile: () => false, isServerMode: () => true, auth: { profile: { id: 'prof' } } }));
vi.mock('../src/data/socialV3Api', () => ({ getShareLink: vi.fn() }));
vi.mock('../src/data/socialStore', () => ({
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => { h.subs.add(fn); return () => { h.subs.delete(fn); }; },
  refresh: vi.fn(() => Promise.resolve()),
  loadList: vi.fn(() => Promise.resolve(h.st.listDetails.L1)),
  removeFromList: vi.fn(() => Promise.resolve()),
  updateList: vi.fn(() => Promise.resolve()),
}));

import * as api from '../src/data/socialV3Api';
import * as store from '../src/data/socialStore';
import { showShareLink } from '../src/ui/publicTitle.js';
import { showSharedList } from '../src/ui/sharedList.js';
import { state } from '../src/ui/state.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const view = { type: 'movie', tmdbId: 438631, title: 'Dune : Deuxième partie', poster: 'https://image.tmdb.org/t/p/w500/p.jpg', pos: 4354, from: { handle: { name: 'Léa', tag: 'AB23', full: 'Léa#AB23' }, avatarColor: '#7b5cff' }, note: 'CETTE scène <b>x</b>', inviteCode: 'inv-code-1' };

describe('page publique d’un lien', () => {
  beforeEach(() => { h.detail.innerHTML = ''; vi.clearAllMocks(); });

  it('affiche la recommandation, le moment et les deux boutons, en texte brut', async () => {
    (api.getShareLink as any).mockResolvedValueOnce(view);
    showShareLink('AbCdEfGhIjKlMn');
    await flush();
    expect(h.detail.querySelector('h1')!.textContent).toBe('Dune : Deuxième partie');
    expect(h.detail.textContent).toContain('Léa te recommande');
    expect(h.detail.textContent).toContain('à partir de 1:12:34');
    expect(h.detail.querySelector('blockquote')!.textContent).toBe('CETTE scène <b>x</b>');
    expect(h.detail.querySelector('blockquote b')).toBeNull();
    const join = h.detail.querySelector('a.btn') as HTMLAnchorElement;
    expect(join.textContent).toBe('Créer un compte avec l’invitation');
    expect(join.getAttribute('href')).toMatch(/\?invite=inv-code-1$/);
    expect(Array.from(h.detail.querySelectorAll('button')).map((b: any) => b.textContent)).toContain('Ouvrir dans Laststream');
    expect(api.getShareLink).toHaveBeenCalledWith('AbCdEfGhIjKlMn');
  });

  it('sans invitation : pas de bouton de création de compte', async () => {
    (api.getShareLink as any).mockResolvedValueOnce({ ...view, inviteCode: undefined, pos: undefined, note: undefined });
    showShareLink('AbCdEfGhIjKlMn');
    await flush();
    expect(h.detail.querySelector('a.btn')).toBeNull();
    expect(h.detail.textContent).not.toContain('à partir de');
  });

  it('lien inconnu : message sans bouton Réessayer', async () => {
    (api.getShareLink as any).mockRejectedValueOnce({ status: 404 });
    showShareLink('AbCdEfGhIjKlMn');
    await flush();
    expect(h.detail.querySelector('[role="alert"]')!.textContent).toContain('n’existe pas');
    expect(h.detail.querySelector('.pt-err button')).toBeNull();
  });

  it('erreur réseau : bouton Réessayer', async () => {
    (api.getShareLink as any).mockRejectedValueOnce({ status: 0 }).mockResolvedValueOnce(view);
    showShareLink('AbCdEfGhIjKlMn');
    await flush();
    (h.detail.querySelector('.pt-err button') as HTMLElement).click();
    await flush();
    expect(h.detail.querySelector('h1')!.textContent).toBe('Dune : Deuxième partie');
  });
});

describe('page d’une liste partagée', () => {
  beforeEach(() => {
    h.detail.innerHTML = '';
    vi.clearAllMocks();
    h.subs.clear();
    Object.assign(h.st, {
      me: { pid: 'me' }, friends: [], household: [],
      listDetails: {
        L1: {
          id: 'L1', name: 'À voir avec Léa',
          members: [{ pid: 'me', handle: { name: 'Moi', tag: 'ZZ22', full: 'Moi#ZZ22' }, avatarColor: '#ff5a36' }, { pid: 'p1', handle: { name: 'Léa', tag: 'AB23', full: 'Léa#AB23' }, avatarColor: '#7b5cff' }],
          items: [{ type: 'movie', tmdbId: 5, title: 'Dune', poster: '/p.jpg', addedBy: 'p1', addedAt: Date.now() }],
        },
      },
    });
    (state as any).kind = '';
  });

  it('affiche le nom, les membres et les titres avec leur auteur ; retirer appelle le store', async () => {
    showSharedList('L1');
    await flush();
    await flush();
    expect(h.detail.querySelector('h1')!.textContent).toBe('À voir avec Léa');
    expect(h.detail.querySelectorAll('.sl-member').length).toBe(2);
    expect(h.detail.querySelector('.sl-item-m')!.textContent).toContain('ajouté par Léa');
    expect((h.detail.querySelector('.sl-poster') as HTMLAnchorElement).getAttribute('href')).toBe('#/movie/5');
    (h.detail.querySelector('.sl-item .btn') as HTMLElement).click();
    await flush();
    expect(store.removeFromList).toHaveBeenCalledWith('L1', 'movie', 5);
  });

  it('liste inconnue : message d’erreur', async () => {
    (store.loadList as any).mockRejectedValueOnce({ status: 404 });
    showSharedList('L1');
    await flush();
    await flush();
    expect(h.detail.querySelector('[role="alert"]')!.textContent).toContain('n’existe pas');
  });
});
