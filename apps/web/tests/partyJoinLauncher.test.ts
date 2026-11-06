// Rejoindre un salon avant toute lecture (LAST-1615) : le lanceur du pont est posé au chargement du chargeur du lecteur,
// et l'absence de lanceur ne se traduit plus par un retour silencieux (bouton figé sur « Connexion au salon… »).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const SESSION = '../src/player/session.js';
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
interface Call { method: string; path: string; body: any }
const calls: Call[] = [];
let routes: (c: Call) => Response | undefined = () => undefined;
const detail = () => document.getElementById('detail')!;
const ROOM = { id: 'r1', visibility: 'private', title: 'Severance', poster: '/s.jpg', language: 'fr', media: { type: 'series', tmdbId: 95396, season: 1, episode: 2 }, fingerprint: { fileName: 'x.mkv' }, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01' };

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
});

afterEach(async () => {
  const { partyBridge } = await import('../src/party/bridge');
  partyBridge.leave();
});

afterAll(() => { vi.doUnmock(SESSION); vi.unstubAllGlobals(); });

describe('lanceur du salon posé par le chargeur du lecteur', () => {
  it('importer sessionLoader.js pose partyBridge.launcher, qui lance playBest une fois le lecteur chargé', async () => {
    const m = { isPlayerOpen: vi.fn(() => false), isPlayerFull: vi.fn(() => false), closePlayer: vi.fn(), leavePlayer: vi.fn(), playBest: vi.fn(async () => 'best'), playSource: vi.fn(async () => 'src') };
    vi.doMock(SESSION, () => m);
    const { partyBridge } = await import('../src/party/bridge');
    partyBridge.launcher = null; // avant l'import du chargeur : rien ne doit l'avoir posé
    await import('../src/player/sessionLoader.js');
    expect(partyBridge.launcher).not.toBeNull();
    expect(m.playBest).not.toHaveBeenCalled();
    const req = { type: 'movie', id: '550', name: 'Fight Club', season: null, episode: null, key: 'movie:550' };
    const opts = { resume: 'none', prefer: () => null };
    await partyBridge.launcher!(req as never, opts as never);
    expect(m.playBest).toHaveBeenCalledTimes(1);
    expect(m.playBest).toHaveBeenCalledWith(req, null, { resume: 'none', force: true, prefer: opts.prefer });
  });
});

describe('sans lanceur : erreur explicite, pas de retour silencieux', () => {
  it('joinAndPlay rejette avec player_unavailable', async () => {
    const { partyBridge } = await import('../src/party/bridge');
    const connect = vi.spyOn(partyBridge, 'connect').mockImplementation(async () => { partyBridge.room = ROOM as never; });
    partyBridge.launcher = null;
    await expect(partyBridge.joinAndPlay('r1', 'p1')).rejects.toMatchObject({ code: 'player_unavailable' });
    connect.mockRestore();
  });

  it('launchRoom rejette avec player_unavailable', async () => {
    const { partyBridge } = await import('../src/party/bridge');
    partyBridge.room = ROOM as never;
    partyBridge.launcher = null;
    await expect(partyBridge.launchRoom()).rejects.toMatchObject({ code: 'player_unavailable' });
  });

  it('page du salon : « Rejoindre » affiche le motif et le bouton redevient cliquable', async () => {
    const p = await import('../src/ui/parties.js');
    const { partyBridge } = await import('../src/party/bridge');
    routes = (c) => (c.method === 'GET' && c.path === '/party/r1' ? json({ room: ROOM })
      : c.method === 'POST' && c.path === '/party/r1/join' ? json({ ticket: 'T', expiresAt: '2026-01-01', wsPath: '/party/r1/ws?ticket=T', room: ROOM }) : undefined);
    detail().innerHTML = '';
    await p.showParty('r1');
    partyBridge.launcher = null;
    (detail().querySelector('[data-wp-join]') as HTMLButtonElement).click();
    await tick(80);
    expect((detail().querySelector('[data-wp-join]') as HTMLButtonElement).disabled).toBe(false);
    expect(detail().querySelector('[data-wp-msg]')!.textContent).toBe('Le lecteur est indisponible : recharge la page.');
    expect(partyBridge.isActive()).toBe(false);
  });
});

describe('annulation pendant le premier chargement du lecteur', () => {
  const ROOM2 = { ...ROOM, id: 'r2' };

  /** Page neuve : modules réinitialisés, #detail recréé sans écouteurs, `import('./session.js')` retenu par `gate`. */
  async function freshJoinPage(gate: Promise<void>) {
    vi.resetModules();
    const m = { isPlayerOpen: vi.fn(() => false), isPlayerFull: vi.fn(() => false), closePlayer: vi.fn(), leavePlayer: vi.fn(), playBest: vi.fn(async () => undefined), playSource: vi.fn(async () => undefined) };
    vi.doMock(SESSION, async () => { await gate; return m; });
    const old = detail();
    old.replaceWith(old.cloneNode(false));
    const { auth } = await import('../src/data/auth');
    auth.status = 'ready';
    auth.profile = { id: 'p1', name: 'Greg', isKid: false } as any;
    const { partyBridge } = await import('../src/party/bridge');
    await import('../src/player/sessionLoader.js');
    const p = await import('../src/ui/parties.js');
    routes = (c) => (c.method === 'GET' && c.path === '/party/r1' ? json({ room: ROOM })
      : c.method === 'POST' && c.path === '/party/r1/join' ? json({ ticket: 'T', expiresAt: '2026-01-01', wsPath: '/party/r1/ws?ticket=T', room: ROOM })
      : c.method === 'GET' && c.path === '/party/r2' ? json({ room: ROOM2 })
      : c.method === 'POST' && c.path === '/party/r2/join' ? json({ ticket: 'T2', expiresAt: '2026-01-01', wsPath: '/party/r2/ws?ticket=T2', room: ROOM2 }) : undefined);
    detail().innerHTML = '';
    await p.showParty('r1');
    return { partyBridge, m };
  }

  it('retour arrière pendant le chargement : salon quitté, bouton réactivé, message vidé', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { partyBridge, m } = await freshJoinPage(gate);
    (detail().querySelector('[data-wp-join]') as HTMLButtonElement).click();
    await tick(80); // le salon se connecte ; le lanceur attend le module du lecteur
    expect(partyBridge.isActive()).toBe(true);
    window.dispatchEvent(new Event('popstate'));
    release();
    await tick(80);
    expect(m.playBest).not.toHaveBeenCalled();
    expect(partyBridge.isActive()).toBe(false);
    expect((detail().querySelector('[data-wp-join]') as HTMLButtonElement).disabled).toBe(false);
    expect(detail().querySelector('[data-wp-msg]')!.textContent).toBe('');
  });

  it('lancement terminé, salon toujours actif : le bouton ne reste pas figé pour le retour sur la page', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { partyBridge, m } = await freshJoinPage(gate);
    (detail().querySelector('[data-wp-join]') as HTMLButtonElement).click();
    await tick(80);
    release();
    await tick(80);
    expect(m.playBest).toHaveBeenCalledTimes(1);
    expect(partyBridge.isActive()).toBe(true);
    expect((detail().querySelector('[data-wp-join]') as HTMLButtonElement).disabled).toBe(false);
    expect(detail().querySelector('[data-wp-msg]')!.textContent).toBe('');
  });

  it('un autre salon rejoint pendant le chargement reste connecté', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { partyBridge, m } = await freshJoinPage(gate);
    (detail().querySelector('[data-wp-join]') as HTMLButtonElement).click();
    await tick(80);
    window.dispatchEvent(new Event('popstate'));
    const second = partyBridge.joinAndPlay('r2', 'p1'); // second salon, rejoint avant l'arrivée du lecteur
    await tick(80);
    release();
    await second;
    await tick(80);
    expect(m.playBest).toHaveBeenCalledTimes(1);
    expect(partyBridge.isActive()).toBe(true);
    expect(partyBridge.room?.id).toBe('r2');
  });
});
