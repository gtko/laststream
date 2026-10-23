// Store du Social v2 : réduction des événements temps réel, actions (appels REST simulés), temps réel de bout en bout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import {
  accept, decline, expireIdleWatching, getState, initialSocialState, loadMessages, markRead, mergeMessages, onNote, reduceLiveEvent, refresh, removeFriend,
  sendMessage, sendRequest, setMyAvatar, myAvatar, setStatus, start, stop, subscribe, WATCHING_IDLE_MS, type SocialState,
} from '../src/data/socialStore';
import { setUserStore } from '../src/data/userStore';
import { convInfo } from '../src/ui/socialConvModel.js';
import type { FriendRequest, FriendView, Handle, Message, Note, SocialMe } from '../src/data/socialV2Api';

const H = (name: string, tag: string): Handle => ({ name, tag, full: `${name}#${tag}` });
const ME: SocialMe = { pid: 'me', handle: H('Greg', 'A7K2'), status: 'online', avatarColor: '#111' };
const friend = (pid: string, over: Partial<FriendView> = {}): FriendView => ({
  pid, handle: H(pid, 'B2C3'), avatarColor: '#a00', household: false, favorite: false, muted: false, status: 'online', ...over,
});
const request = (pid: string): FriendRequest => ({ pid, handle: H(pid, 'D4E5'), avatarColor: '#0a0', createdAt: 1 });
const msg = (id: string, from: string, to: string, createdAt: number): Message => ({
  id, from, to, body: 'texte ' + id, createdAt, conv: 'dm:' + (from === 'me' ? to : from), kind: 'text', reactions: [],
});
const note = (id: string): Note => ({ id, author: { pid: 'p1', handle: H('Alice', 'B2C3'), avatarColor: '#a00' }, pos: 12, kind: 'emoji', body: '😀', createdAt: 1 });

const withMe = (): SocialState => ({ ...initialSocialState(), me: ME });

// ---------- Réduction pure des événements temps réel ----------
describe('reduceLiveEvent', () => {
  it('presence met à jour la fiche d’un ami et la range au foyer si besoin', () => {
    const s: SocialState = { ...withMe(), friends: [friend('p1')] };
    const r = reduceLiveEvent(s, { t: 'presence', friend: friend('p1', { status: 'away', watching: undefined }) });
    expect(r.friends.map((f) => [f.pid, f.status])).toEqual([['p1', 'away']]);

    const h = reduceLiveEvent(s, { t: 'presence', friend: friend('p1', { household: true }) });
    expect(h.friends).toEqual([]);
    expect(h.household.map((f) => f.pid)).toEqual(['p1']);
  });

  it('friend accepte une demande : ami ajouté, demandes entrante et sortante retirées', () => {
    const s: SocialState = { ...withMe(), incoming: [request('p2')], outgoing: [request('p2'), request('p3')] };
    const r = reduceLiveEvent(s, { t: 'friend', friend: friend('p2') });
    expect(r.friends.map((f) => f.pid)).toEqual(['p2']);
    expect(r.incoming).toEqual([]);
    expect(r.outgoing.map((x) => x.pid)).toEqual(['p3']);
  });

  it('unfriend retire l’ami des amis et du foyer', () => {
    const s: SocialState = { ...withMe(), friends: [friend('p1')], household: [friend('p2', { household: true })] };
    expect(reduceLiveEvent(s, { t: 'unfriend', pid: 'p1' }).friends).toEqual([]);
    expect(reduceLiveEvent(s, { t: 'unfriend', pid: 'p2' }).household).toEqual([]);
  });

  it('request ajoute une demande entrante, sans doublon, et fait monter le badge', () => {
    const r = reduceLiveEvent(withMe(), { t: 'request', request: request('p2') });
    expect(r.incoming.map((x) => x.pid)).toEqual(['p2']);
    expect(r.badge).toBe(1);
    const twice = reduceLiveEvent(r, { t: 'request', request: request('p2') });
    expect(twice.incoming).toHaveLength(1);
  });

  it('message d’un ami : non-lu +1, dernier message mis à jour, conversation créée si l’ami est connu', () => {
    const s: SocialState = { ...withMe(), friends: [friend('p1')] };
    const r = reduceLiveEvent(s, { t: 'message', message: msg('m1', 'p1', 'me', 500) });
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]).toMatchObject({ conv: 'dm:p1', pid: 'p1', unread: 1, last: { id: 'm1' } });
    expect(r.unread).toBe(1);
    expect(r.badge).toBe(1);
  });

  it('message envoyé par moi depuis un autre appareil : pas de non-lu', () => {
    const s: SocialState = {
      ...withMe(), friends: [friend('p1')], conversations: [{ conv: 'dm:p1', pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', unread: 0 }],
    };
    const r = reduceLiveEvent(s, { t: 'message', message: msg('m2', 'me', 'p1', 600) });
    expect(r.conversations[0]).toMatchObject({ unread: 0, last: { id: 'm2' } });
    expect(r.unread).toBe(0);
  });

  it('un même message reçu deux fois n’ajoute qu’un non-lu quand la conversation est chargée', () => {
    const s: SocialState = {
      ...withMe(), friends: [friend('p1')], messages: { p1: [] },
      conversations: [{ conv: 'dm:p1', pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', unread: 0 }],
    };
    const once = reduceLiveEvent(s, { t: 'message', message: msg('m3', 'p1', 'me', 700) });
    const twice = reduceLiveEvent(once, { t: 'message', message: msg('m3', 'p1', 'me', 700) });
    expect(twice.unread).toBe(1);
    expect(twice.messages.p1.map((m) => m.id)).toEqual(['m3']);
  });

  it('message d’une personne inconnue : conversations inchangées (le store relira la liste)', () => {
    const r = reduceLiveEvent(withMe(), { t: 'message', message: msg('m4', 'p9', 'me', 800) });
    expect(r.conversations).toEqual([]);
    expect(r.unread).toBe(0);
  });

  it('read : mes messages envoyés à ce pid, jusqu’à `at`, sont marqués lus', () => {
    const s: SocialState = {
      ...withMe(),
      messages: { p1: [msg('a', 'me', 'p1', 100), msg('b', 'me', 'p1', 300), msg('c', 'p1', 'me', 120)] },
    };
    const r = reduceLiveEvent(s, { t: 'read', pid: 'p1', at: 200 });
    const byId = Object.fromEntries(r.messages.p1.map((m) => [m.id, m]));
    expect(byId.a.readAt).toBe(200);
    expect(byId.b.readAt).toBeUndefined();
    expect(byId.c.readAt).toBeUndefined();
  });

  it('pong et note ne changent pas l’état', () => {
    const s = withMe();
    expect(reduceLiveEvent(s, { t: 'pong' })).toBe(s);
    expect(reduceLiveEvent(s, { t: 'note', media: { type: 'movie', tmdbId: 603 }, note: note('n1') })).toBe(s);
  });
});

describe('expireIdleWatching', () => {
  const t0 = 1_000_000;
  const watching = (movedAt?: number) => ({ type: 'movie' as const, tmdbId: 1, title: 'Dune', pos: 5, paused: true, at: t0, ...(movedAt === undefined ? {} : { movedAt }) });

  it('retire le titre au-delà de 10 min sans avancer, amis et foyer, sans toucher au reste', () => {
    const s = {
      ...withMe(),
      friends: [friend('a', { watching: watching(t0) }), friend('b', { watching: watching(t0 + 300_000) })],
      household: [friend('c', { watching: watching(t0), household: true })],
    };
    expect(expireIdleWatching(s, t0 + WATCHING_IDLE_MS)).toBe(s);
    const out = expireIdleWatching(s, t0 + WATCHING_IDLE_MS + 1);
    expect(out.friends[0].watching).toBeUndefined();
    expect(out.friends[0].status).toBe('online');
    expect(out.friends[1]).toBe(s.friends[1]);
    expect(out.household[0].watching).toBeUndefined();
  });

  it('un ancien serveur sans movedAt : inchangé', () => {
    const s = { ...withMe(), friends: [friend('a', { watching: watching() })] };
    expect(expireIdleWatching(s, t0 + 10 * WATCHING_IDLE_MS)).toBe(s);
  });
});

describe('mergeMessages', () => {
  it('fusionne par id, chronologique', () => {
    const a = [msg('m2', 'p1', 'me', 200)];
    const b = [msg('m1', 'p1', 'me', 100), msg('m2', 'p1', 'me', 200)];
    expect(mergeMessages(a, b).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

// ---------- Store branché sur des appels REST simulés et un faux canal ----------
interface Call { method: string; path: string; body: any }
interface Reply { status?: number; body?: unknown }
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Reply> = {};

class FakeWS {
  static instances: FakeWS[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(); }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.startsWith(path));

function defaultRoutes(): Record<string, (c: Call) => Reply> {
  return {
    'GET /user/social/me': () => ({ body: ME }),
    'GET /user/social/friends': () => ({ body: { friends: [friend('p1')], household: [], incoming: [request('p2')], outgoing: [] } }),
    'GET /user/social/conversations': () => ({
      body: { conversations: [{ pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', unread: 2, last: msg('m0', 'p1', 'me', 100) }] },
    }),
    'POST /user/social/live-ticket': () => ({ body: { wsPath: '/user/social/live?ticket=T' } }),
  };
}

/** Démarre le store et ouvre le canal : l'état est chargé à l'ouverture. */
async function startConnected(): Promise<FakeWS> {
  start();
  await flush();
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  ws.open();
  await flush();
  return ws;
}

beforeEach(() => {
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg' } as any;
  calls = [];
  routes = defaultRoutes();
  FakeWS.instances = [];
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = routes[`${c.method} ${u.pathname}`]?.(c);
    if (!r) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    if (r.body === undefined) return new Response(null, { status: r.status ?? 204 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

describe('démarrage et temps réel', () => {
  it('charge l’état à l’ouverture du canal ; badge = demandes entrantes + non-lus', async () => {
    await startConnected();
    const s = getState();
    expect(s.me?.pid).toBe('me');
    expect(s.friends.map((f) => f.pid)).toEqual(['p1']);
    expect(s.incoming.map((r) => r.pid)).toEqual(['p2']);
    expect(s.unread).toBe(2);
    expect(s.badge).toBe(3);
    expect(s.live).toBe('open');
    expect(FakeWS.instances[0].url).toBe('ws://localhost:7000/user/social/live?ticket=T');
  });

  it('lecture figée : l’ami quitte « regarde » sans événement après 10 min, et y revient à la reprise', async () => {
    const t0 = Date.parse('2026-05-01T10:00:00Z');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(t0);
      const w = (movedAt: number) => ({ type: 'movie' as const, tmdbId: 1, title: 'Dune', pos: 10, paused: true, at: t0, movedAt });
      routes['GET /user/social/friends'] = () => ({ body: { friends: [friend('p1', { watching: w(t0) })], household: [], incoming: [], outgoing: [] } });
      const ws = await startConnected();
      expect(getState().friends[0].watching?.title).toBe('Dune');
      vi.setSystemTime(t0 + WATCHING_IDLE_MS);
      vi.advanceTimersByTime(30_000);
      expect(getState().friends[0].watching).toBeUndefined();
      expect(getState().friends[0].status).toBe('online');
      ws.emit({ t: 'presence', friend: friend('p1', { watching: w(t0 + WATCHING_IDLE_MS + 40_000) }) });
      expect(getState().friends[0].watching?.title).toBe('Dune');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applique les événements du canal et transmet les notes aux écouteurs', async () => {
    const ws = await startConnected();
    const seen: number[] = [];
    const notes: Note[] = [];
    const offSub = subscribe((s) => seen.push(s.badge));
    const offNote = onNote((media, n) => { if (media.tmdbId === 603) notes.push(n); });

    ws.emit({ t: 'message', message: msg('m5', 'p1', 'me', 500) });
    expect(getState().unread).toBe(3);
    ws.emit({ t: 'request', request: request('p3') });
    expect(getState().incoming.map((r) => r.pid)).toEqual(['p2', 'p3']);
    ws.emit({ t: 'presence', friend: friend('p1', { status: 'dnd' }) });
    expect(getState().friends[0].status).toBe('dnd');
    ws.emit({ t: 'note', media: { type: 'movie', tmdbId: 603 }, note: note('n1') });
    expect(notes.map((n) => n.id)).toEqual(['n1']);
    ws.emit({ t: 'unfriend', pid: 'p1' });
    expect(getState().friends).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);

    offSub();
    offNote();
  });

  it('un message d’une personne inconnue relit les conversations', async () => {
    const ws = await startConnected();
    const before = callsTo('GET', '/user/social/conversations').length;
    ws.emit({ t: 'message', message: msg('m7', 'p9', 'me', 700) });
    await flush();
    expect(callsTo('GET', '/user/social/conversations').length).toBe(before + 1);
  });

  it('pour un profil enfant, start ne fait ni appel ni connexion', async () => {
    auth.profile = { id: 'k1', name: 'Enfant', isKid: true, kidMaxAge: 12 } as any;
    start();
    await flush();
    expect(calls).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it('hors mode serveur, start ne fait rien', async () => {
    auth.status = 'local';
    start();
    await flush();
    expect(calls).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it('stop ferme le canal et vide l’état (pas de fuite entre profils)', async () => {
    const ws = await startConnected();
    stop();
    expect(ws.closed).toBe(true);
    const s = getState();
    expect(s.me).toBeNull();
    expect(s.friends).toEqual([]);
    expect(s.live).toBe('idle');
  });

  it('refresh relit profil, amis et conversations', async () => {
    await refresh();
    expect(getState().me?.handle.full).toBe('Greg#A7K2');
    expect(getState().badge).toBe(3);
  });
});

describe('actions', () => {
  it('sendRequest : demande envoyée, ou ami accepté si l’autre avait déjà demandé', async () => {
    await startConnected();
    routes['POST /user/social/requests'] = () => ({ status: 201, body: { request: request('p3') } });
    const out = await sendRequest('Zoe#2345');
    expect('request' in out).toBe(true);
    expect(callsTo('POST', '/user/social/requests')[0].body).toEqual({ handle: 'Zoe#2345' });
    expect(getState().outgoing.map((r) => r.pid)).toEqual(['p3']);

    routes['POST /user/social/requests'] = () => ({ status: 200, body: { friend: friend('p4') } });
    await sendRequest('Yan#A7K2');
    expect(getState().friends.map((f) => f.pid)).toEqual(['p1', 'p4']);
  });

  it('sendRequest refuse un handle invalide sans appel', async () => {
    await startConnected();
    const before = calls.length;
    await expect(sendRequest('mauvais')).rejects.toMatchObject({ code: 'invalid_handle' });
    expect(calls).toHaveLength(before);
  });

  it('accept ajoute l’ami et retire la demande ; removeFriend le retire', async () => {
    await startConnected();
    routes['POST /user/social/requests/p2/accept'] = () => ({ body: { friend: friend('p2') } });
    const f = await accept('p2');
    expect(f.pid).toBe('p2');
    expect(getState().incoming).toEqual([]);
    expect(getState().friends.map((x) => x.pid)).toEqual(['p1', 'p2']);

    routes['DELETE /user/social/friends/p2'] = () => ({ status: 204 });
    await removeFriend('p2');
    expect(getState().friends.map((x) => x.pid)).toEqual(['p1']);
  });

  it('decline retire la demande reçue', async () => {
    await startConnected();
    routes['DELETE /user/social/requests/p2'] = () => ({ status: 204 });
    await decline('p2');
    expect(getState().incoming).toEqual([]);
    expect(getState().badge).toBe(2);
  });

  it('sendMessage rogne le texte, le range dans la conversation et ne compte pas comme non-lu', async () => {
    await startConnected();
    routes['POST /user/social/messages/p1'] = () => ({ status: 201, body: { message: msg('m9', 'me', 'p1', 600) } });
    const m = await sendMessage('p1', '  bonjour  ');
    expect(m.id).toBe('m9');
    expect(callsTo('POST', '/user/social/messages/p1')[0].body).toEqual({ body: 'bonjour' });
    expect(getState().messages.p1).toBeUndefined();
    expect(getState().conversations[0]).toMatchObject({ pid: 'p1', unread: 2, last: { id: 'm9' } });
  });

  it('sendMessage refuse un texte vide ou de plus de 1000 caractères, sans appel', async () => {
    await startConnected();
    const before = calls.length;
    await expect(sendMessage('p1', '   ')).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(sendMessage('p1', 'a'.repeat(1001))).rejects.toMatchObject({ code: 'invalid_body' });
    expect(calls).toHaveLength(before);
  });

  it('loadMessages fusionne les messages, dans l’ordre chronologique, et transmet la pagination', async () => {
    await startConnected();
    routes['GET /user/social/messages/p1'] = () => ({ body: { messages: [msg('m2', 'me', 'p1', 200), msg('m1', 'p1', 'me', 100)] } });
    const list = await loadMessages('p1');
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(getState().messages.p1.map((m) => m.id)).toEqual(['m1', 'm2']);

    await loadMessages('p1', { before: 100, limit: 10 });
    expect(callsTo('GET', '/user/social/messages/p1').at(-1)?.path).toBe('/user/social/messages/p1?before=100&limit=10');
  });

  it('markRead remet le non-lu à zéro et date les messages reçus lus', async () => {
    await startConnected();
    routes['GET /user/social/messages/p1'] = () => ({ body: { messages: [msg('m1', 'p1', 'me', 100), msg('m2', 'me', 'p1', 110)] } });
    await loadMessages('p1');
    routes['PUT /user/social/messages/p1/read'] = () => ({ status: 204 });
    await markRead('p1');
    const s = getState();
    expect(s.conversations[0].unread).toBe(0);
    expect(s.unread).toBe(0);
    expect(s.badge).toBe(1);
    const byId = Object.fromEntries(s.messages.p1.map((m) => [m.id, m]));
    expect(byId.m1.readAt).toBeTypeOf('number');
    expect(byId.m2.readAt).toBeUndefined();
  });

  it('setStatus envoie le statut et le répercute sur moi', async () => {
    await startConnected();
    routes['PUT /user/social/status'] = (c) => ({ body: { status: c.body.status } });
    await setStatus('invisible');
    expect(getState().status).toBe('invisible');
    expect(getState().me?.status).toBe('invisible');
  });
});

/** Retient toutes les réponses réseau jusqu'à l'appel de `release()`, puis les sert comme les routes simulées. */
function holdReplies(): () => void {
  const serve = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    await gate;
    return serve(url, init);
  }));
  return release;
}

describe('réponses périmées (arrêt ou changement de profil pendant un appel en vol)', () => {
  it('stop pendant un refresh en vol : la réponse arrivée après l’arrêt n’écrit pas dans l’état', async () => {
    const release = holdReplies();
    const pending = refresh();
    stop();
    release();
    await pending;
    await flush();
    const s = getState();
    expect(s.me).toBeNull();
    expect(s.friends).toEqual([]);
    expect(s.conversations).toEqual([]);
    expect(s.badge).toBe(0);
    expect(s.live).toBe('idle');
  });

  it('stop pendant un chargement de messages : rien n’est mis en cache', async () => {
    await startConnected();
    routes['GET /user/social/messages/p1'] = () => ({ body: { messages: [msg('m1', 'p1', 'me', 100)] } });
    const release = holdReplies();
    const pending = loadMessages('p1');
    stop();
    release();
    expect(await pending).toEqual([]);
    expect(getState().messages).toEqual({});
  });
});

// ---------- ODY-169 : un seul avatar pour « moi » (sidebar, chat, écran de profil) ----------
describe('avatar de « moi » : source unique', () => {
  const COL = 'col:pokemon:pikachu';
  const localProfile: { id: string; name: string; avatar: string | null } = { id: 'p1', name: 'Greg', avatar: 'hero:heros:Aegis' };
  beforeEach(() => {
    localProfile.avatar = 'hero:heros:Aegis';
    setUserStore({ currentProfile: () => localProfile } as any);
  });

  it('setMyAvatar publie le nouvel avatar dans me et profile, aligne le profil local et prévient les abonnés', async () => {
    await startConnected();
    expect(myAvatar()).toBe('hero:heros:Aegis');
    const seen: Array<string | undefined> = [];
    const off = subscribe((s) => seen.push(s.me?.avatar));
    setMyAvatar(COL);
    off();
    expect(myAvatar()).toBe(COL);
    expect(getState().me?.avatar).toBe(COL);
    expect(localProfile.avatar).toBe(COL);
    expect(seen).toEqual([COL]);
  });

  it('retirer l’avatar ne ressort pas l’ancien au refresh suivant', async () => {
    await startConnected();
    setMyAvatar(null);
    expect(myAvatar()).toBeNull();
    expect(localProfile.avatar).toBeNull();
    await refresh();
    expect(myAvatar()).toBeNull();
  });

  it('convInfo : dans un groupe, mon avatar vient de me et non de la copie en cache du membre', () => {
    const me = { ...ME, avatar: COL, avatarColor: '#222' };
    const stale = { pid: 'me', handle: ME.handle, avatarColor: '#111', avatar: 'hero:heros:Aegis' };
    const other = { pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00' };
    const s = { ...initialSocialState(), me, groups: [{ conv: 'g:1', unread: 0, group: { id: '1', name: 'G', ownerPid: 'p1', members: [stale, other] } }] } as any;
    const inf = convInfo('g:1', s) as any;
    expect(inf.members[0]).toMatchObject({ pid: 'me', avatar: COL, avatarColor: '#222' });
    expect(inf.members[1]).toBe(other);
  });
});
