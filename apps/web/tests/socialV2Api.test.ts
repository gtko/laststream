// Client REST du Social v2 : validation des handles, URL, méthode, corps et en-têtes de chaque endpoint.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import { saveProfileToken, setSession } from '../src/data/session';
import * as api from '../src/data/socialV2Api';
import { validateHandle } from '../src/data/socialV2Api';
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

describe('validateHandle', () => {
  it('normalise Nom#TAG : espaces retirés, tag en majuscules', () => {
    expect(validateHandle('Greg#a7k2')).toEqual({ name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' });
    expect(validateHandle('  Zoé Ü_-2 # 2345 ')).toEqual({ name: 'Zoé Ü_-2', tag: '2345', full: 'Zoé Ü_-2#2345' });
  });

  it('accepte un nom de 2 à 20 caractères, lettres Unicode et chiffres compris', () => {
    expect(validateHandle('Al#2345')?.name).toBe('Al');
    expect(validateHandle('A'.repeat(20) + '#A7K2')?.name).toHaveLength(20);
    expect(validateHandle('Ébène2#A7K2')).not.toBeNull();
  });

  it('refuse un nom trop court, trop long ou avec un caractère interdit', () => {
    expect(validateHandle('G#A7K2')).toBeNull();
    expect(validateHandle('A'.repeat(21) + '#A7K2')).toBeNull();
    expect(validateHandle('Gr!eg#A7K2')).toBeNull();
    expect(validateHandle('😀😀#A7K2')).toBeNull();
    expect(validateHandle('   #A7K2')).toBeNull();
  });

  it('refuse un tag hors alphabet ou de mauvaise longueur', () => {
    expect(validateHandle('Greg#A7K')).toBeNull();
    expect(validateHandle('Greg#A7K22')).toBeNull();
    expect(validateHandle('Greg#A7K0')).toBeNull();
    expect(validateHandle('Greg#A7KO')).toBeNull();
    expect(validateHandle('Greg#A7KI')).toBeNull();
    expect(validateHandle('Greg#A7KL')).toBeNull();
    expect(validateHandle('Greg#A7K1')).toBeNull();
    expect(validateHandle('Greg#a7il')).toBeNull();
  });

  it('refuse une chaîne sans # ou avec deux #', () => {
    expect(validateHandle('Greg')).toBeNull();
    expect(validateHandle('Greg#A7K2#B')).toBeNull();
    expect(validateHandle('')).toBeNull();
  });
});

describe('endpoints /user/social', () => {
  it('envoie le jeton de session et le jeton du profil connecté', async () => {
    reply = () => json({ pid: 'me', handle: { name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' }, status: 'online', avatarColor: '#111' });
    const me = await api.getMe();
    expect(me.pid).toBe('me');
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe('http://localhost:7000/user/social/me');
    expect(sent[0].headers.authorization).toBe('Bearer sess-token');
    expect(sent[0].headers['x-profile-token']).toBe('prof-token');
  });

  it('n’envoie pas de jeton de profil si le profil n’en a pas', async () => {
    auth.profile = { id: 'p2', name: 'Sans jeton' } as any;
    try {
      reply = () => json({ friends: [], household: [], incoming: [], outgoing: [] });
      await api.getFriends();
      expect(sent[0].headers['x-profile-token']).toBeUndefined();
    } finally {
      auth.profile = { id: 'p1', name: 'Greg' } as any;
    }
  });

  it('PUT /status porte le statut', async () => {
    reply = (s) => json({ status: s.body.status });
    expect(await api.putStatus('dnd')).toEqual({ status: 'dnd' });
    expect(sent[0]).toMatchObject({ method: 'PUT', url: 'http://localhost:7000/user/social/status', body: { status: 'dnd' } });
  });

  it('GET /friends renvoie les quatre listes', async () => {
    reply = () => json({ friends: [], household: [], incoming: [], outgoing: [] });
    await api.getFriends();
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'http://localhost:7000/user/social/friends' });
  });

  it('POST /requests envoie le handle normalisé et renvoie la demande (201) ou l’ami (200)', async () => {
    reply = () => json({ request: { pid: 'p3' } }, 201);
    const r = await api.sendFriendRequest('greg#a7k2');
    expect(r).toEqual({ request: { pid: 'p3' } });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://localhost:7000/user/social/requests', body: { handle: 'greg#A7K2' } });

    reply = () => json({ friend: { pid: 'p4' } }, 200);
    expect(await api.sendFriendRequest('Greg#A7K2')).toEqual({ friend: { pid: 'p4' } });
  });

  it('un handle invalide est refusé sans appel réseau', async () => {
    await expect(api.sendFriendRequest('Greg#A7K0')).rejects.toMatchObject({ code: 'invalid_handle', status: 400 });
    expect(sent).toHaveLength(0);
  });

  it('remonte le code d’erreur serveur (handle_not_found)', async () => {
    reply = () => json({ error: 'handle_not_found' }, 404);
    const err = await api.sendFriendRequest('Greg#A7K2').catch((e) => e);
    expect(err).toBeInstanceOf(UserApiError);
    expect(err.code).toBe('handle_not_found');
    expect(err.status).toBe(404);
  });

  it('accepte, refuse et supprime en encodant le pid', async () => {
    reply = () => json({ friend: { pid: 'a/b c' } });
    expect(await api.acceptFriendRequest('a/b c')).toEqual({ friend: { pid: 'a/b c' } });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://localhost:7000/user/social/requests/a%2Fb%20c/accept' });

    reply = () => new Response(null, { status: 204 });
    expect(await api.declineFriendRequest('p9')).toBeUndefined();
    expect(sent[1]).toMatchObject({ method: 'DELETE', url: 'http://localhost:7000/user/social/requests/p9' });

    await api.removeFriend('p9');
    expect(sent[2]).toMatchObject({ method: 'DELETE', url: 'http://localhost:7000/user/social/friends/p9' });
  });

  it('bibliothèque et historique d’un ami ; l’historique borne la limite entre 1 et 50', async () => {
    reply = () => json({ items: [] });
    await api.getFriendLibrary('p9');
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'http://localhost:7000/user/social/friends/p9/library' });

    await api.getFriendHistory('p9');
    expect(sent[1].url).toBe('http://localhost:7000/user/social/friends/p9/history?limit=20');
    await api.getFriendHistory('p9', 500);
    expect(sent[2].url).toBe('http://localhost:7000/user/social/friends/p9/history?limit=50');
    await api.getFriendHistory('p9', 0);
    expect(sent[3].url).toBe('http://localhost:7000/user/social/friends/p9/history?limit=1');
  });

  it('présence : PUT avec ou sans lecture, DELETE à la déconnexion', async () => {
    reply = () => new Response(null, { status: 204 });
    const watching = { type: 'movie' as const, tmdbId: 603, title: 'Matrix', pos: 12, paused: false, at: 1 };
    await api.putPresence(watching);
    expect(sent[0]).toMatchObject({ method: 'PUT', url: 'http://localhost:7000/user/social/presence', body: { watching } });

    await api.putPresence(null);
    expect(sent[1].body).toEqual({ watching: null });

    await api.putPresence();
    expect(sent[2].body).toEqual({});

    await api.deletePresence();
    expect(sent[3]).toMatchObject({ method: 'DELETE', url: 'http://localhost:7000/user/social/presence' });
  });

  it('conversations, messages : pagination et envoi', async () => {
    reply = () => json({ conversations: [] });
    await api.getConversations();
    expect(sent[0].url).toBe('http://localhost:7000/user/social/conversations');

    reply = () => json({ messages: [] });
    await api.getMessages('p9', { before: 123, limit: 10 });
    expect(sent[1].url).toBe('http://localhost:7000/user/social/messages/p9?before=123&limit=10');
    await api.getMessages('p9');
    expect(sent[2].url).toBe('http://localhost:7000/user/social/messages/p9');

    reply = () => json({ message: { id: 'm1' } }, 201);
    await api.sendMessage('p9', 'salut');
    expect(sent[3]).toMatchObject({ method: 'POST', url: 'http://localhost:7000/user/social/messages/p9', body: { body: 'salut' } });
    await api.sendMessage('p9', 'regarde', { type: 'movie', tmdbId: 603, pos: 12 });
    expect(sent[4].body).toEqual({ body: 'regarde', context: { type: 'movie', tmdbId: 603, pos: 12 } });

    reply = () => new Response(null, { status: 204 });
    await api.markMessagesRead('p9');
    expect(sent[5]).toMatchObject({ method: 'PUT', url: 'http://localhost:7000/user/social/messages/p9/read' });
  });

  it('notes : liste filtrée, création sans champ vide, suppression', async () => {
    reply = () => json({ notes: [] });
    await api.getNotes({ type: 'movie', tmdbId: 603 });
    expect(sent[0].url).toBe('http://localhost:7000/user/social/notes?type=movie&tmdbId=603');
    await api.getNotes({ type: 'series', tmdbId: 1399, season: 1, episode: 2 });
    expect(sent[1].url).toBe('http://localhost:7000/user/social/notes?type=series&tmdbId=1399&season=1&episode=2');

    reply = () => json({ note: { id: 'n1' } }, 201);
    await api.postNote({ type: 'movie', tmdbId: 603, pos: 12.5, kind: 'emoji', body: '😀' });
    expect(sent[2]).toMatchObject({
      method: 'POST', url: 'http://localhost:7000/user/social/notes',
      body: { type: 'movie', tmdbId: 603, pos: 12.5, kind: 'emoji', body: '😀' },
    });
    expect(Object.keys(sent[2].body)).not.toContain('season');

    reply = () => new Response(null, { status: 204 });
    await api.deleteNote('n1');
    expect(sent[3]).toMatchObject({ method: 'DELETE', url: 'http://localhost:7000/user/social/notes/n1' });
  });

  it('ticket du canal temps réel', async () => {
    reply = () => json({ wsPath: '/user/social/live?ticket=T' });
    expect(await api.createLiveTicket()).toEqual({ wsPath: '/user/social/live?ticket=T' });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://localhost:7000/user/social/live-ticket' });
  });
});
