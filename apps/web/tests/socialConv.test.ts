// Discussions Social v3 (F3) : modèle pur, liste des conversations, fenêtre ancrée (ouvrir / réduire / fermer), messages riches.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const subs = new Set<(s: any) => void>();
  const st: any = {};
  return { st, subs, fire: () => subs.forEach((f) => f(st)) };
});

vi.mock('../src/data/socialStore', () => ({
  MESSAGE_MAX: 1000,
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => { h.subs.add(fn); return () => { h.subs.delete(fn); }; },
  refresh: vi.fn(() => Promise.resolve()),
  loadThread: vi.fn(() => Promise.resolve(h.st.threads['dm:p1'] || [])),
  loadMessages: vi.fn(() => Promise.resolve([])),
  sendToConv: vi.fn(() => Promise.resolve({})),
  markConvRead: vi.fn(() => Promise.resolve()),
  react: vi.fn(() => Promise.resolve([])),
  vote: vi.fn(() => Promise.resolve({})),
  notifyTyping: vi.fn(),
  typingPids: (s: any, conv: string) => Object.keys((s.typing || {})[conv] || {}),
  createGroup: vi.fn(() => Promise.resolve({ conv: 'g:9' })),
  leaveGroup: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/ui/socialButton.js', () => ({ socialAvailable: () => true }));
vi.mock('../src/data/auth', () => ({ auth: { profile: { id: 'prof1' } } }));
vi.mock('../src/data/userStore', () => ({ userStore: { inLibrary: vi.fn(() => false), toggleLibrary: vi.fn(() => true) } }));

import * as store from '../src/data/socialStore';
import * as M from '../src/ui/socialConvModel.js';
import { openConversation, resetSocialConv } from '../src/ui/socialConv.js';
import { renderConversationList } from '../src/ui/socialConvList.js';
import { userStore } from '../src/data/userStore';

const flush = () => new Promise((r) => setTimeout(r, 0));
const fr = (pid: string, name: string, extra: any = {}) =>
  ({ pid, handle: { name, tag: 'AB23', full: name + '#AB23' }, avatarColor: '#7b5cff', household: false, status: 'online', ...extra });
const msg = (id: string, from: string, body: string, createdAt: number, extra: any = {}) =>
  ({ id, from, to: from === 'me' ? 'p1' : 'me', body, createdAt, conv: 'dm:p1', kind: 'text', reactions: [], ...extra });

function setStore(threads: any[], extra: any = {}) {
  Object.assign(h.st, {
    me: { pid: 'me', handle: { name: 'Moi', tag: 'ZZ22', full: 'Moi#ZZ22' }, avatarColor: '#ff5a36' },
    friends: [fr('p1', 'Léa', { watching: { type: 'movie', tmdbId: 5, title: 'Dune', pos: 100, paused: true, at: 1 } }), fr('p2', 'Hugo')],
    household: [fr('p3', 'Sam', { household: true })],
    conversations: [
      { pid: 'p1', handle: fr('p1', 'Léa').handle, avatarColor: '#7b5cff', unread: 2, last: threads[threads.length - 1] },
      { pid: 'p3', handle: fr('p3', 'Sam').handle, avatarColor: '#5b6b7f', unread: 0, last: msg('z', 'p3', 'Tu as fini ?', Date.now() - 3 * 86_400_000) },
    ],
    groups: [{
      conv: 'g:1', pid: '', unread: 0, handle: { name: '', tag: '', full: '' }, avatarColor: '#000',
      group: { id: '1', name: 'Ciné du dimanche', members: [fr('p1', 'Léa'), fr('p2', 'Hugo')] },
      last: {
        id: 'gp', from: 'p2', kind: 'poll', body: '', createdAt: Date.now(), conv: 'g:1', reactions: [],
        poll: { id: 'pl', question: 'film de dimanche', closed: false, options: [{ id: 'a', label: 'Oppenheimer', votes: 4, mine: false }, { id: 'b', label: 'Anatomie', votes: 2, mine: false }] },
      },
    }],
    threads: { 'dm:p1': threads }, messages: {}, typing: {}, ...extra,
  });
  h.fire();
}

beforeEach(() => {
  resetSocialConv();
  document.body.innerHTML = '';
  h.subs.clear();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('modèle', () => {
  it('normalise les identifiants de conversation', () => {
    expect(M.normalizeConv('p1')).toBe('dm:p1');
    expect(M.normalizeConv('g:4')).toBe('g:4');
    expect(M.normalizeConv('')).toBe('');
  });
  it('heures et jours', () => {
    const now = new Date(2026, 5, 10, 22, 0).getTime();
    expect(M.listTime(new Date(2026, 5, 10, 21, 44).getTime(), now)).toBe('21:44');
    expect(M.listTime(new Date(2026, 5, 9, 9, 0).getTime(), now)).toBe('hier');
    expect(M.dayLabel(new Date(2026, 5, 10, 21, 42).getTime(), now)).toBe('Aujourd’hui · 21:42');
    expect(M.dayLabel(new Date(2026, 5, 9, 9, 0).getTime(), now)).toBe('Hier');
  });
  it('phrases de saisie et parts de sondage', () => {
    expect(M.typingText(['Léa'])).toBe('Léa écrit…');
    expect(M.typingText(['Léa', 'Hugo'])).toBe('Léa et Hugo écrivent…');
    const poll = { options: [{ votes: 4 }, { votes: 2 }] };
    expect(M.pollShare(poll, poll.options[0])).toBe(67);
    expect(M.pollTotal(poll)).toBe(6);
  });
  it('état sauvegardé tolérant', () => {
    localStorage.setItem('laststream.social.convwin.x', '{oups');
    expect(M.loadWinState('x')).toEqual({ active: null, min: [] });
    M.saveWinState('x', { active: 'dm:a', min: ['g:1', 'dm:a'] });
    expect(M.loadWinState('x')).toEqual({ active: 'dm:a', min: ['g:1'] });
  });
});

describe('liste des conversations', () => {
  it('affiche DM, groupe, sondage ouvert, non-lus et recherche', () => {
    setStore([msg('1', 'p1', 'Salut', Date.now())]);
    const el = document.createElement('div');
    document.body.append(el);
    const off = renderConversationList(el);
    expect(el.querySelectorAll('.cvl-row').length).toBe(3);
    expect(el.textContent).toContain('Sam');
    expect(el.textContent).toContain('· foyer');
    expect(el.querySelector('.cvl-poll')?.textContent).toContain('Oppenheimer');
    expect(el.querySelectorAll('.cvl-dot').length).toBe(1);
    const search = el.querySelector<HTMLInputElement>('.cvl-search')!;
    search.value = 'hug';
    search.dispatchEvent(new Event('input'));
    expect(el.textContent).toContain('Nouvelle discussion');
    off();
    expect(h.subs.size).toBe(0);
    expect(el.textContent).toBe('');
  });
});

describe('fenêtre ancrée', () => {
  it('ouvre, affiche les messages riches, réduit en onglet, ferme', async () => {
    const now = Date.now();
    setStore([
      msg('1', 'p1', '<b>salut</b>', now - 1000),
      msg('2', 'p1', '', now - 900, { kind: 'title', title: { type: 'movie', tmdbId: 7, title: 'Past Lives', year: 2023, rating: 5 } }),
      msg('3', 'p1', 'CETTE scène', now - 800, { kind: 'moment', moment: { type: 'movie', tmdbId: 8, title: 'Dune', pos: 4354 }, reactions: [{ emoji: '🔥', count: 2, mine: true }] }),
      msg('4', 'me', 'ok', now - 700, { readAt: now - 600 }),
    ]);
    openConversation('dm:p1');
    await flush();
    const panel = document.querySelector('.cvw-panel')!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector('.cvw-name')?.textContent).toContain('Léa');
    expect(panel.querySelector('.cvm-bub')?.innerHTML).toBe('&lt;b&gt;salut&lt;/b&gt;');
    expect(panel.textContent).toContain('Léa te recommande');
    expect(panel.textContent).toContain('1:12:34');
    expect(panel.querySelector('.cvm-rx')?.textContent).toBe('🔥 2');
    expect(panel.textContent).toContain('Vu ·');
    expect(panel.textContent).toContain('Regarder avec Léa');
    expect(store.markConvRead).toHaveBeenCalledWith('dm:p1');

    (panel.querySelector('.cvm-card-btns .cvm-btn:not(.is-accent)') as HTMLButtonElement).click();
    expect(userStore.toggleLibrary).toHaveBeenCalled();

    const input = panel.querySelector<HTMLInputElement>('.cvw-input')!;
    input.value = 'Je lance';
    input.dispatchEvent(new Event('input'));
    panel.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(store.sendToConv).toHaveBeenCalledWith('dm:p1', { kind: 'text', body: 'Je lance' });
    expect(store.notifyTyping).toHaveBeenCalledWith('dm:p1');

    (panel.querySelector('[aria-label="Réduire"]') as HTMLButtonElement).click();
    expect(document.querySelector('.cvw-panel')).toBeNull();
    expect(document.querySelector('.cvw-tab')?.textContent).toContain('Léa');
    expect(document.querySelector('.cvw-badge')?.textContent).toBe('2');
    expect(JSON.parse(localStorage.getItem('laststream.social.convwin.prof1')!)).toEqual({ active: null, min: ['dm:p1'] });

    (document.querySelector('.cvw-tab-main') as HTMLButtonElement).click();
    const p2 = document.querySelector('.cvw-panel')!;
    p2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.cvw-root')).toBeNull();
    expect(h.subs.size).toBe(0);
  });

  it('affiche « écrit… » et un sondage votable', async () => {
    const now = Date.now();
    setStore([msg('9', 'p1', '', now, { kind: 'poll', poll: { id: 'pl', question: 'Quel film ?', closed: false, options: [{ id: 'a', label: 'Dune', votes: 3, mine: false }, { id: 'b', label: 'Heat', votes: 1, mine: true }] } })], { typing: { 'dm:p1': { p1: now + 5000 } } });
    openConversation('dm:p1');
    await flush();
    expect(document.body.textContent).toContain('Léa écrit…');
    (document.querySelector('.cvm-opt') as HTMLButtonElement).click();
    expect(store.vote).toHaveBeenCalledWith('dm:p1', 'pl', 'a');
  });
});
