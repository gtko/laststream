// Barre latérale des amis (Social v2) : groupes, badge, ajout d’ami (validation, erreurs), échappement, profil enfant,
// fiche ami, invitation, clavier, #/friends. Le store est remplacé par un faux : seul l’affichage et les actions sont testés.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { UserApiError } from '../src/data/userApi';

const h = vi.hoisted(() => {
  const subs = new Set<(s: any) => void>();
  const st: any = {};
  const emit = () => {
    st.badge = st.incoming.length + st.unread;
    subs.forEach((f) => f(st));
  };
  return { st, subs, emit };
});

vi.mock('../src/data/socialStore', () => ({
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => {
    h.subs.add(fn);
    return () => h.subs.delete(fn);
  },
  start: vi.fn(),
  stop: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
  setStatus: vi.fn(() => Promise.resolve()),
  sendRequest: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(() => Promise.resolve()),
  removeFriend: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/data/socialV2Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialV2Api')>()),
  getFriendLibrary: vi.fn(),
  getFriendHistory: vi.fn(),
}));

vi.mock('../src/ui/invites.js', () => ({
  refreshInvites: vi.fn(() => Promise.resolve(null)),
  usableInvite: vi.fn(() => null),
  linkOf: (inv: { code: string }) => 'https://laststream.test/?invite=' + inv.code,
  copyInvite: vi.fn(),
  shareInvite: vi.fn(),
  shareBase: () => 'https://laststream.test',
}));

import * as store from '../src/data/socialStore';
import * as v2 from '../src/data/socialV2Api';
import * as invites from '../src/ui/invites.js';
import type * as SidebarModule from '../src/ui/socialSidebar.js';
import type * as ButtonModule from '../src/ui/socialButton.js';

let sb: typeof SidebarModule;
let btn: typeof ButtonModule;
let auth: any;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const root = () => document.getElementById('social-sidebar') as HTMLElement;
const handle = (name: string, tag = 'A7K2') => ({ name, tag, full: name + '#' + tag });
const friend = (pid: string, name: string, extra: Record<string, unknown> = {}) => ({
  pid, handle: handle(name), avatarColor: '#3b82f6', household: false, status: 'online', ...extra,
});
const request = (pid: string, name: string) => ({ pid, handle: handle(name, 'B2C3'), avatarColor: '#ec4899', createdAt: 1 });

const BASE = {
  me: { pid: 'me', handle: handle('Greg', 'ZZ22'), status: 'online', avatarColor: '#ff5a36' },
  status: 'online', friends: [], household: [], incoming: [], outgoing: [], conversations: [], messages: {}, live: 'idle', unread: 0,
};

/** Remplace l’état du faux store et prévient les abonnés (comme le vrai store). */
function setSocial(patch: Record<string, unknown>) {
  Object.assign(h.st, structuredClone({ ...BASE, ...patch }));
  h.emit();
}

const clickEl = (sel: string) => {
  const el = $<HTMLElement>(sel);
  if (!el) throw new Error('élément absent : ' + sel);
  el.click();
};

const pressEscape = (target: Element) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  ({ auth } = await import('../src/data/auth'));
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', isKid: false };
  sb = await import('../src/ui/socialSidebar.js');
  btn = await import('../src/ui/socialButton.js');
  sb.mountSocialSidebar();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.sendRequest).mockReset().mockResolvedValue({ request: request('x', 'Eve') } as never);
  vi.mocked(store.refresh).mockResolvedValue(undefined);
  vi.mocked(v2.getFriendLibrary).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(v2.getFriendHistory).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(invites.refreshInvites).mockResolvedValue(null as never);
  vi.mocked(invites.usableInvite).mockReturnValue(null);
  auth.profile = { id: 'p1', name: 'Greg', isKid: false };
  window.confirm = () => true;
  setSocial({});
  sb.closeSidebar();
});

describe('groupes', () => {
  it('range chacun dans un seul groupe, dans l’ordre : demandes, regarde, en ligne, compte, hors ligne', () => {
    setSocial({
      incoming: [request('r1', 'Carl')],
      outgoing: [request('o1', 'Dana')],
      friends: [
        friend('f1', 'Zoe', { status: 'offline' }),
        friend('f2', 'Amy', {
          status: 'online',
          watching: { type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3, pos: 2052, paused: true, at: 0, poster: '/p.jpg' },
        }),
        friend('f3', 'Bob', { status: 'away' }),
      ],
      household: [friend('h1', 'Léo', { household: true })],
    });
    sb.openSidebar();
    const groups = Array.from(document.querySelectorAll('#ss-groups .ss-group')).map((g) => (g as HTMLElement).dataset.group);
    expect(groups).toEqual(['requests', 'watching', 'online', 'account', 'offline']);
    expect($('[data-group="requests"]')!.textContent).toContain('Carl#B2C3');
    expect($('[data-group="requests"]')!.textContent).toContain('Dana#B2C3');
    expect($('[data-group="requests"] [data-ss-act="accept"]')).not.toBeNull();
    expect($('[data-group="requests"] [data-kind="out"]')!.textContent).toBe('Annuler');
    const watching = $('[data-group="watching"]')!;
    expect(watching.textContent).toContain('Amy#A7K2');
    expect(watching.textContent).toContain('Severance');
    expect(watching.textContent).toContain('S02E03 · 34:12');
    expect($('[data-group="online"]')!.textContent).toContain('Absent');
    expect($('[data-group="account"]')!.textContent).toContain('Léo#A7K2');
    expect($('[data-group="offline"]')!.textContent).toContain('Zoe#A7K2');
  });

  it('« Hors ligne » est replié par défaut ; un clic le déplie', () => {
    setSocial({ friends: [friend('f1', 'Zoe', { status: 'offline' })] });
    sb.openSidebar();
    const foldOf = () => $<HTMLButtonElement>('[data-group="offline"] [data-ss-act="fold"]')!;
    expect(foldOf().getAttribute('aria-expanded')).toBe('false');
    expect($('#ss-g-offline')!.hidden).toBe(true);
    foldOf().click(); // la liste est redessinée : on relit le bouton
    expect(foldOf().getAttribute('aria-expanded')).toBe('true');
    expect($('#ss-g-offline')!.hidden).toBe(false);
  });

  it('sans ami ni demande : message d’invitation, pas de groupe', () => {
    sb.openSidebar();
    expect(document.querySelectorAll('#ss-groups .ss-group')).toHaveLength(0);
    expect($('#ss-groups')!.textContent).toContain('Pas encore d’ami');
  });
});

describe('badge', () => {
  it('demandes reçues + non-lus, mis à jour à chaque changement du store', () => {
    const bar = document.createElement('div');
    bar.innerHTML = btn.friendsButtonHTML('icon-btn');
    document.body.appendChild(bar);
    setSocial({ incoming: [request('r1', 'Carl'), request('r2', 'Ida')], unread: 3 });
    const pastille = bar.querySelector<HTMLElement>('[data-soc-badge]')!;
    expect(pastille.textContent).toBe('5');
    expect(pastille.hidden).toBe(false);
    expect(bar.querySelector('button')!.getAttribute('aria-label')).toBe('Amis, 5 notifications');
    setSocial({ incoming: [], unread: 0 });
    expect(pastille.hidden).toBe(true);
    expect(bar.querySelector('button')!.getAttribute('aria-label')).toBe('Amis');
    bar.remove();
  });

  it('aucun bouton « Amis » pour un profil enfant', () => {
    auth.profile = { id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10 };
    expect(btn.friendsButtonHTML('icon-btn')).toBe('');
    sb.openSidebar();
    expect(sb.isSidebarOpen()).toBe(false);
    expect(root().hidden).toBe(true);
  });
});

describe('ajout d’ami', () => {
  const send = (value: string) => {
    const input = $<HTMLInputElement>('#ss-add-in')!;
    input.value = value;
    $('#ss-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return tick();
  };
  const msg = () => $('#ss-add-msg')!.textContent;

  it('valide le format Nom#TAG avant tout appel réseau', async () => {
    sb.openSidebar();
    await send('pas un pseudo');
    expect(msg()).toContain('Pseudo invalide');
    expect(store.sendRequest).not.toHaveBeenCalled();
    await send('Eve#0O1I');
    expect(msg()).toContain('Pseudo invalide');
    expect(store.sendRequest).not.toHaveBeenCalled();
  });

  it('envoie le handle normalisé (tag en majuscules) et affiche le résultat', async () => {
    sb.openSidebar();
    await send('  Eve#a7k2 ');
    expect(store.sendRequest).toHaveBeenLastCalledWith('Eve#A7K2');
    expect(msg()).toBe('Demande envoyée à Eve#A7K2.');
    expect($<HTMLInputElement>('#ss-add-in')!.value).toBe('');
  });

  it('demande réciproque : l’ami est ajouté directement', async () => {
    sb.openSidebar();
    vi.mocked(store.sendRequest).mockResolvedValueOnce({ friend: friend('f9', 'Eve') } as never);
    await send('Eve#A7K2');
    expect(msg()).toBe('Eve#A7K2 est maintenant ton ami.');
  });

  it.each([
    ['handle_not_found', 'Aucun profil avec ce pseudo exact.'],
    ['already_friends', 'Vous êtes déjà amis.'],
    ['already_requested', 'Une demande est déjà en attente.'],
    ['self', 'Tu ne peux pas t’ajouter toi-même.'],
    ['invalid_handle', 'Pseudo invalide : écris Nom#TAG (2 à 20 caractères, puis # et 4 caractères).'],
  ])('erreur serveur %s : message en français', async (code, text) => {
    sb.openSidebar();
    vi.mocked(store.sendRequest).mockRejectedValueOnce(new UserApiError(409, code));
    await send('Eve#A7K2');
    expect(msg()).toBe(text);
    expect($('#ss-add-msg')!.dataset.tone).toBe('error');
  });

  it('serveur injoignable : message dédié', async () => {
    sb.openSidebar();
    vi.mocked(store.sendRequest).mockRejectedValueOnce(new UserApiError(0, 'network'));
    await send('Eve#A7K2');
    expect(msg()).toBe('Serveur injoignable pour le moment.');
  });
});

describe('échappement', () => {
  it('nom, titre, couleur et poster hostiles restent du texte', () => {
    const evil = '<img src=x onerror="window.__ssXss=1">';
    setSocial({
      friends: [{
        pid: 'x1',
        handle: { name: evil, tag: 'AAAA', full: evil + '#AAAA' },
        avatarColor: 'red" onmouseover="window.__ssXss=2',
        household: false,
        status: 'online',
        watching: { type: 'movie', tmdbId: 1, title: '<b>Titre</b>', poster: 'javascript:alert(1)', pos: 0, paused: true, at: 0 },
      }],
    });
    sb.openSidebar();
    const groups = $('#ss-groups')!;
    expect(groups.querySelector('img[src="x"]')).toBeNull();
    expect(groups.querySelector('b')).toBeNull();
    expect(groups.querySelector('[onmouseover]')).toBeNull();
    expect(groups.querySelector('img')).toBeNull(); // poster non https : pas d’image
    expect(groups.textContent).toContain(evil + '#AAAA');
    expect(groups.textContent).toContain('<b>Titre</b>');
    expect((window as unknown as { __ssXss?: number }).__ssXss).toBeUndefined();
  });
});

describe('fiche ami', () => {
  beforeEach(() => {
    vi.mocked(v2.getFriendLibrary).mockResolvedValue({
      items: [
        { type: 'movie', tmdbId: 603, imdbId: null, title: 'Matrix', poster: null, addedAt: '2026-01-01' },
        { type: 'series', tmdbId: null, imdbId: 'tt1', title: 'Sans TMDB', poster: null, addedAt: '2026-01-01' },
      ],
    });
    vi.mocked(v2.getFriendHistory).mockResolvedValue({
      items: [{ type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3, pos: 2052, watched: false, updatedAt: 1 }],
    });
    setSocial({
      friends: [friend('f2', 'Amy', {
        watching: { type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3, pos: 2052, paused: false, at: Date.now() },
      })],
    });
  });

  it('affiche bibliothèque (titres TMDB seulement), historique et ouvre la discussion', async () => {
    sb.openSidebar();
    clickEl('[data-ss-act="open"][data-pid="f2"]');
    await tick();
    expect(v2.getFriendLibrary).toHaveBeenCalledWith('f2');
    expect(v2.getFriendHistory).toHaveBeenCalledWith('f2', 20);
    expect($('#ss-friend')!.hidden).toBe(false);
    expect($('#ss-home')!.hidden).toBe(true);
    expect($('#ss-title')!.textContent).toBe('Amy#A7K2');
    expect($('#ss-friend-head')!.textContent).toContain('Regarder avec lui');
    expect(document.querySelectorAll('#ss-lib [data-ss-act="lib-play"]')).toHaveLength(1);
    expect($('#ss-lib')!.textContent).not.toContain('Sans TMDB');
    expect($('#ss-hist')!.textContent).toContain('S02E03 · 34:12');

    clickEl('[data-ss-act="message"]');
    await tick();
    expect($('#ss-conv')!.hidden).toBe(false);
    expect($('#ss-conv')!.textContent).toContain('arrive bientôt');
    expect($('#ss-friend')!.hidden).toBe(true);
  });

  it('« Regarder avec lui » appelle le hook du lot suivant, sinon un message', async () => {
    sb.openSidebar();
    clickEl('[data-ss-act="open"][data-pid="f2"]');
    await tick();
    const hook = vi.fn();
    sb.setWatchWithHandler(hook);
    clickEl('[data-ss-act="watch"]');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ pid: 'f2' }));
    sb.setWatchWithHandler(null);
  });

  it('« Retirer » demande confirmation puis appelle removeFriend', async () => {
    sb.openSidebar();
    clickEl('[data-ss-act="open"][data-pid="f2"]');
    await tick();
    window.confirm = () => false;
    clickEl('[data-ss-act="remove"]');
    await tick();
    expect(store.removeFriend).not.toHaveBeenCalled();
    window.confirm = () => true;
    clickEl('[data-ss-act="remove"]');
    await tick();
    expect(store.removeFriend).toHaveBeenCalledWith('f2');
  });

  it('Échap revient à la liste, puis un second Échap ferme la barre', async () => {
    sb.openSidebar();
    clickEl('[data-ss-act="open"][data-pid="f2"]');
    await tick();
    pressEscape($('#ss-friend')!);
    expect($('#ss-home')!.hidden).toBe(false);
    expect(sb.isSidebarOpen()).toBe(true);
    pressEscape($('#ss-title')!);
    expect(sb.isSidebarOpen()).toBe(false);
  });
});

describe('barre et invitation', () => {
  it('invitation : charge le premier lien utilisable, copie et partage via invites.js', async () => {
    const inv = { id: 'i1', code: 'Kq3abcd', state: 'free' };
    vi.mocked(invites.refreshInvites).mockResolvedValue({ quota: 4, invites: [inv] } as never);
    vi.mocked(invites.usableInvite).mockReturnValue(inv as never);
    sb.openSidebar();
    await tick();
    expect($<HTMLInputElement>('#ss-inv-slot input')!.value).toBe('https://laststream.test/?invite=Kq3abcd');
    clickEl('[data-ss-act="copy-invite"]');
    expect(invites.copyInvite).toHaveBeenCalledWith('i1');
    clickEl('[data-ss-act="share-invite"]');
    expect(invites.shareInvite).toHaveBeenCalledWith('i1');
  });

  it('invitation sans lien disponible : message, pas de bouton', async () => {
    sb.openSidebar();
    await tick();
    expect($('#ss-inv-slot')!.textContent).toContain('Aucun lien disponible');
    expect($('#ss-inv-slot [data-ss-act="copy-invite"]')).toBeNull();
  });

  it('changement de statut : appelle setStatus avec la valeur choisie', async () => {
    sb.openSidebar();
    const sel = $<HTMLSelectElement>('#ss-status')!;
    sel.value = 'dnd';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(store.setStatus).toHaveBeenCalledWith('dnd');
  });

  it('en-tête : Nom#TAG de moi et statut courant', () => {
    sb.openSidebar();
    expect($('#ss-me-handle')!.textContent).toBe('Greg#ZZ22');
    expect($<HTMLSelectElement>('#ss-status')!.value).toBe('online');
  });

  it('#/friends ouvre la barre sans remplacer la page en cours', async () => {
    sb.closeSidebar();
    const router = await import('../src/ui/router.js');
    location.hash = '#/friends';
    expect(router.parseRoute()).toEqual({ kind: 'friends' });
    const detail = document.getElementById('detail')!;
    detail.hidden = true;
    router.route();
    expect(sb.isSidebarOpen()).toBe(true);
    expect(detail.hidden).toBe(true);
    sb.closeSidebar();
    location.hash = '';
  });

  it('profil enfant : #/friends ne renvoie aucune route', async () => {
    const router = await import('../src/ui/router.js');
    auth.profile = { id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10 };
    location.hash = '#/friends';
    expect(router.parseRoute()).toBeNull();
    location.hash = '';
  });
});

describe('texte d’erreur des actions', () => {
  it('socialErrorMessage : codes connus et inconnus', () => {
    expect(sb.socialErrorMessage(new UserApiError(404, 'handle_not_found'))).toBe('Aucun profil avec ce pseudo exact.');
    expect(sb.socialErrorMessage(new UserApiError(500, 'boom'))).toBe('Erreur (boom).');
    expect(sb.socialErrorMessage(new Error('x'))).toBe('Une erreur est survenue.');
  });

  it('format des durées et de l’épisode', () => {
    expect(sb.clock(2052)).toBe('34:12');
    expect(sb.clock(3723)).toBe('1:02:03');
    expect(sb.episodeCode({ type: 'series', season: 2, episode: 3 })).toBe('S02E03');
    expect(sb.episodeCode({ type: 'movie' })).toBe('');
  });
});
