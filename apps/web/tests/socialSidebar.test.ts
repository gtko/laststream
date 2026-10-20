// Barre latérale des amis (Social v3, lot F1) : en-tête, statut, onglets (Amis / Messages / Activité), groupes, carte riche
// « en train de regarder », demandes (amitié et rejoindre), ajout par Nom#TAG, pied « Inviter », fiche ami (profil, onglets,
// menu ⋯, dialogues), échappement, profil enfant, clavier, #/friends. Le store est remplacé par un faux : seul l'affichage
// et les actions sont testés.
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
  return { st, subs, emit, joinAnswerCb: null as null | ((ev: any) => void) };
});

vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => {
    h.subs.add(fn);
    return () => h.subs.delete(fn);
  },
  onJoinAnswer: (cb: (ev: any) => void) => {
    h.joinAnswerCb = cb;
    return () => undefined;
  },
  start: vi.fn(),
  stop: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
  setStatus: vi.fn(() => Promise.resolve()),
  sendRequest: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(() => Promise.resolve()),
  removeFriend: vi.fn(() => Promise.resolve()),
  loadActivity: vi.fn(() => Promise.resolve([])),
  saveRelation: vi.fn(() => Promise.resolve({})),
  block: vi.fn(() => Promise.resolve()),
  report: vi.fn(() => Promise.resolve()),
  requestJoin: vi.fn(() => Promise.resolve()),
  answerJoin: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/data/socialV2Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialV2Api')>()),
  getFriendLibrary: vi.fn(),
  getFriendHistory: vi.fn(),
}));

vi.mock('../src/data/socialV3Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialV3Api')>()),
  getFriendProfile: vi.fn(),
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
import * as v3 from '../src/data/socialV3Api';
import * as invites from '../src/ui/invites.js';
import { registerSocialHook } from '../src/ui/socialHooks.js';
import type * as SidebarModule from '../src/ui/socialSidebar.js';
import type * as ButtonModule from '../src/ui/socialButton.js';

let sb: typeof SidebarModule;
let btn: typeof ButtonModule;
let auth: any;
const hooks = {
  openProfileEditor: vi.fn(),
  renderConversationList: vi.fn((el: HTMLElement) => {
    el.innerHTML = '<p id="conv-list">liste F3</p>';
    return () => hooks.cleanup();
  }),
  inviteToParty: vi.fn(),
  openShareDialog: vi.fn(),
  openConversation: vi.fn(),
  cleanup: vi.fn(),
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const root = () => document.getElementById('social-sidebar') as HTMLElement;
const handle = (name: string, tag = 'A7K2') => ({ name, tag, full: name + '#' + tag });
const friend = (pid: string, name: string, extra: Record<string, unknown> = {}) => ({
  pid, handle: handle(name), avatarColor: '#3b82f6', household: false, status: 'online', ...extra,
});
const request = (pid: string, name: string) => ({ pid, handle: handle(name, 'B2C3'), avatarColor: '#ec4899', createdAt: 1 });
const watching = (extra: Record<string, unknown> = {}) => ({
  type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3, pos: 2052, paused: true, at: 0, poster: '/p.jpg', ...extra,
});

const BASE = {
  me: { pid: 'me', handle: handle('Greg', 'ZZ22'), status: 'online', avatarColor: '#ff5a36' },
  status: 'online', friends: [], household: [], incoming: [], outgoing: [], conversations: [], messages: {}, live: 'idle', unread: 0,
  joinRequests: [], activity: [], profile: null,
};

/** Remplace l'état du faux store et prévient les abonnés (comme le vrai store). */
function setSocial(patch: Record<string, unknown>) {
  Object.assign(h.st, structuredClone({ ...BASE, ...patch }));
  h.emit();
}

const clickEl = (sel: string) => {
  const el = $<HTMLElement>(sel);
  if (!el) throw new Error('élément absent : ' + sel);
  el.click();
};

const pressKey = (target: Element, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const toastText = () => document.getElementById('toast')?.textContent ?? '';

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
  registerSocialHook('openProfileEditor', hooks.openProfileEditor);
  registerSocialHook('renderConversationList', hooks.renderConversationList);
  registerSocialHook('inviteToParty', hooks.inviteToParty);
  registerSocialHook('openShareDialog', hooks.openShareDialog);
  registerSocialHook('openConversation', hooks.openConversation);
  sb.mountSocialSidebar();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.sendRequest).mockReset().mockResolvedValue({ request: request('x', 'Eve') } as never);
  vi.mocked(store.refresh).mockResolvedValue(undefined);
  vi.mocked(store.loadActivity).mockResolvedValue([]);
  vi.mocked(v2.getFriendLibrary).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(v2.getFriendHistory).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(v3.getFriendProfile).mockReset().mockResolvedValue({ pid: 'f2', handle: handle('Amy'), avatarColor: '#3b82f6', favorites: [] } as never);
  vi.mocked(invites.refreshInvites).mockResolvedValue(null as never);
  vi.mocked(invites.usableInvite).mockReturnValue(null);
  auth.profile = { id: 'p1', name: 'Greg', isKid: false };
  setSocial({});
  sb.closeSidebar();
  root().querySelector<HTMLElement>('#ss-tab-friends')!.click();
});

describe('en-tête et statut', () => {
  it('Nom#TAG de moi, avatar, statut et pastille de messages non lus', () => {
    setSocial({ unread: 2 });
    sb.openSidebar();
    expect($('#ss-me-handle')!.textContent).toBe('Greg#ZZ22');
    expect($('#ss-me-av .ss-av')!.getAttribute('style')).toContain('#ff5a36');
    expect($('#ss-status-btn')!.textContent).toContain('En ligne');
    expect($('#ss-unread')!.textContent).toBe('2');
    expect($('#ss-unread')!.hidden).toBe(false);
  });

  it('statut personnalisé affiché à côté de la présence', () => {
    setSocial({ profile: { customStatus: { emoji: '🍿', text: 'Soirée SF' } } });
    sb.openSidebar();
    expect($('#ss-status-btn')!.textContent).toContain('« 🍿 Soirée SF »');
  });

  it('le menu de statut appelle setStatus avec la valeur choisie', async () => {
    sb.openSidebar();
    expect($('#ss-status-menu')!.hidden).toBe(true);
    clickEl('#ss-status-btn');
    expect($('#ss-status-menu')!.hidden).toBe(false);
    expect($('#ss-status-btn')!.getAttribute('aria-expanded')).toBe('true');
    clickEl('[data-status="dnd"]');
    await tick();
    expect(store.setStatus).toHaveBeenCalledWith('dnd');
    expect($('#ss-status-menu')!.hidden).toBe(true);
  });

  it('réglages (engrenage) et « Statut personnalisé… » ouvrent l’édition du profil (F2)', () => {
    sb.openSidebar();
    clickEl('.ss-me > [data-ss-act="profile"].ss-d-only');
    expect(hooks.openProfileEditor).toHaveBeenCalledTimes(1);
    clickEl('#ss-status-btn');
    clickEl('#ss-status-menu [data-ss-act="profile"]');
    expect(hooks.openProfileEditor).toHaveBeenCalledTimes(2);
  });

  it('copier le Nom#TAG', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    sb.openSidebar();
    clickEl('#ss-me-handle');
    await tick();
    expect(writeText).toHaveBeenCalledWith('Greg#ZZ22');
  });
});

describe('onglets', () => {
  it('Messages rend la liste des conversations du lot F3, nettoyée en quittant l’onglet', () => {
    sb.openSidebar();
    clickEl('#ss-tab-messages');
    expect(hooks.renderConversationList).toHaveBeenCalledTimes(1);
    expect($('#ss-p-messages')!.hidden).toBe(false);
    expect($('#conv-list')).not.toBeNull();
    expect($('#ss-p-friends')!.hidden).toBe(true);
    clickEl('#ss-tab-friends');
    expect(hooks.cleanup).toHaveBeenCalledTimes(1);
    expect($('#ss-p-friends')!.hidden).toBe(false);
  });

  it('Activité charge le fil et le dessine (texte échappé)', async () => {
    setSocial({
      activity: [
        { id: 'a1', pid: 'f1', handle: handle('Zoe'), avatarColor: '#3b82f6', kind: 'rated', rating: 4.5, at: Date.now() - 3 * 3600_000, media: { type: 'tv', tmdbId: 1, title: '<b>Bear</b>', season: 3, episode: 4 } },
        { id: 'a2', pid: 'f1', handle: handle('Zoe'), avatarColor: '#3b82f6', kind: 'started', at: Date.now(), media: { type: 'movie', tmdbId: 2, title: 'Dune' } },
      ],
    });
    sb.openSidebar();
    clickEl('#ss-tab-activity');
    await tick();
    expect(store.loadActivity).toHaveBeenCalled();
    const feed = $('#ss-p-activity')!;
    expect(feed.querySelectorAll('li')).toHaveLength(2);
    expect(feed.textContent).toContain('a noté <b>Bear</b> · S03E04 · ★ 4,5');
    expect(feed.querySelector('b')).toBeNull();
    expect(feed.textContent).toContain('a commencé Dune');
  });

  it('flèches gauche/droite passent d’un onglet à l’autre', () => {
    sb.openSidebar();
    pressKey($('#ss-tab-friends')!, 'ArrowRight');
    expect($('#ss-tab-messages')!.getAttribute('aria-selected')).toBe('true');
    pressKey($('#ss-tab-messages')!, 'ArrowLeft');
    expect($('#ss-tab-friends')!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('groupes', () => {
  it('range chacun dans un seul groupe, dans l’ordre : demandes, regarde, en ligne, compte, hors ligne', () => {
    setSocial({
      incoming: [request('r1', 'Carl')],
      outgoing: [request('o1', 'Dana')],
      joinRequests: [friend('j1', 'Jo')],
      friends: [
        friend('f1', 'Zoe', { status: 'offline', lastSeen: Date.now() - 3 * 3600_000 }),
        friend('f2', 'Amy', { status: 'online', watching: watching() }),
        friend('f3', 'Bob', { status: 'away', lastSeen: Date.now() - 12 * 60_000 }),
      ],
      household: [friend('h1', 'Léo', { household: true })],
    });
    sb.openSidebar();
    const groups = Array.from(document.querySelectorAll('#ss-groups .ss-group')).map((g) => (g as HTMLElement).dataset.group);
    expect(groups).toEqual(['requests', 'watching', 'online', 'account', 'offline']);
    const req = $('[data-group="requests"]')!;
    expect(req.textContent).toContain('Carl#B2C3');
    expect(req.textContent).toContain('Dana#B2C3');
    expect(req.textContent).toContain('Jo#A7K2');
    expect(req.querySelector('[data-ss-act="accept"]')).not.toBeNull();
    expect(req.querySelector('[data-kind="out"]')!.getAttribute('aria-label')).toContain('Annuler');
    expect(req.querySelector('[data-ss-act="join-accept"]')).not.toBeNull();
    expect($('[data-group="requests"] .ss-count')!.textContent).toBe('3');
    expect($('[data-group="watching"]')!.textContent).toContain('Severance');
    expect($('[data-group="online"]')!.textContent).toContain('Absent · 12 min');
    expect($('[data-group="account"]')!.textContent).toContain('Léo#A7K2');
    expect($('[data-group="offline"]')!.textContent).toContain('Zoe#A7K2');
    expect($('[data-group="offline"]')!.textContent).toContain('Hors ligne · il y a 3 h');
  });

  it('carte riche : progression, « Regarder avec … », écrire à, plus d’actions', () => {
    setSocial({ friends: [friend('f2', 'Amy', { watching: watching({ paused: true, pos: 2052, duration: 4104 }) })] });
    sb.openSidebar();
    const card = $('[data-group="watching"] .ss-wcard')!;
    expect(card.textContent).toContain('Severance');
    expect(card.textContent).toContain('S02E03 · 34:12');
    expect(card.textContent).toContain('1:08:24');
    expect(card.querySelector<HTMLElement>('.ss-bar-t i')!.style.width).toBe('50%');
    expect(card.querySelector('[data-ss-act="watch"]')!.textContent).toBe('Regarder avec Amy');
    expect(card.querySelector('[aria-label="Écrire à Amy"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Plus d’actions"]')).not.toBeNull();
  });

  it('un ami qui regarde mais en « ne pas déranger » reste une ligne simple avec l’affiche', () => {
    setSocial({ friends: [friend('f2', 'Nora', { status: 'dnd', watching: watching() })] });
    sb.openSidebar();
    expect($('[data-group="watching"] .ss-wcard')).toBeNull();
    expect($('[data-group="watching"]')!.textContent).toContain('ne pas déranger');
    expect($('[data-group="watching"] .ss-poster img')).not.toBeNull();
  });

  it('« Regarder avec … » appelle le hook watchWith', () => {
    setSocial({ friends: [friend('f2', 'Amy', { watching: watching() })] });
    sb.openSidebar();
    const hook = vi.fn();
    sb.setWatchWithHandler(hook);
    clickEl('[data-group="watching"] [data-ss-act="watch"]');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ pid: 'f2' }));
    sb.setWatchWithHandler(null);
    clickEl('[data-group="watching"] [data-ss-act="watch"]');
    expect(toastText()).toContain('arrive bientôt');
  });

  it('« Hors ligne » est replié par défaut ; un clic le déplie', () => {
    setSocial({ friends: [friend('f1', 'Zoe', { status: 'offline' })] });
    sb.openSidebar();
    const foldOf = () => $<HTMLButtonElement>('[data-group="offline"] [data-ss-act="fold"]')!;
    expect(foldOf().getAttribute('aria-expanded')).toBe('false');
    expect($('#ss-g-offline')!.hidden).toBe(true);
    foldOf().click();
    expect(foldOf().getAttribute('aria-expanded')).toBe('true');
    expect($('#ss-g-offline')!.hidden).toBe(false);
  });

  it('les favoris passent en tête du groupe, le surnom remplace le nom', () => {
    setSocial({ friends: [friend('f1', 'Anna'), friend('f2', 'Zed', { favorite: true, nickname: 'Zézé' })] });
    sb.openSidebar();
    const names = Array.from(document.querySelectorAll('[data-group="online"] .ss-name')).map((n) => n.textContent);
    expect(names).toEqual(['Zézé#A7K2', 'Anna#A7K2']);
  });

  it('sans ami ni demande : message d’invitation, pas de groupe', () => {
    sb.openSidebar();
    expect(document.querySelectorAll('#ss-groups .ss-group')).toHaveLength(0);
    expect($('#ss-groups')!.textContent).toContain('Pas encore d’ami');
  });

  it('accepter / refuser une demande appelle le store', async () => {
    setSocial({ incoming: [request('r1', 'Carl')] });
    vi.mocked(store.accept).mockResolvedValue(friend('r1', 'Carl') as never);
    sb.openSidebar();
    clickEl('[data-ss-act="accept"]');
    await tick();
    expect(store.accept).toHaveBeenCalledWith('r1');
    clickEl('[data-ss-act="decline"][data-kind="in"]');
    await tick();
    expect(store.decline).toHaveBeenCalledWith('r1');
  });
});

describe('demandes de rejoindre', () => {
  it('une demande entrante affiche un toast avec « Accepter » qui répond au store', async () => {
    sb.openSidebar();
    setSocial({ joinRequests: [friend('j1', 'Jo')] });
    expect(toastText()).toContain('Jo demande à rejoindre ta watch party');
    document.querySelector<HTMLElement>('#toast .toast-action')!.click();
    await tick();
    expect(store.answerJoin).toHaveBeenCalledWith('j1', { accept: true });
    expect(hooks.inviteToParty).toHaveBeenCalledWith('j1');
  });

  it('la ligne de la liste permet de refuser', async () => {
    setSocial({ joinRequests: [friend('j1', 'Jo')] });
    sb.openSidebar();
    clickEl('[data-ss-act="join-decline"]');
    await tick();
    expect(store.answerJoin).toHaveBeenCalledWith('j1', { accept: false });
  });

  it('la réponse reçue : accepte avec salon (bouton Rejoindre) ou refus', () => {
    setSocial({ friends: [friend('f2', 'Amy')] });
    h.joinAnswerCb!({ pid: 'f2', accept: true, partyId: 'room_1' });
    expect(toastText()).toContain('Amy accepte');
    document.querySelector<HTMLElement>('#toast .toast-action')!.click();
    expect(location.hash).toBe('#/party/room_1');
    location.hash = '';
    h.joinAnswerCb!({ pid: 'f2', accept: false });
    expect(toastText()).toContain('Amy ne peut pas');
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

describe('ajout d’ami et recherche', () => {
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

  it('taper un nom (sans #) filtre la liste ; sans résultat, un message', () => {
    setSocial({ friends: [friend('f1', 'Anna'), friend('f2', 'Bob')] });
    sb.openSidebar();
    const input = $<HTMLInputElement>('#ss-add-in')!;
    input.value = 'bo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const names = Array.from(document.querySelectorAll('#ss-groups .ss-name')).map((n) => n.textContent);
    expect(names).toEqual(['Bob#A7K2']);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('#ss-groups')!.textContent).toContain('Aucun ami ne correspond');
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
    expect(groups.querySelector('img')).toBeNull();
    expect(groups.querySelector('b')).toBeNull();
    expect(groups.querySelector('[onmouseover]')).toBeNull();
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
      items: [{ type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3, pos: 2052, watched: false, updatedAt: Date.now() - 2 * 3600_000 }],
    });
    vi.mocked(v3.getFriendProfile).mockResolvedValue({
      pid: 'f2', handle: handle('Amy'), avatarColor: '#3b82f6',
      bio: 'SF lente <i>et</i> sous-titres', friendSince: new Date(2025, 2, 10).getTime(), commonTitles: 23, stats: { hoursWatched: 10, notes: 38, friends: 4 },
      banner: { tmdbId: 1, type: 'movie', backdrop: '/ban.jpg', title: 'Arrival' },
      favorites: [
        { tmdbId: 1, type: 'movie', title: 'Arrival', poster: '/a.jpg' },
        { tmdbId: 2, type: 'movie', title: 'Perfect Days' },
      ],
    } as never);
    setSocial({ friends: [friend('f2', 'Amy', { watching: watching({ paused: false, at: Date.now() }) })] });
  });

  const openCard = async () => {
    sb.openSidebar();
    clickEl('[data-group="watching"] [data-ss-act="open"]');
    await tick();
  };

  it('affiche bannière, bio, depuis quand, favoris, carte en cours et ouvre la bonne vue', async () => {
    await openCard();
    expect(v3.getFriendProfile).toHaveBeenCalledWith('f2');
    expect($('#ss-friend')!.hidden).toBe(false);
    expect($('#ss-home')!.hidden).toBe(true);
    expect(root().getAttribute('aria-label')).toBe('Fiche de Amy');
    const card = $('#ss-friend')!;
    expect(card.textContent).toContain('Bannière : Arrival');
    expect(card.querySelector<HTMLElement>('[data-banner]')!.style.backgroundImage).toContain('image.tmdb.org/t/p/w780/ban.jpg');
    expect(card.textContent).toContain('Amis depuis mars 2025');
    expect(card.textContent).toContain('23 titres en commun');
    expect(card.querySelector('.ss-c-bio')!.textContent).toBe('« SF lente <i>et</i> sous-titres »');
    expect(card.querySelector('.ss-c-bio i')).toBeNull();
    expect(card.textContent).toContain('Ses 2 favoris');
    expect(card.querySelectorAll('.ss-c-favs li')).toHaveLength(2);
    expect(card.querySelector('.ss-c-now')!.textContent).toContain('En train de regarder');
    expect(card.querySelector('[data-ss-act="watch"]')!.textContent).toBe('Regarder avec Amy');
    expect(card.querySelector('[data-ss-act="c-join"]')!.textContent).toContain('Demander à rejoindre');
  });

  it('onglets : Récemment, Bibliothèque (titres TMDB seulement, comptes), Ses notes', async () => {
    await openCard();
    expect($('#ss-friend')!.textContent).toContain('S02E03');
    const tabs = Array.from(document.querySelectorAll('#ss-friend [role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Récemment', 'Bibliothèque · 1', 'Ses notes · 38']);
    clickEl('[data-tab="lib"]');
    expect(document.querySelectorAll('#ss-friend [data-ss-act="lib-play"]')).toHaveLength(1);
    expect($('#ss-friend')!.textContent).not.toContain('Sans TMDB');
    expect($('[data-tab="lib"]')!.getAttribute('aria-selected')).toBe('true');
    clickEl('[data-tab="notes"]');
    expect($('#ss-friend .ss-c-panel')!.textContent).toContain('38 notes');
  });

  it('« Regarder avec … » (hook) et « Demander à rejoindre » (requestJoin)', async () => {
    await openCard();
    const hook = vi.fn();
    sb.setWatchWithHandler(hook);
    clickEl('#ss-friend [data-ss-act="watch"]');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ pid: 'f2' }));
    sb.setWatchWithHandler(null);
    clickEl('#ss-friend [data-ss-act="c-join"]');
    await tick();
    expect(store.requestJoin).toHaveBeenCalledWith('f2');
    expect(toastText()).toContain('Demande envoyée à Amy');
  });

  it('demande refusée par le serveur (403) : message clair', async () => {
    vi.mocked(store.requestJoin).mockRejectedValueOnce(new UserApiError(403, 'forbidden'));
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-join"]');
    await tick();
    expect(toastText()).toContain('n’accepte pas');
  });

  it('Message ouvre la discussion, Envoyer un titre le partage (F4)', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-share"]');
    expect(hooks.openShareDialog).toHaveBeenCalledWith({ media: null, to: ['f2'] });
    clickEl('#ss-friend [data-ss-act="message"]');
    await tick();
    expect(hooks.openConversation).toHaveBeenCalledWith('dm:f2');
  });

  it('le menu ⋯ liste les actions de la maquette et agit sur la relation', async () => {
    await openCard();
    expect($('#ss-friend .ss-menu')).toBeNull();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    const items = Array.from(document.querySelectorAll('#ss-friend [role="menuitem"]')).map((i) => i.textContent);
    expect(items).toEqual([
      'Inviter dans ma watch party', 'Voir sa bibliothèque complète', 'Surnom privé…', 'Mettre en favori (en haut)',
      'Couper ses notifications', 'Masquer son activité', 'Retirer des amis', 'Bloquer et signaler',
    ]);
    clickEl('[data-ss-act="m-fav"]');
    await tick();
    expect(store.saveRelation).toHaveBeenCalledWith('f2', { favorite: true });
    expect($('#ss-friend .ss-menu')).toBeNull();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-mute"]');
    await tick();
    expect(store.saveRelation).toHaveBeenLastCalledWith('f2', { muted: true });
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-hide"]');
    await tick();
    expect(store.saveRelation).toHaveBeenLastCalledWith('f2', { hideActivity: true });
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-party"]');
    expect(hooks.inviteToParty).toHaveBeenCalledWith('f2');
  });

  it('surnom privé : dialogue, puis saveRelation', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-nick"]');
    const input = $<HTMLInputElement>('.ss-dlg input[name="nickname"]')!;
    expect(input.maxLength).toBe(32);
    input.value = '  Ams ';
    clickEl('.ss-dlg [data-ss-act="dlg-ok"]');
    await tick();
    expect(store.saveRelation).toHaveBeenCalledWith('f2', { nickname: 'Ams' });
    expect($('.ss-dlg')).toBeNull();
  });

  it('retirer des amis demande confirmation', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-remove"]');
    expect($('.ss-dlg')!.textContent).toContain('Retirer Amy de tes amis ?');
    clickEl('.ss-dlg [data-ss-act="dlg-cancel"]');
    await tick();
    expect(store.removeFriend).not.toHaveBeenCalled();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-remove"]');
    clickEl('.ss-dlg [data-ss-act="dlg-ok"]');
    await tick();
    expect(store.removeFriend).toHaveBeenCalledWith('f2');
  });

  it('bloquer et signaler : confirmation avec motif, signalement puis blocage', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-block"]');
    expect($('.ss-dlg')!.textContent).toContain('Bloquer et signaler Amy ?');
    clickEl('.ss-dlg input[value="harassment"]');
    $<HTMLTextAreaElement>('.ss-dlg textarea')!.value = 'insultes';
    clickEl('.ss-dlg [data-ss-act="dlg-ok"]');
    await tick();
    expect(store.report).toHaveBeenCalledWith({ pid: 'f2', reason: 'harassment', details: 'insultes' });
    expect(store.block).toHaveBeenCalledWith('f2');
    expect(vi.mocked(store.report).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.block).mock.invocationCallOrder[0]);
  });

  it('annuler la confirmation ne bloque personne', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-block"]');
    clickEl('.ss-dlg [data-ss-act="dlg-cancel"]');
    await tick();
    expect(store.block).not.toHaveBeenCalled();
    expect(store.report).not.toHaveBeenCalled();
  });

  it('un profil du compte n’a ni « Retirer » ni « Bloquer »', async () => {
    setSocial({ household: [friend('h1', 'Sam', { household: true })] });
    sb.openSidebar();
    clickEl('[data-group="account"] [data-ss-act="open"]');
    await tick();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    expect($('[data-ss-act="m-remove"]')).toBeNull();
    expect($('[data-ss-act="m-block"]')).toBeNull();
  });

  it('Échap : ferme le dialogue, puis le menu, puis la fiche, puis la barre', async () => {
    await openCard();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    clickEl('[data-ss-act="m-nick"]');
    expect($('.ss-dlg')).not.toBeNull();
    pressKey($('.ss-dlg input')!, 'Escape');
    expect($('.ss-dlg')).toBeNull();
    clickEl('#ss-friend [data-ss-act="c-menu"]');
    pressKey($('#ss-friend .ss-menu [role="menuitem"]')!, 'Escape');
    expect($('#ss-friend .ss-menu')).toBeNull();
    expect($('#ss-home')!.hidden).toBe(true);
    pressKey($('#ss-friend')!, 'Escape');
    expect($('#ss-home')!.hidden).toBe(false);
    expect(sb.isSidebarOpen()).toBe(true);
    pressKey($('#ss-tab-friends')!, 'Escape');
    expect(sb.isSidebarOpen()).toBe(false);
  });

  it('profil indisponible : la fiche reste affichée avec ce que le store connaît', async () => {
    vi.mocked(v3.getFriendProfile).mockRejectedValue(new UserApiError(500, 'boom'));
    await openCard();
    expect($('#ss-friend')!.textContent).toContain('Amy#A7K2');
    expect($('#ss-friend .ss-c-bio')).toBeNull();
  });
});

describe('pied « Inviter quelqu’un »', () => {
  it('compte les invitations restantes, copie le lien et partage depuis le bouton flottant (mobile)', async () => {
    const inv = { id: 'i1', code: 'Kq3abcd', state: 'free' };
    const data = { quota: 4, invites: [inv, { id: 'i2', code: 'x', state: 'sent' }, { id: 'i3', code: 'y', state: 'used' }] };
    vi.mocked(invites.refreshInvites).mockResolvedValue(data as never);
    vi.mocked(invites.usableInvite).mockReturnValue(inv as never);
    sb.openSidebar();
    await tick();
    expect($('#ss-inv-slot')!.textContent).toContain('2 invitations restantes');
    expect($('#ss-fab-t')!.textContent).toBe('Inviter · 2');
    expect($<HTMLElement>('#ss-fab')!.hidden).toBe(false);
    clickEl('[data-ss-act="copy-invite"]');
    expect(invites.copyInvite).toHaveBeenCalledWith('i1');
    clickEl('#ss-fab');
    expect(invites.shareInvite).toHaveBeenCalledWith('i1');
  });

  it('sans lien disponible : message, pas de bouton', async () => {
    sb.openSidebar();
    await tick();
    expect($('#ss-inv-slot')!.textContent).toContain('Aucun lien disponible');
    expect($('#ss-inv-slot [data-ss-act="copy-invite"]')).toBeNull();
    expect($<HTMLElement>('#ss-fab')!.hidden).toBe(true);
  });

  it('un lien révoqué par l’administrateur ne compte pas dans les invitations restantes', async () => {
    const inv = { id: 'i1', code: 'Kq3abcd', state: 'free' };
    const data = {
      quota: 4,
      invites: [inv, { id: 'i2', code: 'x', state: 'free', revokedAt: '2026-10-19T08:00:00.000Z' }, { id: 'i3', code: 'z', state: 'revoked' }],
    };
    vi.mocked(invites.refreshInvites).mockResolvedValue(data as never);
    vi.mocked(invites.usableInvite).mockReturnValue(inv as never);
    sb.openSidebar();
    await tick();
    expect($('#ss-inv-slot')!.textContent).toContain('1 invitation restante');
    expect($('#ss-fab-t')!.textContent).toBe('Inviter · 1');
  });
});

describe('barre, clavier et adresse', () => {
  it('la barre du bas : « Amis » ouvre la page, un autre onglet la ferme', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="fake-app"><nav class="tabbar"><a href="#/" class="tab" id="t-home">Accueil</a><a href="#/friends" class="tab" id="t-friends" data-soc-open>Amis</a></nav></div>');
    document.getElementById('app')!.hidden = false;
    document.getElementById('app')!.innerHTML = document.getElementById('fake-app')!.innerHTML;
    document.getElementById('fake-app')!.remove();
    clickEl('#t-friends');
    expect(sb.isSidebarOpen()).toBe(true);
    expect(root().classList.contains('ss-tabbed')).toBe(true);
    clickEl('#t-home');
    expect(sb.isSidebarOpen()).toBe(false);
    document.getElementById('app')!.innerHTML = '';
  });

  it('flèches haut/bas passent d’une action à l’autre ; le bouton + affiche le champ sur mobile', () => {
    setSocial({ friends: [friend('f1', 'Anna'), friend('f2', 'Bob')] });
    sb.openSidebar();
    const first = $<HTMLElement>('[data-ss-act="open"][data-pid="f1"]')!;
    first.focus();
    pressKey(first, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.pid).toBe('f2');
    clickEl('[data-ss-act="toggle-add"]');
    expect($('#ss-add')!.classList.contains('is-open')).toBe(true);
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

describe('textes et formats', () => {
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
