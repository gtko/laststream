// Store du Social v3 : réduction pure (saisie, réactions, sondages, groupes, activité, mode cinéma), actions REST simulées,
// routage des événements temps réel vers le store, mode cinéma avec minuteurs faux, protection contre les réponses périmées.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import {
  block, cinemaMissedQuery, CINEMA_ELEMENTS, convOf, createGroup, createList, DEFAULT_CINEMA_HIDDEN, endCinema, getState, initialSocialState,
  leaveGroup, loadActivity, loadLists, loadProfile, loadThread, markConvRead, mergeActivity, notifyTyping, onJoinAnswer, onPartyInvite,
  pruneTyping, react, reduceLiveEvent, refresh, rerollTag, saveProfile, savePrefs, saveRelation, sendToConv, setCinemaHidden, setTyping,
  share, start, startCinema, stop, subscribe, toV3, typingPids, unblock, updateGroup, vote, answerJoin, addToList, loadList, type SocialState,
} from '../src/data/socialStore';
import type { ActivityItem, ConversationV3, FriendV3, MessageV3, Poll } from '../src/data/socialV3Api';
import type { FriendView, Handle, Message, SocialMe } from '../src/data/socialV2Api';

const H = (name: string, tag: string): Handle => ({ name, tag, full: `${name}#${tag}` });
const ME: SocialMe = { pid: 'me', handle: H('Greg', 'A7K2'), status: 'online', avatarColor: '#111' };
const friend = (pid: string, over: Partial<FriendV3> = {}): FriendV3 => ({
  pid, handle: H(pid, 'B2C3'), avatarColor: '#a00', household: false, status: 'online', ...over,
});
const request = (pid: string) => ({ pid, handle: H(pid, 'D4E5'), avatarColor: '#0a0', createdAt: 1 });
const msg = (id: string, from: string, to: string, createdAt: number, extra: Partial<MessageV3> = {}): Message =>
  ({ id, from, to, body: 'texte ' + id, createdAt, ...extra }) as Message;
const groupMsg = (id: string, from: string, createdAt: number): Message =>
  msg(id, from, 'g:G1', createdAt, { conv: 'g:G1', kind: 'text', reactions: [] } as Partial<MessageV3>);
const group = (unread = 0): ConversationV3 => ({
  pid: 'g:G1', conv: 'g:G1', handle: H('Soirée', '0000'), avatarColor: '#0a0', unread,
  group: { id: 'G1', name: 'Soirée', members: [] },
});
const poll = (id: string): Poll => ({ id, question: 'Ce soir ?', options: [{ id: 'o1', label: 'Film', votes: 1, mine: false }, { id: 'o2', label: 'Série', votes: 0, mine: false }], closed: false });
const act = (id: string, at: number): ActivityItem => ({
  id, pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', kind: 'started', media: { type: 'movie', tmdbId: 603, title: 'Matrix' }, at,
});
const withMe = (over: Partial<SocialState> = {}): SocialState => ({ ...initialSocialState(), me: ME, ...over });

// ---------- Réduction pure ----------
describe('reduceLiveEvent (v3)', () => {
  it('saisie : enregistrée 5 s, sans effet pour moi-même', () => {
    const s = withMe();
    const r = reduceLiveEvent(s, { t: 'typing', conv: 'dm:p1', pid: 'p1' }, 1_000);
    expect(typingPids(r, 'dm:p1', 1_000)).toEqual(['p1']);
    expect(typingPids(r, 'dm:p1', 5_999)).toEqual(['p1']);
    expect(typingPids(r, 'dm:p1', 6_000)).toEqual([]);
    expect(reduceLiveEvent(s, { t: 'typing', conv: 'dm:me', pid: 'me' }, 1_000)).toBe(s);
  });

  it('pruneTyping retire les saisies échues et les conversations vides', () => {
    const t = setTyping(setTyping({}, 'g:G1', 'p1', 100), 'g:G1', 'p2', 900);
    expect(pruneTyping(t, 500)).toEqual({ 'g:G1': { p2: 900 } });
    expect(pruneTyping(t, 1_000)).toEqual({});
  });

  it('réaction : remplace les réactions du message chargé, rien si la conversation n’est pas chargée', () => {
    const m = toV3(msg('m1', 'p1', 'me', 100), 'me');
    const s = withMe({ threads: { 'dm:p1': [m] } });
    const r = reduceLiveEvent(s, { t: 'reaction', conv: 'dm:p1', id: 'm1', reactions: [{ emoji: '😂', count: 3, mine: false }] });
    expect(r.threads['dm:p1'][0].reactions).toEqual([{ emoji: '😂', count: 3, mine: false }]);
    expect(reduceLiveEvent(s, { t: 'reaction', conv: 'g:G9', id: 'm1', reactions: [] }).threads).toEqual({ 'dm:p1': [m] });
  });

  it('sondage : remplace le sondage du message concerné', () => {
    const pm = toV3({ ...msg('pm', 'p1', 'g:G1', 50), conv: 'g:G1', kind: 'poll', reactions: [], poll: poll('P1') } as Message, 'me');
    const s = withMe({ threads: { 'g:G1': [pm] } });
    const updated: Poll = { ...poll('P1'), options: [{ id: 'o1', label: 'Film', votes: 2, mine: true }, { id: 'o2', label: 'Série', votes: 0, mine: false }] };
    const r = reduceLiveEvent(s, { t: 'poll', conv: 'g:G1', poll: updated });
    expect(r.threads['g:G1'][0].poll?.options[0]).toMatchObject({ votes: 2, mine: true });
  });

  it('demande de rejoindre : entrante, sans doublon', () => {
    const f: FriendView = friend('p2');
    const once = reduceLiveEvent(withMe(), { t: 'join_request', from: f });
    expect(once.joinRequests.map((x) => x.pid)).toEqual(['p2']);
    expect(reduceLiveEvent(once, { t: 'join_request', from: f }).joinRequests).toHaveLength(1);
  });

  it('activité : fusion par id, la plus récente d’abord', () => {
    const s = withMe({ activity: [act('a1', 100), act('a2', 300)] });
    const r = reduceLiveEvent(s, { t: 'activity', item: act('a3', 200) });
    expect(r.activity.map((x) => x.id)).toEqual(['a2', 'a3', 'a1']);
    expect(reduceLiveEvent(r, { t: 'activity', item: act('a2', 300) }).activity).toHaveLength(3);
    expect(mergeActivity([act('x', 1)], [act('x', 1), act('y', 2)]).map((x) => x.id)).toEqual(['y', 'x']);
  });

  it('message de groupe : non-lu du groupe (pas des conversations directes), dans le total', () => {
    const s = withMe({ groups: [group(1)] });
    const r = reduceLiveEvent(s, { t: 'message', message: groupMsg('gm1', 'p1', 500) }, 600);
    expect(r.groups[0]).toMatchObject({ unread: 2, last: { id: 'gm1' } });
    expect(r.conversations).toEqual([]);
    expect(r.unread).toBe(2);
    expect(r.badge).toBe(2);
    const own = reduceLiveEvent(r, { t: 'message', message: groupMsg('gm2', 'me', 700) }, 800);
    expect(own.groups[0].unread).toBe(2);
  });

  it('convOf : conv du serveur, sinon dm:<correspondant>', () => {
    expect(convOf(msg('a', 'p1', 'me', 1), 'me')).toBe('dm:p1');
    expect(convOf(msg('b', 'me', 'p2', 1), 'me')).toBe('dm:p2');
    expect(convOf(groupMsg('c', 'p1', 1), 'me')).toBe('g:G1');
  });

  it('mode cinéma : un message reçu pendant le mode est mis en file ; pas un message envoyé, ni un doublon', () => {
    const on = withMe({
      friends: [friend('p1')],
      cinema: { active: true, until: 'film', since: 10, hidden: [...DEFAULT_CINEMA_HIDDEN], queue: [], count: 0 },
    });
    const once = reduceLiveEvent(on, { t: 'message', message: msg('q1', 'p1', 'me', 100) }, 200);
    expect(once.cinema.queue.map((m) => m.id)).toEqual(['q1']);
    expect(once.cinema.count).toBe(1);
    expect(once.unread).toBe(1);
    const dup = reduceLiveEvent(once, { t: 'message', message: msg('q1', 'p1', 'me', 100) }, 210);
    expect(dup.cinema.count).toBe(1);
    const sent = reduceLiveEvent(once, { t: 'message', message: msg('q2', 'me', 'p1', 300) }, 310);
    expect(sent.cinema.count).toBe(1);
  });

  it('hors mode cinéma, ou après son échéance, rien n’est mis en file', () => {
    const timed = withMe({ friends: [friend('p1')], cinema: { active: true, until: 1_000, since: 0, hidden: [], queue: [], count: 0 } });
    expect(reduceLiveEvent(timed, { t: 'message', message: msg('q3', 'p1', 'me', 1) }, 999).cinema.count).toBe(1);
    expect(reduceLiveEvent(timed, { t: 'message', message: msg('q4', 'p1', 'me', 1) }, 1_000).cinema.count).toBe(0);
    const off = withMe({ friends: [friend('p1')] });
    expect(reduceLiveEvent(off, { t: 'message', message: msg('q5', 'p1', 'me', 1) }).cinema.count).toBe(0);
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
      body: {
        conversations: [
          { pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', unread: 2, last: msg('m0', 'p1', 'me', 100) },
          group(1),
        ],
      },
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chargement : conversations directes et groupes séparées', () => {
  it('les groupes sortent de la liste des conversations et comptent dans le non-lu', async () => {
    await startConnected();
    const s = getState();
    expect(s.conversations.map((c) => c.pid)).toEqual(['p1']);
    expect(s.groups.map((g) => g.conv)).toEqual(['g:G1']);
    expect(s.unread).toBe(3);
    expect(s.badge).toBe(4);
  });
});

describe('temps réel routé vers le store', () => {
  it('saisie reçue : affichée, puis retirée après 5 s', async () => {
    const ws = await startConnected();
    vi.useFakeTimers();
    ws.emit({ t: 'typing', conv: 'g:G1', pid: 'p1' });
    expect(typingPids(getState(), 'g:G1')).toEqual(['p1']);
    vi.advanceTimersByTime(4_000);
    expect(typingPids(getState(), 'g:G1')).toEqual(['p1']);
    vi.advanceTimersByTime(1_500);
    expect(getState().typing).toEqual({});
  });

  it('message de groupe : non-lu du groupe, thread chargé mis à jour, pas de conversation directe ajoutée', async () => {
    const ws = await startConnected();
    routes['GET /user/social/conv/g%3AG1/messages'] = () => ({ body: { messages: [groupMsg('gm0', 'p1', 50)] } });
    await loadThread('g:G1');
    ws.emit({ t: 'message', message: groupMsg('gm1', 'p2', 500) });
    const s = getState();
    expect(s.groups[0]).toMatchObject({ unread: 2, last: { id: 'gm1' } });
    expect(s.threads['g:G1'].map((m) => m.id)).toEqual(['gm0', 'gm1']);
    expect(s.conversations.map((c) => c.pid)).toEqual(['p1']);
    expect(s.unread).toBe(4);
  });

  it('réaction, sondage et liste : routés vers la conversation ou la liste chargée', async () => {
    const ws = await startConnected();
    const pm: Message = { ...msg('pm', 'p1', 'g:G1', 50), conv: 'g:G1', kind: 'poll', reactions: [], poll: poll('P1') } as unknown as Message;
    routes['GET /user/social/conv/g%3AG1/messages'] = () => ({ body: { messages: [pm] } });
    await loadThread('g:G1');
    ws.emit({ t: 'reaction', conv: 'g:G1', id: 'pm', reactions: [{ emoji: '👍', count: 1, mine: false }] });
    expect(getState().threads['g:G1'][0].reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    ws.emit({ t: 'poll', conv: 'g:G1', poll: { ...poll('P1'), closed: true } });
    expect(getState().threads['g:G1'][0].poll?.closed).toBe(true);

    routes['GET /user/social/lists/L1'] = () => ({ body: { id: 'L1', name: 'Samedi', members: [], items: [] } });
    routes['GET /user/social/lists'] = () => ({ body: { lists: [{ id: 'L1', name: 'Samedi', members: [], count: 0 }] } });
    await loadList('L1');
    expect(callsTo('GET', '/user/social/lists/L1')).toHaveLength(1);
    ws.emit({ t: 'list', listId: 'L1' });
    await flush();
    expect(callsTo('GET', '/user/social/lists/L1')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/user/social/lists')).toHaveLength(1);
    expect(getState().listDetails.L1.name).toBe('Samedi');
  });

  it('demande de rejoindre : état, puis réponse et écouteurs pour la réponse et l’invitation', async () => {
    const ws = await startConnected();
    const answers: Array<{ pid: string; accept: boolean; partyId?: string }> = [];
    const invites: string[] = [];
    const offA = onJoinAnswer((ev) => answers.push(ev));
    const offI = onPartyInvite((ev) => invites.push(ev.partyId));
    ws.emit({ t: 'join_request', from: friend('p2') });
    expect(getState().joinRequests.map((f) => f.pid)).toEqual(['p2']);
    routes['POST /user/social/join-requests/p2'] = () => ({ status: 204 });
    await answerJoin('p2', { accept: true, partyId: 'pty1' });
    expect(getState().joinRequests).toEqual([]);
    expect(callsTo('POST', '/user/social/join-requests/p2')[0].body).toEqual({ accept: true, partyId: 'pty1' });
    ws.emit({ t: 'join_answer', pid: 'me', accept: false });
    ws.emit({ t: 'party_invite', from: friend('p1'), partyId: 'pty2', title: 'Dune' });
    expect(answers).toEqual([{ pid: 'me', accept: false, partyId: undefined }]);
    expect(invites).toEqual(['pty2']);
    offA();
    offI();
  });

  it('activité reçue : entrée en tête de liste', async () => {
    const ws = await startConnected();
    ws.emit({ t: 'activity', item: act('a1', 100) });
    ws.emit({ t: 'activity', item: act('a2', 200) });
    expect(getState().activity.map((x) => x.id)).toEqual(['a2', 'a1']);
  });
});

describe('profil, préférences, relations, blocages', () => {
  it('profil : chargé, modifié (handle et couleur répercutés sur moi), tag tiré', async () => {
    await startConnected();
    const base = { pid: 'me', handle: H('Greg', 'A7K2'), avatarColor: '#111', favorites: [] };
    routes['GET /user/social/profile'] = () => ({ body: base });
    await loadProfile();
    expect(getState().profile?.pid).toBe('me');

    routes['PUT /user/social/profile'] = (c) => ({ body: { ...base, bio: c.body.bio, avatarColor: '#222' } });
    await saveProfile({ bio: 'Cinéphile', avatarColor: '#222' });
    expect(getState().profile).toMatchObject({ bio: 'Cinéphile', avatarColor: '#222' });
    expect(getState().me?.avatarColor).toBe('#222');

    routes['POST /user/social/profile/tag'] = () => ({ body: { handle: H('Greg', 'ZZ23'), tagChangeableAt: 999 } });
    await rerollTag();
    expect(getState().me?.handle.full).toBe('Greg#ZZ23');
    expect(getState().profile).toMatchObject({ tagChangeableAt: 999 });
  });

  it('préférences : chargées puis enregistrées', async () => {
    await startConnected();
    routes['PUT /user/social/prefs'] = (c) => ({ body: { ...c.body, activityVisibility: 'nobody' } });
    await savePrefs({ activityVisibility: 'nobody' });
    expect(getState().prefs?.activityVisibility).toBe('nobody');
  });

  it('relation : la fiche renvoyée remplace l’ancienne et garde les champs qu’elle ne redonne pas', async () => {
    await startConnected();
    routes['PUT /user/social/friends/p1/relation'] = () => ({ body: { pid: 'p1', handle: H('p1', 'B2C3'), avatarColor: '#a00', household: false, status: 'online', favorite: true } });
    await saveRelation('p1', { favorite: true });
    const f = getState().friends.find((x) => x.pid === 'p1');
    expect(f).toMatchObject({ favorite: true, status: 'online' });
    expect(f?.handle.full).toBe('p1#B2C3');
  });

  it('bloquer retire l’amitié et les demandes ; débloquer retire de la liste', async () => {
    await startConnected();
    routes['POST /user/social/blocks/p1'] = () => ({ status: 204 });
    await block('p1');
    expect(getState().friends).toEqual([]);
    expect(getState().blocked.map((b) => b.pid)).toEqual(['p1']);
    routes['DELETE /user/social/blocks/p1'] = () => ({ status: 204 });
    await unblock('p1');
    expect(getState().blocked).toEqual([]);

    routes['POST /user/social/blocks/p2'] = () => ({ status: 204 });
    await block('p2');
    expect(getState().incoming).toEqual([]);
  });
});

describe('conversations, groupes, messages v3', () => {
  it('créer un groupe l’ajoute à la liste ; quitter le retire avec son fil', async () => {
    await startConnected();
    routes['POST /user/social/groups'] = (c) => ({ status: 201, body: { ...group(0), group: { id: 'G2', name: c.body.name, members: [] }, conv: 'g:G2', pid: 'g:G2' } });
    const g = await createGroup('Ados', ['p1']);
    expect(g.conv).toBe('g:G2');
    expect(getState().groups.map((x) => x.conv)).toEqual(['g:G1', 'g:G2']);

    routes['DELETE /user/social/groups/G2/me'] = () => ({ status: 204 });
    await leaveGroup('G2');
    expect(getState().groups.map((x) => x.conv)).toEqual(['g:G1']);
  });

  it('modifier un groupe relit les conversations', async () => {
    await startConnected();
    routes['PUT /user/social/groups/G1'] = () => ({ status: 204 });
    const before = callsTo('GET', '/user/social/conversations').length;
    await updateGroup('G1', { name: 'Ciné' });
    expect(callsTo('GET', '/user/social/conversations').length).toBe(before + 1);
  });

  it('envoi : texte rogné, refusé s’il est vide ou trop long (sans appel), pas compté comme non-lu', async () => {
    await startConnected();
    const before = calls.length;
    await expect(sendToConv('g:G1', { kind: 'text', body: '   ' })).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(sendToConv('g:G1', { kind: 'text', body: 'a'.repeat(1001) })).rejects.toMatchObject({ code: 'invalid_body' });
    expect(calls).toHaveLength(before);

    routes['POST /user/social/conv/g%3AG1/messages'] = (c) => ({ status: 201, body: { message: { ...groupMsg('gs1', 'me', 900), ...c.body, body: c.body.body } } });
    await sendToConv('g:G1', { kind: 'text', body: '  salut  ' });
    expect(callsTo('POST', '/user/social/conv/g%3AG1/messages')[0].body).toEqual({ kind: 'text', body: 'salut' });
    expect(getState().groups[0].unread).toBe(1);
    expect(getState().threads['g:G1']).toBeUndefined();
  });

  it('marquer lu : compteur du groupe à zéro, total recalculé', async () => {
    await startConnected();
    routes['PUT /user/social/conv/g%3AG1/read'] = () => ({ status: 204 });
    await markConvRead('g:G1');
    expect(getState().groups[0].unread).toBe(0);
    expect(getState().unread).toBe(2);
  });

  it('réagir et voter : la réponse du serveur remplace le message chargé', async () => {
    await startConnected();
    const pm: Message = { ...msg('pm', 'p1', 'g:G1', 50), conv: 'g:G1', kind: 'poll', reactions: [], poll: poll('P1') } as unknown as Message;
    routes['GET /user/social/conv/g%3AG1/messages'] = () => ({ body: { messages: [pm] } });
    await loadThread('g:G1');
    routes['POST /user/social/conv/g%3AG1/messages/pm/reactions'] = () => ({ body: { reactions: [{ emoji: '🔥', count: 1, mine: true }] } });
    await expect(react('g:G1', 'pm', '🔥')).resolves.toEqual([{ emoji: '🔥', count: 1, mine: true }]);
    expect(getState().threads['g:G1'][0].reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }]);

    routes['POST /user/social/conv/g%3AG1/polls/P1/vote'] = () => ({ body: { poll: { ...poll('P1'), options: [{ id: 'o2', label: 'Série', votes: 1, mine: true }] } } });
    await vote('g:G1', 'P1', 'o2');
    expect(getState().threads['g:G1'][0].poll?.options).toEqual([{ id: 'o2', label: 'Série', votes: 1, mine: true }]);
  });

  it('saisie envoyée : au plus un envoi toutes les 3 s par conversation', async () => {
    await startConnected();
    routes['POST /user/social/conv/g%3AG1/typing'] = () => ({ status: 204 });
    notifyTyping('g:G1');
    notifyTyping('g:G1');
    notifyTyping('dm:p1');
    await flush();
    expect(callsTo('POST', '/user/social/conv/g%3AG1/typing')).toHaveLength(1);
    expect(callsTo('POST', '/user/social/conv/dm%3Ap1/typing')).toHaveLength(1);
  });

  it('partage vers plusieurs destinations : messages rangés comme les autres', async () => {
    await startConnected();
    routes['POST /user/social/share'] = () => ({ status: 201, body: { messages: [groupMsg('sh1', 'me', 800)] } });
    const out = await share({ to: [{ group: 'G1' }], kind: 'title', title: { type: 'movie', tmdbId: 603, title: 'Matrix' } });
    expect(out.map((m) => m.id)).toEqual(['sh1']);
    expect(getState().groups[0].last?.id).toBe('sh1');
  });
});

describe('listes et activité', () => {
  it('créer une liste, ajouter un titre (détail relu), charger l’activité', async () => {
    await startConnected();
    routes['POST /user/social/lists'] = (c) => ({ status: 201, body: { id: 'L1', name: c.body.name, members: [], count: 0 } });
    await createList('Samedi', []);
    expect(getState().lists.map((l) => l.id)).toEqual(['L1']);

    routes['POST /user/social/lists/L1/items'] = () => ({ status: 201 });
    routes['GET /user/social/lists/L1'] = () => ({ body: { id: 'L1', name: 'Samedi', members: [], items: [{ type: 'movie', tmdbId: 603, title: 'Matrix', addedBy: 'me', addedAt: 1 }] } });
    routes['GET /user/social/lists'] = () => ({ body: { lists: [{ id: 'L1', name: 'Samedi', members: [], count: 1 }] } });
    await addToList('L1', { type: 'movie', tmdbId: 603, title: 'Matrix' });
    expect(getState().listDetails.L1.items).toHaveLength(1);
    expect(getState().lists[0].count).toBe(1);

    routes['GET /user/social/activity'] = () => ({ body: { items: [act('a2', 200), act('a1', 100)] } });
    await loadActivity({ limit: 30 });
    expect(getState().activity.map((x) => x.id)).toEqual(['a2', 'a1']);
  });
});

describe('mode cinéma', () => {
  it('activé : défauts masqués (bulles, notes, marqueurs), file des messages reçus, compteur, fin avec résumé', async () => {
    const ws = await startConnected();
    startCinema('film');
    const on = getState().cinema;
    expect(on).toMatchObject({ active: true, until: 'film', queue: [], count: 0 });
    expect(on.since).toBeTypeOf('number');
    expect(on.hidden).toEqual(['bubbles', 'notes', 'markers']);

    ws.emit({ t: 'message', message: msg('c1', 'p1', 'me', 1_000) });
    ws.emit({ t: 'message', message: groupMsg('c2', 'p1', 1_100) });
    expect(getState().cinema.count).toBe(2);
    expect(getState().cinema.queue.map((m) => m.conv)).toEqual(['dm:p1', 'g:G1']);
    expect(getState().unread).toBe(5);

    const summary = endCinema();
    expect(summary.queue.map((m) => m.id)).toEqual(['c1', 'c2']);
    expect(summary.since).toBeTypeOf('number');
    expect(getState().cinema).toMatchObject({ active: false, until: null, since: null, queue: [], count: 0 });
    ws.emit({ t: 'message', message: msg('c3', 'p1', 'me', 1_200) });
    expect(getState().cinema.count).toBe(0);
  });

  it('échéance en epoch ms : fin automatique ; une échéance passée ne fait rien', async () => {
    const ws = await startConnected();
    vi.useFakeTimers();
    startCinema(Date.now() + 1_000);
    expect(getState().cinema.active).toBe(true);
    ws.emit({ t: 'message', message: msg('d1', 'p1', 'me', 1) });
    expect(getState().cinema.count).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(getState().cinema).toMatchObject({ active: false, count: 0 });

    startCinema(Date.now() - 1);
    expect(getState().cinema.active).toBe(false);
  });

  it('toujours : sans échéance ; éléments masqués nettoyés et mémorisés', async () => {
    await startConnected();
    startCinema('always', ['notes', 'nope' as never, 'notes']);
    expect(getState().cinema).toMatchObject({ active: true, until: 'always', hidden: ['notes'] });
    setCinemaHidden([...CINEMA_ELEMENTS]);
    expect(getState().cinema.hidden).toEqual([...CINEMA_ELEMENTS]);
    endCinema();
    startCinema('film');
    expect(getState().cinema.hidden).toEqual([...CINEMA_ELEMENTS]);
  });

  it('requête de résumé : part du début du mode', async () => {
    await startConnected();
    expect(cinemaMissedQuery({ type: 'movie', tmdbId: 603 })).toBeNull();
    startCinema('film');
    const since = getState().cinema.since;
    expect(cinemaMissedQuery({ type: 'movie', tmdbId: 603 })).toEqual({ since, type: 'movie', tmdbId: 603 });
  });
});

describe('réponses périmées (arrêt ou changement de profil pendant un appel en vol)', () => {
  it('une mise à jour du profil arrivée après l’arrêt n’écrit pas dans l’état', async () => {
    await startConnected();
    routes['PUT /user/social/profile'] = () => ({ body: { pid: 'me', handle: H('Greg', 'A7K2'), avatarColor: '#111', favorites: [], bio: 'x' } });
    const release = holdReplies();
    const pending = saveProfile({ bio: 'x' });
    stop();
    release();
    await pending;
    await flush();
    expect(getState().profile).toBeNull();
    expect(getState().me).toBeNull();
  });

  it('un message de groupe arrivé après l’arrêt : pas de fil écrit', async () => {
    await startConnected();
    routes['GET /user/social/conv/g%3AG1/messages'] = () => ({ body: { messages: [groupMsg('x1', 'p1', 1)] } });
    const release = holdReplies();
    const pending = loadThread('g:G1');
    stop();
    release();
    expect(await pending).toEqual([]);
    expect(getState().threads).toEqual({});
  });
});

describe('abonnés et démarrage', () => {
  it('chaque changement est notifié ; un abonné défaillant ne bloque pas le store', async () => {
    const seen: number[] = [];
    const off = subscribe(() => { throw new Error('boom'); });
    const off2 = subscribe((s) => seen.push(s.cinema.count));
    startCinema('film');
    expect(seen.length).toBeGreaterThan(0);
    off();
    off2();
  });

  it('refresh garde le partage groupes / conversations (appel direct)', async () => {
    await refresh();
    expect(getState().groups).toHaveLength(1);
    expect(getState().conversations).toHaveLength(1);
  });
});

describe('règles serveur durcies', () => {
  it('« party » n’est plus envoyable par /conv : refus local, aucun appel réseau', async () => {
    await startConnected();
    const before = calls.length;
    await expect(sendToConv('dm:p1', { kind: 'party', party: { partyId: 'x', title: 'Dune' } } as any)).rejects.toMatchObject({ status: 400 });
    expect(calls.length).toBe(before);
  });

  it('frappe refusée (403) : silencieuse, puis plus d’insistance pendant un moment', async () => {
    await startConnected();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1, 12, 0, 0));
    routes['POST /user/social/conv/dm%3Ap1/typing'] = () => ({ status: 403, body: { error: 'not_allowed' } });
    notifyTyping('dm:p1');
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date(2030, 0, 1, 12, 0, 10));
    notifyTyping('dm:p1');
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/user/social/conv/dm%3Ap1/typing')).toHaveLength(1);
  });
});
