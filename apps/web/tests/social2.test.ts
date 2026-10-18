// Bibliothèques partagées, bibliothèque d'un ami, salons publics et panneau de la watch party.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
interface Call { method: string; path: string; body: any }
const calls: Call[] = [];
let routes: (c: Call) => Response | undefined = () => undefined;
const detail = () => document.getElementById('detail')!;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null; onmessage: unknown = null; onclose: unknown = null; onerror: unknown = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send() { /* ignoré */ }
  close() { /* ignoré */ }
}

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const { auth } = await import('../src/data/auth');
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', isKid: false } as any;
});

beforeEach(() => {
  calls.length = 0;
  routes = () => undefined;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return routes(c) ?? json({ error: 'not_found' }, 404);
  }));
  window.confirm = () => true;
});

describe('visibilité de la bibliothèque', () => {
  it('lit la visibilité de chaque titre, défaut privée', async () => {
    const m = await import('../src/ui/libshare.js');
    routes = (c) => (c.path === '/user/profiles/default/library' || c.path.endsWith('/library') ? json({ items: [
      { type: 'series', tmdbId: 1399, imdbId: null, title: 'GoT', poster: null, addedAt: '2026-01-01', visibility: 'friends' },
      { type: 'movie', tmdbId: 550, imdbId: null, title: 'Fight Club', poster: null, addedAt: '2026-01-01' },
    ] }) : undefined);
    expect(await m.loadVisibility()).toBe(true);
    expect(m.visibilityOf('tv:1399')).toBe('friends');
    expect(m.visibilityOf('movie:550')).toBe('private');
    expect(m.visibilityOf('movie:999')).toBe('private');
  });

  it('bascule un titre (PUT visibility) et revient en arrière si le serveur refuse', async () => {
    const m = await import('../src/ui/libshare.js');
    routes = (c) => (c.method === 'PUT' && c.path.endsWith('/library/movie/550/visibility') ? new Response(null, { status: 204 }) : json({ error: 'library_item_not_found' }, 404));
    expect(await m.toggleVisibility('movie:550')).toBe(true);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toMatch(/\/user\/profiles\/[^/]+\/library\/movie\/550\/visibility$/);
    expect(put.body).toEqual({ visibility: 'friends' });
    expect(m.visibilityOf('movie:550')).toBe('friends');
    expect(await m.toggleVisibility('tv:7')).toBe(false);
    expect(m.visibilityOf('tv:7')).toBe('private');
  });

  it('partage global, filtré sur les séries', async () => {
    const m = await import('../src/ui/libshare.js');
    const { state } = await import('../src/ui/state.js');
    state.libView.type = 'tv';
    routes = (c) => (c.method === 'PUT' && c.path.endsWith('/library/visibility') ? json({ updated: 3 }) : undefined);
    expect(await m.setAll('friends')).toBe(true);
    expect(calls.find((c) => c.path.endsWith('/library/visibility'))!.body).toEqual({ visibility: 'friends', type: 'series' });
    state.libView.type = 'all';
    await m.setAll('private');
    expect(calls.filter((c) => c.path.endsWith('/library/visibility')).at(-1)!.body).toEqual({ visibility: 'private' });
  });

  it('pas de partage pour un profil enfant', async () => {
    const { auth } = await import('../src/data/auth');
    const m = await import('../src/ui/libshare.js');
    const before = auth.profile;
    auth.profile = { id: 'k', name: 'Léo', isKid: true, kidMaxAge: 10 } as any;
    expect(m.sharingAvailable()).toBe(false);
    expect(m.visButtonHTML('movie:1')).toBe('');
    expect(m.shareControlsHTML()).toBe('');
    auth.profile = before;
    expect(m.sharingAvailable()).toBe(true);
    expect(m.visButtonHTML('movie:1')).toContain('data-libvis="movie:1"');
  });
});

describe('bibliothèque d’un ami', () => {
  it('affiche ses titres visibles, « Ajouter à ma bibliothèque » et « Lire »', async () => {
    const f = await import('../src/ui/friends.js');
    const { userStore } = await import('../src/data/userStore');
    routes = (c) => (c.path.startsWith('/user/friends/amy/library') ? json({
      items: [
        { type: 'movie', tmdbId: 603, imdbId: null, title: 'Matrix', poster: 'https://image.tmdb.org/t/p/w342/m.jpg', addedAt: '2026-01-01' },
        { type: 'series', tmdbId: 95396, imdbId: null, title: 'Severance', poster: null, addedAt: '2026-01-02' },
        { type: 'movie', tmdbId: null, imdbId: 'tt1', title: 'Sans TMDB', poster: null, addedAt: '2026-01-03' },
      ], total: 3, limit: 50, offset: 0,
    }) : undefined);
    detail().innerHTML = '';
    f.showFriendLibrary('amy');
    await tick(120);
    expect(calls.find((c) => c.path.startsWith('/user/friends/amy/library'))!.path).toContain('limit=50');
    const keys = Array.from(detail().querySelectorAll('[data-fr-key]')).map((e) => (e as HTMLElement).dataset.frKey);
    expect(keys).toEqual(['movie:603', 'tv:95396']); // sans identifiant TMDB : ignoré
    expect(detail().querySelector('[data-fr-play="movie:603"]')).not.toBeNull();
    expect(userStore.inLibrary('movie:603')).toBe(false);
    (detail().querySelector('[data-fr-save="movie:603"]') as HTMLElement).click();
    expect(userStore.inLibrary('movie:603')).toBe(true);
    expect((detail().querySelector('[data-fr-save="movie:603"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ami inconnu ou non-ami : même erreur, rien n’est affiché', async () => {
    const f = await import('../src/ui/friends.js');
    routes = (c) => (c.path.startsWith('/user/friends/ghost/library') ? json({ error: 'friend_not_found' }, 404) : undefined);
    detail().innerHTML = '';
    f.showFriendLibrary('ghost');
    await tick(120);
    expect(detail().querySelectorAll('[data-fr-key]')).toHaveLength(0);
  });
});

describe('salons publics', () => {
  it('liste (affiche, titre, participants, langue) et filtre par langue', async () => {
    const p = await import('../src/ui/parties.js');
    routes = (c) => (c.path.startsWith('/party?') ? json({ rooms: [
      { id: 'r1', title: 'Severance', poster: '/s.jpg', language: 'fr', mediaType: 'series', host: 'alice', participants: 3, maxParticipants: 20, createdAt: '2026-01-01' },
      { id: 'r2', title: 'Alien', poster: null, language: 'en', mediaType: 'movie', host: 'bob', participants: 2, maxParticipants: 2, createdAt: '2026-01-01' },
    ], nextCursor: 'c2' }) : undefined);
    detail().innerHTML = '';
    p.showParties();
    await tick(120);
    const req = calls.find((c) => c.path.startsWith('/party?'))!;
    expect(req.path).toContain('profileId=');
    const cards = detail().querySelectorAll('.wp-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Severance');
    expect(cards[0].textContent).toContain('Hôte : alice · 3/20 participants');
    expect(cards[0].textContent).toContain('Français');
    expect(cards[0].querySelector('img')!.getAttribute('src')).toContain('/s.jpg');
    expect(cards[1].textContent).toContain('Complet');
    expect(detail().querySelector('[data-wp-more]')).not.toBeNull();
    const sel = detail().querySelector('[data-wp-lang]') as HTMLSelectElement;
    sel.value = 'en';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(80);
    expect(calls.filter((c) => c.path.startsWith('/party?')).at(-1)!.path).toContain('language=en');
  });

  it('profil enfant : pas de liste publique', async () => {
    const { auth } = await import('../src/data/auth');
    const p = await import('../src/ui/parties.js');
    const before = auth.profile;
    auth.profile = { id: 'k', name: 'Léo', isKid: true, kidMaxAge: 10 } as any;
    calls.length = 0;
    detail().innerHTML = '';
    p.showParties();
    await tick(40);
    expect(detail().textContent).toContain('pas disponibles sur un profil enfant');
    expect(calls.some((c) => c.path.startsWith('/party'))).toBe(false);
    auth.profile = before;
  });

  it('page d’un salon : « Rejoindre » demande un ticket puis ouvre le WebSocket relatif au serveur', async () => {
    const p = await import('../src/ui/parties.js');
    const { partyBridge } = await import('../src/party/bridge');
    const room = { id: 'r1', visibility: 'private', title: 'Severance', poster: '/s.jpg', language: 'fr', media: { type: 'series', tmdbId: 95396, season: 1, episode: 2 }, fingerprint: { fileName: 'x.mkv' }, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01' };
    routes = (c) => (c.method === 'GET' && c.path === '/party/r1' ? json({ room }) : c.method === 'POST' && c.path === '/party/r1/join' ? json({ ticket: 'T', expiresAt: '2026-01-01', wsPath: '/party/r1/ws?ticket=T', room }) : undefined);
    detail().innerHTML = '';
    await p.showParty('r1');
    expect(detail().textContent).toContain('Severance · S1:É2');
    expect(detail().textContent).toContain('Hôte : alice');
    const launcher = vi.fn(async () => undefined);
    partyBridge.launcher = launcher;
    (detail().querySelector('[data-wp-join]') as HTMLElement).click();
    await tick(80);
    expect(calls.find((c) => c.path === '/party/r1/join')!.body).toEqual({ profileId: expect.any(String) });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:7000/party/r1/ws?ticket=T');
    // La lecture est lancée avec la cible du salon et le choix « version de l'hôte ».
    expect(launcher).toHaveBeenCalledTimes(1);
    const [req, opts] = launcher.mock.calls[0] as any[];
    expect(req).toMatchObject({ type: 'tv', id: '95396', season: 1, episode: 2 });
    const views = [{ filename: 'autre.mkv', sizeBytes: 1, playable: true }, { filename: 'x.mkv', sizeBytes: 2, playable: true }];
    expect(opts.prefer(views)).toBe(views[1]);
    partyBridge.leave();
  });

  it('salon public depuis un profil enfant : « Rejoindre » est désactivé', async () => {
    const { auth } = await import('../src/data/auth');
    const p = await import('../src/ui/parties.js');
    const before = auth.profile;
    auth.profile = { id: 'k', name: 'Léo', isKid: true, kidMaxAge: 10 } as any;
    const room = { id: 'r9', visibility: 'public', title: 'Public', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 1 }, fingerprint: null, host: 'alice', participants: 1, maxParticipants: 20, createdAt: '2026-01-01' };
    routes = (c) => (c.path === '/party/r9' ? json({ room }) : undefined);
    detail().innerHTML = '';
    await p.showParty('r9');
    expect((detail().querySelector('[data-wp-join]') as HTMLButtonElement).disabled).toBe(true);
    expect(detail().textContent).toContain('n’est pas accessible depuis un profil enfant');
    auth.profile = before;
  });

  it('salon introuvable : message', async () => {
    const p = await import('../src/ui/parties.js');
    routes = (c) => (c.path === '/party/zzz' ? json({ error: 'room_not_found' }, 404) : undefined);
    detail().innerHTML = '';
    await p.showParty('zzz');
    expect(detail().textContent).toContain('Ce salon n’existe plus');
  });
});

describe('panneau de la watch party', () => {
  const users = [{ username: 'alice', host: true, avatarColor: '#ff5a36' }, { username: 'bob', muted: true }, { username: 'carl' }];

  it('l’hôte voit les outils de modération ; un invité non', async () => {
    const { participantsHTML } = await import('../src/ui/partypanel.js');
    const asHost = participantsHTML(users, { username: 'alice', host: true, muted: false }, true);
    expect(asHost).toContain('data-wp-kick="bob"');
    expect(asHost).toContain('data-wp-mute="carl"');
    expect(asHost).toContain('data-wp-host="carl"');
    expect(asHost).not.toContain('data-wp-kick="alice"'); // pas d'outils sur soi-même
    expect(asHost).toContain('Rétablir'); // bob est muet
    expect(asHost).toContain('Hôte</em>');
    const asGuest = participantsHTML(users, { username: 'carl', host: false, muted: false }, false);
    expect(asGuest).not.toContain('data-wp-kick');
    expect(asGuest).toContain('carl (toi)');
  });

  it('chat : signalement possible sur les messages des autres seulement, texte échappé', async () => {
    const { chatHTML } = await import('../src/ui/partypanel.js');
    const html = chatHTML([{ id: 'm1', from: 'alice', text: '<b>salut</b>', at: 1 }, { id: 'm2', from: 'carl', text: 'moi', at: 2 }], { username: 'carl', host: false, muted: false });
    expect(html).toContain('&lt;b&gt;salut&lt;/b&gt;');
    expect(html).toContain('data-wp-report="m1"');
    expect(html).not.toContain('data-wp-report="m2"');
    expect(chatHTML([], null)).toContain('Aucun message');
  });
});

describe('pont salon <-> lecteur', () => {
  const room = (over: Record<string, unknown> = {}) => ({ id: 'r1', visibility: 'private', title: 'Severance', poster: '/s.jpg', language: 'fr', media: { type: 'series', tmdbId: 95396, season: 1, episode: 1 }, fingerprint: { fileName: 'E01.mkv', size: 100 }, host: 'alice', participants: 1, maxParticipants: 20, createdAt: '2026-01-01', ...over });
  const welcomeMsg = (me: string, host: boolean) => JSON.stringify({ t: 'welcome', you: { username: me, host, muted: false }, room: room(), state: { playing: false, pos: 0, at: 0 }, serverTime: 0, participants: [{ username: 'alice', host: true }], chat: [] });
  const adapter = (season: number, episode: number) => ({
    req: { type: 'tv', id: '95396', name: 'Severance', season, episode, key: 'tv:95396' }, cur: { season, episode },
    view: { filename: `E0${episode}.mkv`, sizeBytes: 100 + episode, playable: true, stream: { url: 'https://debrid.example/lien-prive' } }, poster: '/s.jpg', engine: null, ready: true,
  }) as any;
  const sentOf = (ws: FakeWebSocket) => ((ws as any).sent as string[] | undefined ?? []).map((s) => JSON.parse(s));

  beforeEach(() => {
    (FakeWebSocket.prototype as any).send = function send(this: any, d: string) { (this.sent ||= []).push(d); };
  });

  async function connectAs(me: string, host: boolean) {
    const { partyBridge } = await import('../src/party/bridge');
    routes = (c) => (c.method === 'POST' && c.path === '/party/r1/join' ? json({ ticket: 'T', expiresAt: 'x', wsPath: '/party/r1/ws?ticket=T', room: room() }) : undefined);
    partyBridge.leave();
    await partyBridge.connect('r1', 'p1');
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen!();
    (ws.onmessage as any)({ data: welcomeMsg(me, host) });
    return { partyBridge, ws };
  }

  it('création différée (fiche) : le salon est créé quand la source est choisie, sans aucun lien de lecture', async () => {
    const { partyBridge } = await import('../src/party/bridge');
    const { setSession } = await import('../src/data/session');
    setSession('tok', new Date(Date.now() + 1e9).toISOString(), 'greg');
    partyBridge.leave();
    routes = (c) => (c.method === 'POST' && c.path === '/party' ? json({ room: room({ visibility: 'public' }) }, 201) : c.path === '/party/r1/join' ? json({ ticket: 'T', expiresAt: 'x', wsPath: '/party/r1/ws?ticket=T', room: room() }) : undefined);
    const created = vi.fn();
    partyBridge.onCreated = created;
    partyBridge.pending = { visibility: 'public' };
    partyBridge.viewReady(adapter(1, 1));
    await tick(80);
    const body = calls.find((c) => c.method === 'POST' && c.path === '/party')!.body;
    expect(body).toMatchObject({ visibility: 'public', title: 'Severance', media: { type: 'series', tmdbId: 95396, season: 1, episode: 1 }, fingerprint: { fileName: 'E01.mkv', size: 101 } });
    expect(JSON.stringify(body)).not.toContain('debrid.example');
    expect(created).toHaveBeenCalledTimes(1);
    expect(partyBridge.pending).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
    partyBridge.onCreated = null;
    partyBridge.leave();
  });

  it('l’hôte annonce son changement d’épisode avec l’empreinte de sa version', async () => {
    const { partyBridge, ws } = await connectAs('alice', true);
    expect(partyBridge.isHost()).toBe(true);
    expect(partyBridge.guestLocked()).toBe(false);
    partyBridge.viewReady(adapter(1, 2));
    expect(sentOf(ws).filter((m) => m.t === 'episode')).toEqual([{ t: 'episode', season: 1, episode: 2, fingerprint: { fileName: 'E02.mkv', size: 102 } }]);
    partyBridge.viewReady(adapter(1, 2)); // pas de doublon
    expect(sentOf(ws).filter((m) => m.t === 'episode')).toHaveLength(1);
    partyBridge.leave();
  });

  it('un invité ne pilote pas et lance l’épisode de l’hôte avec la version la plus proche', async () => {
    const { partyBridge, ws } = await connectAs('bob', false);
    expect(partyBridge.guestLocked()).toBe(true);
    const launcher = vi.fn(async () => undefined);
    partyBridge.launcher = launcher;
    (ws.onmessage as any)({ data: JSON.stringify({ t: 'media', media: { type: 'series', tmdbId: 95396, season: 1, episode: 3 }, fingerprint: { fileName: 'E03.WEB-DL.mkv' }, state: { playing: false, pos: 0, at: 0 }, serverTime: 0 }) });
    expect(launcher).toHaveBeenCalledTimes(1);
    const [req, opts] = launcher.mock.calls[0] as any[];
    expect(req).toMatchObject({ type: 'tv', id: '95396', season: 1, episode: 3 });
    const views = [{ filename: 'E03.720p.mkv', sizeBytes: 5, playable: true }, { filename: 'E03.WEB-DL.mkv', sizeBytes: 6, playable: true }];
    expect(opts.prefer(views)).toBe(views[1]);
    // Rien d'envoyé par l'invité pour la lecture.
    expect(sentOf(ws).filter((m) => m.t === 'ctl' || m.t === 'episode')).toEqual([]);
    partyBridge.leave();
  });

  it('quitter le lecteur (fermeture non silencieuse) quitte le salon ; un changement d’épisode (silencieux) le garde', async () => {
    const { partyBridge } = await connectAs('bob', false);
    partyBridge.sessionClosed(true);
    expect(partyBridge.isActive()).toBe(true);
    partyBridge.sessionClosed(false);
    expect(partyBridge.isActive()).toBe(false);
  });
});
