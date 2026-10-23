// Client REST du Social v3 : une fonction par route des sections S1 à S5 du contrat (méthode, chemin, requête, corps, en-têtes).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import { saveProfileToken, setSession } from '../src/data/session';
import * as v3 from '../src/data/socialV3Api';
import { DEFAULT_PREFS } from '../src/data/socialV3Api';
import { UserApiError } from '../src/data/userApi';

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Sent { method: string; url: string; headers: Record<string, string>; body: any }
let sent: Sent[] = [];
let reply: (s: Sent) => Response = () => new Response(null, { status: 204 });

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  setSession('sess-token', FUTURE, 'greg');
  saveProfileToken('p1', { token: 'prof-token', expiresAt: FUTURE });
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg' } as any;
});

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const s: Sent = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(s);
    return reply(s);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  reply = () => new Response(null, { status: 204 });
});

/** Dernier appel : méthode, chemin relatif au serveur (query comprise), corps, en-têtes. */
const last = () => {
  const s = sent[sent.length - 1];
  const u = new URL(s.url);
  return { method: s.method, path: u.pathname + u.search, body: s.body, headers: s.headers };
};

describe('S1 — profil', () => {
  it('GET /profile et PUT /profile (corps partiel) avec X-Profile-Id', async () => {
    reply = () => json({ pid: 'p1', handle: { name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' }, avatarColor: '#111', favorites: [] });
    const p = await v3.getProfile();
    expect(p.pid).toBe('p1');
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/profile' });
    expect(last().headers['x-profile-id']).toBe('p1');

    reply = (s) => json({ ...s.body, pid: 'p1' });
    await v3.updateProfile({ bio: null, favorites: [] });
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/profile', body: { bio: null, favorites: [] } });
  });

  it('POST /profile/tag ; 429 tag_cooldown remonté tel quel', async () => {
    reply = () => json({ handle: { name: 'Greg', tag: 'ZZ23', full: 'Greg#ZZ23' } });
    await expect(v3.rerollTag()).resolves.toMatchObject({ handle: { tag: 'ZZ23' } });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/profile/tag' });

    reply = () => json({ error: 'tag_cooldown' }, 429);
    await expect(v3.rerollTag()).rejects.toBeInstanceOf(UserApiError);
    await expect(v3.rerollTag()).rejects.toMatchObject({ status: 429, code: 'tag_cooldown' });
  });

  it('GET /friends/:pid/profile encode le pid', async () => {
    reply = () => json({ pid: 'a/b', handle: { name: 'Al', tag: 'B2C3', full: 'Al#B2C3' }, avatarColor: '#a00', favorites: [] });
    await v3.getFriendProfile('a/b');
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/friends/a%2Fb/profile' });
  });
});

describe('S2 — préférences, relations, blocages, signalements, demandes de rejoindre', () => {
  it('GET /prefs et PUT /prefs ; les défauts correspondent au contrat', async () => {
    expect(DEFAULT_PREFS).toEqual({
      activityVisibility: 'friends', watchWith: 'ask', libraryVisibility: 'friends', messagesFrom: 'friends',
      historyVisible: true, antiSpoiler: true, playbackSocial: 'all',
      notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
    });
    reply = () => json(DEFAULT_PREFS);
    await v3.getPrefs();
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/prefs' });
    await v3.updatePrefs({ watchWith: 'never', notify: { sound: true } });
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/prefs', body: { watchWith: 'never', notify: { sound: true } } });
  });

  it('PUT /friends/:pid/relation envoie seulement les champs donnés', async () => {
    reply = () => json({ pid: 'p2', handle: { name: 'Al', tag: 'B2C3', full: 'Al#B2C3' }, avatarColor: '#a00', household: false, status: 'online', favorite: true, muted: false });
    const f = await v3.updateRelation('p2', { favorite: true, nickname: null });
    expect(f.favorite).toBe(true);
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/friends/p2/relation', body: { favorite: true, nickname: null } });
    expect(last().body).not.toHaveProperty('muted');
  });

  it('blocages : POST, DELETE, GET /blocks', async () => {
    reply = () => new Response(null, { status: 204 });
    await v3.blockUser('p3');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/blocks/p3' });
    await v3.unblockUser('p3');
    expect(last()).toMatchObject({ method: 'DELETE', path: '/user/social/blocks/p3' });
    reply = () => json({ blocked: [{ pid: 'p3', handle: { name: 'Zoe', tag: '2345', full: 'Zoe#2345' } }] });
    const r = await v3.getBlocks();
    expect(r.blocked.map((b) => b.pid)).toEqual(['p3']);
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/blocks' });
  });

  it('POST /reports avec le corps tel quel (détails omis s’il est absent)', async () => {
    reply = () => new Response(null, { status: 201 });
    await v3.reportUser({ pid: 'p3', reason: 'spam' });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/reports', body: { pid: 'p3', reason: 'spam' } });
    expect(last().body).not.toHaveProperty('details');
  });

  it('demande de rejoindre et réponse : routes et corps', async () => {
    reply = () => new Response(null, { status: 204 });
    await v3.requestJoin('p4');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/friends/p4/join-request' });
    await v3.answerJoin('p4', { accept: true, partyId: 'pty1' });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/join-requests/p4', body: { accept: true, partyId: 'pty1' } });
    await v3.answerJoin('p4', { accept: false });
    expect(last().body).toEqual({ accept: false });
  });
});

describe('S3 — conversations, messages, réactions, sondages, saisie', () => {
  it('GET /conv/:conv/messages : conv encodé, pagination en requête', async () => {
    reply = () => json({ messages: [] });
    await v3.getConvMessages('dm:p1', { before: 100, limit: 20 });
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/conv/dm%3Ap1/messages?before=100&limit=20' });
    await v3.getConvMessages('g:G1');
    expect(last().path).toBe('/user/social/conv/g%3AG1/messages');
  });

  it('POST /conv/:conv/messages envoie le corps riche tel quel', async () => {
    reply = (s) => json({ message: { id: 'm1', from: 'p1', to: 'me', createdAt: 1, conv: 'dm:me', kind: 'poll', reactions: [], body: '', ...s.body } }, 201);
    const body = { kind: 'poll' as const, poll: { question: 'Qui tient la télécommande ?', options: ['Moi', 'Toi'] }, replyTo: 'm0' };
    const r = await v3.sendConvMessage('dm:me', body);
    expect(r.message.kind).toBe('poll');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/conv/dm%3Ame/messages', body });
  });

  it('PUT /conv/:conv/read ; POST réactions ; POST vote ; POST typing', async () => {
    reply = () => new Response(null, { status: 204 });
    await v3.markConvRead('g:G1');
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/conv/g%3AG1/read' });

    reply = () => json({ reactions: [{ emoji: '🔥', count: 2, mine: true }] });
    const rx = await v3.toggleReaction('g:G1', 'm 9', '🔥');
    expect(rx.reactions[0]).toMatchObject({ count: 2, mine: true });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/conv/g%3AG1/messages/m%209/reactions', body: { emoji: '🔥' } });

    reply = () => json({ poll: { id: 'poll1', question: 'Q', options: [], closed: false } });
    await v3.votePoll('g:G1', 'poll1', 'o2');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/conv/g%3AG1/polls/poll1/vote', body: { optionId: 'o2' } });

    reply = () => new Response(null, { status: 204 });
    await v3.sendTyping('dm:p1');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/conv/dm%3Ap1/typing' });
  });

  it('groupes : POST /groups, PUT /groups/:id, DELETE /groups/:id/me', async () => {
    reply = (s) => json({ pid: 'g1', conv: 'g:G1', handle: { name: 'Soirée', tag: 'A7K2', full: 'Soirée#A7K2' }, avatarColor: '#0a0', unread: 0, group: { id: 'G1', name: 'Soirée', members: [] } }, 201);
    const g = await v3.createGroup({ name: 'Soirée', members: ['p2', 'p3'] });
    expect(g).toMatchObject({ group: { id: 'G1' } });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/groups', body: { name: 'Soirée', members: ['p2', 'p3'] } });

    reply = () => new Response(null, { status: 204 });
    await v3.updateGroup('G1', { add: ['p4'], remove: ['p2'] });
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/groups/G1', body: { add: ['p4'], remove: ['p2'] } });
    await v3.leaveGroup('G1');
    expect(last()).toMatchObject({ method: 'DELETE', path: '/user/social/groups/G1/me' });
  });

  it('POST /share : cibles pid et groupe', async () => {
    reply = () => json({ messages: [] }, 201);
    const input = {
      to: [{ pid: 'p2' }, { group: 'G1' }], kind: 'title' as const,
      title: { type: 'movie' as const, tmdbId: 603, title: 'Matrix', year: 1999, rating: 4 },
    };
    await v3.shareTo(input);
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/share', body: input });
  });

  it('liens publics : création avec session ; lecture sans session ni profil', async () => {
    reply = () => json({ url: 'https://x/t/AB12', code: 'AB12' }, 201);
    await expect(v3.createShareLink({ type: 'movie', tmdbId: 603, withInvite: true, note: 'trop bien' })).resolves.toMatchObject({ code: 'AB12' });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/share-links' });
    expect(last().headers.authorization).toBe('Bearer sess-token');

    reply = () => json({ type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/p.jpg', from: { handle: { name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' }, avatarColor: '#111' } });
    const view = await v3.getShareLink('AB 12');
    expect(view.title).toBe('Matrix');
    expect(last().path).toBe('/user/social/share-links/AB%2012');
    expect(last().headers).not.toHaveProperty('authorization');
    expect(last().headers).not.toHaveProperty('x-profile-id');
  });

  it('listes partagées : GET, POST, détail, items, suppression d’un item, PUT', async () => {
    reply = () => json({ lists: [{ id: 'L1', name: 'Samedi', members: [], count: 2 }] });
    const ls = await v3.getLists();
    expect(ls.lists[0].count).toBe(2);
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/lists' });

    reply = (s) => json({ id: 'L2', name: s.body.name, members: [], count: 0 }, 201);
    await v3.createList({ name: 'Ados', members: ['p2'] });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/lists', body: { name: 'Ados', members: ['p2'] } });

    reply = () => json({ id: 'L1', name: 'Samedi', members: [], items: [] });
    await v3.getList('L1');
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/lists/L1' });

    reply = () => new Response(null, { status: 201 });
    await v3.addListItem('L1', { type: 'series', tmdbId: 1399, title: 'Game of Thrones', poster: '/g.jpg' });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/lists/L1/items', body: { type: 'series', tmdbId: 1399 } });

    reply = () => new Response(null, { status: 204 });
    await v3.removeListItem('L1', 'movie', 603);
    expect(last()).toMatchObject({ method: 'DELETE', path: '/user/social/lists/L1/items/movie/603' });

    await v3.updateList('L1', { name: 'Dimanche', add: ['p3'] });
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/lists/L1', body: { name: 'Dimanche', add: ['p3'] } });
  });
});

describe('S5 — activité et agrégats', () => {
  it('GET /activity : pagination en requête', async () => {
    reply = () => json({ items: [] });
    await v3.getActivity({ before: 5000, limit: 10 });
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/activity?before=5000&limit=10' });
    await v3.getActivity();
    expect(last().path).toBe('/user/social/activity');
  });

  it('GET /notes/heatmap : 60 tranches par défaut, épisode facultatif', async () => {
    reply = () => json({ buckets: [0, 1, 2] });
    await v3.getHeatmap({ type: 'movie', tmdbId: 603 });
    expect(last().path).toBe('/user/social/notes/heatmap?type=movie&tmdbId=603&buckets=60');
    await v3.getHeatmap({ type: 'series', tmdbId: 1399, season: 1, episode: 3, buckets: 30 });
    expect(last().path).toBe('/user/social/notes/heatmap?type=series&tmdbId=1399&season=1&episode=3&buckets=30');
  });

  it('GET /missed : since et média', async () => {
    reply = () => json({ messages: 3, byFriend: [], notes: [] });
    const m = await v3.getMissed({ since: 100, type: 'series', tmdbId: 1399, season: 1, episode: 2 });
    expect(m.messages).toBe(3);
    expect(last().path).toBe('/user/social/missed?since=100&type=series&tmdbId=1399&season=1&episode=2');
  });
});
