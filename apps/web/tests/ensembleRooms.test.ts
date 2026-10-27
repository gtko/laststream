// Page Ensemble (LAST-197) : salons en direct chez les amis, salons publics, demande d'entrée et colonne latérale.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
interface Call { method: string; path: string }
const calls: Call[] = [];
let routes: (c: Call) => Response | Promise<Response> | undefined = () => undefined;
const detail = () => document.getElementById('detail')!;
const $ = <T extends Element = HTMLElement>(sel: string) => detail().querySelector(sel) as T;
const $$ = (sel: string) => Array.from(detail().querySelectorAll<HTMLElement>(sel));

let showEnsemble: (tab?: string) => void;
let getState: () => any;
let registerSocialHook: (name: string, fn: (...a: any[]) => void) => void;

const room = (o: Record<string, unknown>) => ({ id: 'r', title: 'T', poster: null, language: 'fr', mediaType: 'movie', host: 'zed', participants: 2, maxParticipants: 8, createdAt: new Date().toISOString(), ...o });
const friend = (pid: string, name: string, o: Record<string, unknown> = {}) => ({
  pid, handle: { name, tag: '1234', full: name + '#1234' }, avatarColor: '#3b3750', status: 'online', household: false, favorite: false, muted: false, ...o,
});
const watching = (o: Record<string, unknown> = {}) => ({ type: 'series', tmdbId: 1, title: 'Severance', season: 2, episode: 4, paused: true, pos: 4000, duration: 3000 * 2, ...o });

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  const { auth } = await import('../src/data/auth');
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', isKid: false } as any;
  ({ showEnsemble } = await import('../src/ui/ensemble.js'));
  ({ getState } = await import('../src/data/socialStore'));
  ({ registerSocialHook } = await import('../src/ui/socialHooks.js'));
});

beforeEach(() => {
  calls.length = 0;
  routes = () => undefined;
  const st = getState();
  st.friends = [];
  st.household = [];
  st.activity = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search };
    calls.push(c);
    return (await routes(c)) ?? json({ error: 'not_found' }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = async (tab: string, rooms: unknown[], friends: unknown[] = []) => {
  getState().friends = friends;
  routes = (c) => (c.path.startsWith('/party?') ? json({ rooms, nextCursor: null }) : undefined);
  detail().innerHTML = '';
  showEnsemble(tab);
  await tick(60);
};

describe('Maintenant : en direct chez tes amis', () => {
  it('salon d’un ami : carte en direct avec position, participants et lien Rejoindre', async () => {
    const f = friend('F1', 'Zoé', { watching: watching() });
    await open('maintenant', [room({ id: 'a', title: 'Chez Zoe', host: 'zoe', participants: 3 }), room({ id: 'b', title: 'Public', host: 'bob' })], [f]);
    const card = $('.wp-friends [data-room="a"]');
    expect(card.textContent).toContain('Ton ami est dedans');
    expect(card.querySelector('.wp-live')!.textContent).toContain('En direct');
    expect(card.querySelector('.wp-live')!.textContent).toMatch(/\d+:\d{2}/);
    expect(card.textContent).toContain('S02E04');
    expect(card.textContent).toContain('3/8 participants');
    expect(card.querySelector('a.wp-join')!.getAttribute('href')).toBe('#/party/a');
    expect(card.querySelector('a.wp-join')!.textContent).toBe('Rejoindre');
    expect($$('.wp-friends [data-room="b"]')).toHaveLength(0);
    expect($$('[data-room="b"]')).toHaveLength(1);
  });

  it('ami qui regarde sans salon public : « Demander à entrer » envoie la demande à l’ami', async () => {
    const f = friend('F2', 'Sam', { watching: watching({ title: 'Shōgun' }) });
    routes = (c) => (c.path.endsWith('/friends/F2/join-request') ? new Response(null, { status: 204 }) : c.path.startsWith('/party?') ? json({ rooms: [], nextCursor: null }) : undefined);
    getState().friends = [f];
    detail().innerHTML = '';
    showEnsemble('maintenant');
    await tick(60);
    const btn = $<HTMLButtonElement>('[data-ens-knock="F2"]');
    expect(btn.textContent).toBe('Demander à entrer');
    expect($('.wp-card-private').textContent).toContain('Shōgun');
    expect($('.wp-empty-box')).toBeNull();
    btn.click();
    await tick(40);
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/friends/F2/join-request'))).toBe(true);
    expect($<HTMLButtonElement>('[data-ens-knock="F2"]').disabled).toBe(true);
    expect($('[data-ens-knock="F2"]').textContent).toBe('Demande envoyée');
  });

  it('demande refusée (403) : message honnête, le bouton revient', async () => {
    const f = friend('F2', 'Sam', { watching: watching() });
    routes = (c) => (c.path.endsWith('/friends/F2/join-request') ? json({ error: 'forbidden' }, 403) : c.path.startsWith('/party?') ? json({ rooms: [], nextCursor: null }) : undefined);
    getState().friends = [f];
    detail().innerHTML = '';
    showEnsemble('maintenant');
    await tick(60);
    $<HTMLButtonElement>('[data-ens-knock="F2"]').click();
    await tick(40);
    const btn = $<HTMLButtonElement>('[data-ens-knock="F2"]');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Demander à entrer');
    expect(document.getElementById('toast')!.textContent).toContain('n’accepte pas les demandes d’entrée');
  });

  it('ami hors ligne ou en sourdine : aucune carte ; pas d’ami : état vide', async () => {
    await open('maintenant', [], [friend('F3', 'Off', { status: 'offline', watching: watching() }), friend('F4', 'Mute', { muted: true, watching: watching() })]);
    expect($$('.wp-friends')).toHaveLength(0);
    expect($('.wp-empty-box').textContent).toContain('Aucun salon ouvert pour le moment');
  });

  it('échappe titre, hôte et nom d’ami', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await open('maintenant', [room({ id: 'a', title: evil, host: evil })], [friend('F5', 'Mallory', { watching: watching({ title: evil }) })]);
    expect(detail().querySelector('img[src="x"]')).toBeNull();
    expect(detail().innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('Salons publics', () => {
  it('liste tous les salons publics avec Entrer ; Complet est désactivé ; pas de bloc amis', async () => {
    await open('salons-publics', [room({ id: 'a', title: 'Ouvert', host: 'zoe' }), room({ id: 'f', title: 'Plein', participants: 8, maxParticipants: 8 })], [friend('F1', 'Zoé', { watching: watching() })]);
    expect($('.ens-tabs a[aria-current="page"]').textContent).toBe('Salons publics');
    expect($$('.wp-friends')).toHaveLength(0);
    expect($$('[data-ens-knock]')).toHaveLength(0);
    expect($('[data-room="a"] a.wp-join').textContent).toBe('Entrer');
    expect($('[data-room="a"] a.wp-join').getAttribute('href')).toBe('#/party/a');
    const full = $<HTMLButtonElement>('[data-room="f"] .wp-join');
    expect(full.disabled).toBe(true);
    expect(full.textContent).toBe('Complet');
  });

  it('réponse périmée (autre montage entre-temps) : ignorée', async () => {
    let release: (r: Response) => void = () => undefined;
    const slow = new Promise<Response>((r) => { release = r; });
    let n = 0;
    routes = (c) => {
      if (!c.path.startsWith('/party?')) return undefined;
      n += 1;
      return n === 1 ? slow : json({ rooms: [room({ id: 'new', title: 'Nouveau' })], nextCursor: null });
    };
    detail().innerHTML = '';
    showEnsemble('salons-publics');
    showEnsemble('maintenant');
    await tick(40);
    expect(detail().textContent).toContain('Nouveau');
    release(json({ rooms: [room({ id: 'old', title: 'Ancien' })], nextCursor: null }));
    await tick(40);
    expect(detail().textContent).not.toContain('Ancien');
    expect(detail().textContent).toContain('Nouveau');
  });
});

describe('colonne latérale', () => {
  const side = (inv: unknown = { quota: 3, invites: [] }, act: unknown = { items: [] }) => {
    routes = (c) => (c.path.startsWith('/party?') ? json({ rooms: [], nextCursor: null })
      : c.path.endsWith('/invites') ? json(inv) : c.path.includes('/activity') ? json(act) : undefined);
  };
  const mount = async () => { detail().innerHTML = ''; showEnsemble('ce-soir'); await tick(60); };

  it('amis en ligne seulement, avec Inviter branché sur le flux d’invitation de salon', async () => {
    side();
    getState().friends = [friend('F1', 'Léa', { watching: watching({ title: 'Arrival' }) }), friend('F2', 'Tom', { status: 'away' }), friend('F3', 'Ines', { status: 'offline' })];
    const invited: string[] = [];
    registerSocialHook('inviteToParty', (pid) => { invited.push(pid); });
    await mount();
    const rows = $$('.ens-frow');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Léa');
    expect(rows[0].textContent).toContain('regarde Arrival');
    $<HTMLButtonElement>('[data-ens-invite="F1"]').click();
    expect(invited).toEqual(['F1']);
    expect($('.ens-all').textContent).toContain('3 amis');
  });

  it('aucun ami : message, pas de bouton Inviter', async () => {
    side();
    await mount();
    expect($$('[data-ens-invite]')).toHaveLength(0);
    expect($('.ens-side').textContent).toContain('Aucun ami pour l’instant');
  });

  it('échappe les pseudos et titres', async () => {
    side();
    getState().friends = [friend('F1', '<b>x</b>')];
    await mount();
    expect($('.ens-side b')).not.toBeNull();
    expect($('.ens-side').innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('activité récente depuis le fil des amis', async () => {
    side(undefined, { items: [{ id: 'a1', pid: 'F1', handle: { name: 'Inès', tag: '1', full: 'Inès#1' }, avatarColor: '#fff', kind: 'finished', media: { type: 'movie', title: 'Dune 2' }, at: Date.now() - 12 * 60000 }] });
    await mount();
    expect($('.ens-act-list').textContent).toContain('Inès a terminé Dune 2');
    expect($('.ens-act-list').textContent).toContain('12 min');
  });

  it('billets restants : compte les billets libres ; rien s’il n’y en a pas ou si la route échoue', async () => {
    const inv = (state: string, id: string, extra = {}) => ({ id, code: 'c' + id, state, createdAt: '2026-01-01', sentAt: null, usedAt: null, revokedAt: null, message: null, picks: [], expiresAt: null, number: 1000, invitee: null, ...extra });
    side({ quota: 5, invites: [inv('free', '1'), inv('free', '2'), inv('free', '3', { revokedAt: '2026-02-01' }), inv('used', '4')] });
    await mount();
    expect($('.ens-tkt h2').textContent).toBe('Il te reste 2 billets');
    expect($('.ens-tkt a').getAttribute('href')).toBe('#/settings');
    side({ quota: 1, invites: [inv('used', '1')] });
    await mount();
    expect($$('.ens-tkt')).toHaveLength(0);
    routes = (c) => (c.path.startsWith('/party?') ? json({ rooms: [], nextCursor: null }) : undefined);
    await mount();
    expect($$('.ens-tkt')).toHaveLength(0);
  });
});
