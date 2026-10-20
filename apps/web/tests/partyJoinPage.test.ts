// Page invitée sans compte : « Quitter » ferme la session et propose de rejoindre à nouveau ; « format non pris en charge » reste
// joignable ; le diagnostic `window.__lsRelayStats` n'existe qu'avec `localStorage['ls.debug'] === '1'` ; aucun appel /user/me.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth, initAuth } from '../src/data/auth';
import { socketUrl } from '../src/party/bridge';

// Session de partage factice : la page n'a besoin que de sa phase, de son message et de ses actions.
const shared = vi.hoisted(() => ({ session: null as any }));
// Séance individuelle rendue par `POST /party/R1/guest` (entrée par le lien partagé).
const guest = vi.hoisted(() => ({ sessionToken: 'sess-abcdefgh-0001', name: 'Léa', expiresAt: '2099-01-01T00:00:00.000Z' }));

vi.mock('../src/party/bridge', () => ({ socketUrl: vi.fn((base: string, path: string) => base + path) }));
vi.mock('../src/relay/player/player', () => ({ GuestPlayer: class {} }));
vi.mock('../src/relay/session', () => ({
  GuestRelaySession: class {
    phase = 'joining';
    message = '';
    constructor() {
      shared.session = this;
    }
    start() {}
    tick() {
      return { phase: this.phase, message: this.message, note: '', rateBps: 0, bytesReceived: 0, bytesFromPeers: 0, meshPeers: 0, bytesServed: 0, playing: false, position: 0, duration: 0 };
    }
    leave() {
      this.phase = 'left';
      this.message = 'Tu as quitté le salon.';
    }
    destroy() {}
    debugCounts() {
      return { videoFrames: 7, audioData: 5, bytesFromHost: 42, bytesFromPeers: 0 };
    }
    play() {}
    pause() {}
    seekBy() {}
    retry() {}
    onWait() {
      return () => undefined;
    }
    onWelcome() {
      return () => undefined;
    }
    sendBuffering() {
      return false;
    }
    onSubtitles() {
      return () => undefined;
    }
    chatPort() {
      return null;
    }
  },
}));

const $ = (sel: string): HTMLElement & { value?: string } => document.querySelector('.pj')!.querySelector(sel) as HTMLElement & { value?: string };
const submit = (): void => {
  $('[name="name"]').value = 'Léa';
  $('[data-pj-form]').dispatchEvent(new Event('submit', { cancelable: true }));
};

let showPartyJoin: (roomId: string, token: string) => void;
let teardownPartyJoin: () => void;
let fetchMock: ReturnType<typeof vi.fn>;
/** Corps des entrées par le lien (`POST /party/R1/guest`), dans l'ordre. */
const entryPosts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div>' +
    '<div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
  reloadSettings();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && new URL(String(url)).pathname === '/party/R1/guest') {
      return new Response(JSON.stringify(guest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  ({ showPartyJoin, teardownPartyJoin } = (await import('../src/ui/partyjoin.js')) as any);
});

afterAll(() => {
  teardownPartyJoin();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('page invitée (sans compte)', () => {
  it('« Quitter » ferme la session : état « Tu as quitté le salon », « Rejoindre à nouveau » ; un nouveau clic rejoint', async () => {
    showPartyJoin('R1', 'abcdefgh12');
    expect($('[data-pj-leave]').hidden).toBe(true);

    submit();
    await vi.waitFor(() => expect(shared.session).not.toBeNull());
    // Lien partagé : le jeton du lien ne sert qu'à l'entrée ; le WebSocket présente la séance, mémorisée dans l'onglet.
    expect(entryPosts()).toEqual([{ token: 'abcdefgh12', name: 'Léa', avatar: 'hero:heros:Aegis' }]);
    expect(socketUrl).toHaveBeenLastCalledWith('https://srv.example', '/party/R1/ws?t=sess-abcdefgh-0001&name=L%C3%A9a');
    expect(sessionStorage.getItem('ls.party.guest.R1')).not.toBeNull();
    shared.session.phase = 'ready';
    await vi.waitFor(() => expect($('[data-pj-leave]').hidden).toBe(false));
    expect($('[data-pj-form]').hidden).toBe(true);

    $('[data-pj-leave]').click();
    expect(shared.session.phase).toBe('left');
    expect($('[data-pj-status]').textContent).toBe('Tu as quitté le salon.');
    expect($('[data-pj-join]').textContent).toBe('Rejoindre à nouveau');
    expect($('[data-pj-form]').hidden).toBe(false);
    expect($('[data-pj-leave]').hidden).toBe(true);
    // Quitter efface la séance : « Rejoindre à nouveau » repasse par le lien partagé.
    expect(sessionStorage.getItem('ls.party.guest.R1')).toBeNull();

    const first = shared.session;
    submit();
    await vi.waitFor(() => expect(shared.session).not.toBe(first));
    expect(shared.session.phase).toBe('joining');
    expect(entryPosts()).toHaveLength(2);
  });

  it('« format non pris en charge » n’est pas terminal : le message reste sous la page et « Quitter » reste disponible', async () => {
    shared.session.phase = 'unsupported';
    shared.session.message = 'Format non pris en charge dans ce navigateur (codec hevc).';
    await vi.waitFor(() => expect($('[data-pj-status]').textContent).toBe(shared.session.message));
    expect($('[data-pj-form]').hidden).toBe(true);
    expect($('[data-pj-leave]').hidden).toBe(false);
  });

  it('diagnostic : `window.__lsRelayStats` seulement avec localStorage « ls.debug » = 1, en lecture seule', async () => {
    const w = window as unknown as { __lsRelayStats?: Record<string, unknown> };
    shared.session.phase = 'ready';
    shared.session.message = '';
    await new Promise((r) => setTimeout(r, 300));
    expect(w.__lsRelayStats).toBeUndefined();

    localStorage.setItem('ls.debug', '1');
    await vi.waitFor(() => expect(w.__lsRelayStats).toEqual({ videoFrames: 7, audioData: 5, bytesFromHost: 42, bytesFromPeers: 0 }));
    expect(Object.isFrozen(w.__lsRelayStats)).toBe(true);
    expect(JSON.stringify(w.__lsRelayStats)).not.toMatch(/https?:|\//);
    localStorage.removeItem('ls.debug');
  });

  it('message d’état : en salon, une information s’efface après quelques secondes ; une alerte reste affichée', async () => {
    shared.session = null;
    showPartyJoin('R1', 'abcdefgh12');
    submit();
    await vi.waitFor(() => expect(shared.session).not.toBeNull());
    const status = (): HTMLElement => $('[data-pj-status]');

    shared.session.phase = 'waiting-host';
    shared.session.message = 'En attente de l’hôte : test.';
    await vi.waitFor(() => expect(status().textContent).toBe('En attente de l’hôte : test.'));
    expect(status().dataset.fade).toBeUndefined();
    await new Promise((r) => setTimeout(r, 4300));
    expect(status().dataset.fade).toBe('out');

    shared.session.phase = 'host-lost';
    shared.session.message = 'Liaison avec l’hôte interrompue.';
    await vi.waitFor(() => expect(status().textContent).toBe('Liaison avec l’hôte interrompue.'));
    await new Promise((r) => setTimeout(r, 4300));
    expect(status().dataset.fade).toBeUndefined();
    expect(status().dataset.tone).toBe('warn');
    expect($('[data-pj-retry]').hidden).toBe(false);
  }, 20000);
});

describe('initialisation sans compte', () => {
  beforeEach(() => {
    reloadSettings();
  });

  it('page invitée : aucun appel /user/me (l’invité n’a pas de compte, la réponse serait un 401)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await initAuth({ anonymous: true })).toBe('local');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auth.status).toBe('local');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
