// Salon d'attente, section « Ma source » (LAST-1615, lot L6) : liste langue et qualité, choix explicite qui survit à la reconnexion,
// recherche poursuivie, départ sans seconde recherche, source de l'hôte annoncée, focus clavier conservé.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { toSourceViews } from '../src/sources/info';

const mocks = vi.hoisted(() => ({ loadSources: vi.fn(), pollSources: vi.fn() }));
vi.mock('../src/sources/load', async (orig) => ({ ...(await orig<typeof import('../src/sources/load')>()), loadSources: mocks.loadSources, pollSources: mocks.pollSources }));

const lobby = () => document.querySelector('.pl') as HTMLElement | null;
const radios = () => [...lobby()!.querySelectorAll('[data-pl-source]')] as HTMLButtonElement[];
const labels = () => radios().map((r) => r.querySelector('b')!.textContent);
const checked = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.querySelector('b')!.textContent);
const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/play/c/' + n,
  behaviorHints: { filename: 'Dune.' + n + '.mkv', videoSize: 3e9 + n },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50 + n, estBitrateKbps: 5000, ...extra },
});
const FR_1080 = stream(1);
const FR_720 = stream(2, { resolution: '720p', height: 720, score: 40 });
const EN_720 = stream(3, { resolution: '720p', height: 720, languages: ['en'], score: 30 });
const loadedOf = (streams: unknown[], pending: string[] = []) => ({ imdb: 'tt1', views: toSourceViews(streams as never), pending });

type Handler = (payload: any) => void;
function fakeClient(isHost: boolean, over: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const c: any = {
    status: 'open',
    room: { id: 'r1', visibility: 'private', title: 'Dune', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 693134 }, fingerprint: null, host: 'Greg', maxParticipants: 20 },
    you: { username: isHost ? 'Greg' : 'Léa', host: isHost, muted: false },
    participants: [
      { username: 'Greg', host: true, ready: true, quality: null, status: 'ready' },
      { username: 'Léa', ready: true, quality: null, status: 'ready' },
    ],
    chat: [], state: { playing: false, pos: 0, at: 0, rev: 1 }, settings: { control: 'all', waitLate: '10s', reactions: 'float' },
    countdownAt: null, vote: null,
    get isHost() { return !!this.you.host; },
    serverNow: () => Date.now(),
    on(event: string, fn: Handler) { const l = handlers.get(event) ?? []; l.push(fn); handlers.set(event, l); return () => { l.splice(l.indexOf(fn), 1); }; },
    emit(event: string, payload?: unknown) { (handlers.get(event) ?? []).slice().forEach((fn) => fn(payload)); },
    sendReady: vi.fn(() => true), sendStatus: vi.fn(() => true), sendSource: vi.fn(() => true), sendSettings: vi.fn(() => true), startPlayback: vi.fn(() => true),
    sendChat: vi.fn(() => true), sendReact: vi.fn(() => true), castVote: vi.fn(() => true), openVote: vi.fn(() => true), closeVote: vi.fn(() => true),
    kick: vi.fn(), transfer: vi.fn(),
    ...over,
  };
  return c;
}

let mod: typeof import('../src/ui/partylobby.js');
let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let auth: typeof import('../src/data/auth')['auth'];

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  ({ auth } = await import('../src/data/auth'));
  ({ partyBridge } = await import('../src/party/bridge'));
  mod = await import('../src/ui/partylobby.js');
});

beforeEach(() => {
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', isKid: false } as never;
  mocks.loadSources.mockReset();
  mocks.pollSources.mockReset();
});

afterEach(() => {
  document.querySelectorAll('.pl').forEach((el) => el.remove());
  partyBridge.client = null;
  partyBridge.launcher = null;
  auth.status = 'local';
  auth.profile = null;
  vi.restoreAllMocks();
});

async function open(c: any) {
  partyBridge.client = c;
  await mod.openLobby('r1');
  await vi.waitFor(() => expect(radios().length).toBeGreaterThan(0));
}

describe('salon d’attente : Ma source', () => {
  it('liste la langue et la qualité, présélectionne la source du salon et se déclare prêt avec son libellé', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([EN_720, FR_1080]));
    const c = fakeClient(false);
    await open(c);
    expect(labels()).toEqual(['VF · 1080p', 'VO EN · 720p']);
    expect(checked()).toEqual(['VF · 1080p']);
    expect(lobby()!.querySelector('.pl-src')!.textContent).toContain('Ma source');
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-status')!.textContent).toBe('2 sources trouvées'));
    expect(radios()[1].textContent).toContain('Autre langue que le salon');
    expect(radios()[1].textContent).toContain('En cache');
    expect(c.sendReady).toHaveBeenLastCalledWith(true, 'VF · 1080p');
  });

  it('ligne « Hôte : … » et pastille « Même version que l’hôte » : la présélection suit la version de l’hôte', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, FR_720]));
    const c = fakeClient(false);
    c.participants[0].quality = 'VF · 720p';
    await open(c);
    expect(lobby()!.querySelector('.pl-src-host')!.textContent).toBe('Hôte : VF · 720p');
    expect(checked()).toEqual(['VF · 720p']);
    const mine = radios().find((r) => r.querySelector('b')!.textContent === 'VF · 720p')!;
    expect(mine.textContent).toContain('Même version que l’hôte');
  });

  it('avertissement et « Réessayer la recherche » quand aucune source n’est dans la langue du salon', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([EN_720]));
    await open(fakeClient(false));
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-banner [data-pl-retry]')).not.toBeNull());
    expect(lobby()!.querySelector('.pl-src-warn')!.textContent).toContain('pas dans la langue du salon');
    const retry = lobby()!.querySelector('.pl-src-banner [data-pl-retry]') as HTMLButtonElement;
    expect(retry.textContent).toBe('Réessayer la recherche');
    retry.click();
    await vi.waitFor(() => expect(mocks.loadSources).toHaveBeenCalledTimes(2));
  });

  it('le choix explicite survit à la reconnexion (welcome), prime sur l’hôte, et se réinitialise sur media', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, EN_720]));
    const c = fakeClient(false);
    await open(c);
    radios()[1].click();
    await vi.waitFor(() => expect(checked()).toEqual(['VO EN · 720p']));
    await vi.waitFor(() => expect(c.sendReady).toHaveBeenLastCalledWith(true, 'VO EN · 720p'));
    c.sendReady.mockClear();
    c.emit('welcome', {});
    await vi.waitFor(() => expect(c.sendReady).toHaveBeenCalledWith(true, 'VO EN · 720p'));
    expect(c.sendReady).not.toHaveBeenCalledWith(false, null);
    expect(checked()).toEqual(['VO EN · 720p']);
    expect(mocks.loadSources).toHaveBeenCalledTimes(1);
    // Le choix de l’hôte qui change ne retouche pas le choix explicite.
    c.participants[0].quality = 'VF · 1080p';
    c.emit('participants', c.participants);
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-host')!.textContent).toBe('Hôte : VF · 1080p'));
    expect(checked()).toEqual(['VO EN · 720p']);
    // Nouveau titre ou épisode : le choix ne vaut plus.
    c.emit('media', { media: { type: 'movie', tmdbId: 1 } });
    await vi.waitFor(() => expect(mocks.loadSources).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(checked()).toEqual(['VF · 1080p']));
  });

  it('la recherche continue après les premiers résultats et la liste se complète', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080], ['torrentio']));
    mocks.pollSources.mockResolvedValue(loadedOf([FR_1080, EN_720]));
    const c = fakeClient(false);
    await open(c);
    expect(labels()).toEqual(['VF · 1080p']);
    expect(c.sendReady).toHaveBeenCalledWith(true, 'VF · 1080p'); // prêt dès la première source
    expect(lobby()!.querySelector('.pl-src-status')!.textContent).toContain('Recherche en cours');
    await vi.waitFor(() => expect(labels()).toEqual(['VF · 1080p', 'VO EN · 720p']), { timeout: 4500, interval: 100 });
    expect(mocks.pollSources).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-status')!.textContent).toBe('2 sources trouvées'));
  }, 8000);

  it('au départ, la source choisie est lancée directement, sans seconde recherche', async () => {
    const loaded = loadedOf([FR_1080, EN_720]);
    mocks.loadSources.mockResolvedValue(loaded);
    const c = fakeClient(false);
    const launchRoom = vi.spyOn(partyBridge, 'launchRoom').mockResolvedValue(undefined);
    await open(c);
    radios()[1].click();
    await vi.waitFor(() => expect(checked()).toEqual(['VO EN · 720p']));
    c.state = { playing: true, pos: 0, at: 0, rev: 2 };
    c.emit('state', c.state);
    expect(launchRoom).toHaveBeenCalledTimes(1);
    const choice = launchRoom.mock.calls[0][0]!;
    expect(choice.view.info?.languages).toContain('en');
    expect(choice.loaded).toBe(loaded);
    expect(mocks.loadSources).toHaveBeenCalledTimes(1);
  });

  it('hôte : son choix est annoncé au salon (source + langue) après le délai de sélection, sans lien', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, EN_720]));
    const c = fakeClient(true);
    await open(c);
    radios()[1].click();
    await vi.waitFor(() => expect(c.sendSource).toHaveBeenCalledTimes(1));
    const [fp, lang] = c.sendSource.mock.calls[0];
    expect(lang).toBe('en');
    expect(JSON.stringify(fp)).not.toContain('https://');
    expect(c.sendReady).toHaveBeenLastCalledWith(true, 'VO EN · 720p');
  });

  it('hôte : un autre fichier de même libellé que la présélection est annoncé au salon (LAST-1615)', async () => {
    const SAME_1080 = stream(4, { score: 10 }); // « VF · 1080p » aussi, mais moins bien classé
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, SAME_1080]));
    const c = fakeClient(true);
    await open(c);
    expect(labels()).toEqual(['VF · 1080p', 'VF · 1080p']);
    radios()[1].click();
    await vi.waitFor(() => expect(c.sendSource).toHaveBeenCalledTimes(1));
  });

  it('les identifiants opaques des lignes repartent de s1 à chaque ouverture du salon (LAST-1615)', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, EN_720]));
    await open(fakeClient(false));
    expect(radios().map((r) => r.dataset.key)).toEqual(['s1', 's2']);
    mocks.loadSources.mockResolvedValue(loadedOf([EN_720]));
    partyBridge.client = fakeClient(false);
    await mod.openLobby('r1');
    await vi.waitFor(() => expect(radios().map((r) => r.dataset.key)).toEqual(['s1']));
  });

  it('clavier : flèches entre les sources, le focus reste sur la source choisie après chaque nouveau rendu', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, FR_720, EN_720]));
    const c = fakeClient(false);
    await open(c);
    const first = radios()[0];
    expect(first.tabIndex).toBe(0);
    expect(radios()[1].tabIndex).toBe(-1);
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => expect(checked()).toEqual(['VF · 720p']));
    // La ligne choisie garde sa place : le focus reste dessus.
    await vi.waitFor(() => expect(document.activeElement).toBe(radios()[1]));
    expect(radios()[1].tabIndex).toBe(0);
    expect(labels()).toEqual(['VF · 1080p', 'VF · 720p', 'VO EN · 720p']);
    // Une flèche de plus atteint la 3e ligne (elle ne revient pas sur la première).
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => expect(checked()).toEqual(['VO EN · 720p']));
    await vi.waitFor(() => expect(document.activeElement).toBe(radios()[2]));
    // Une mise à jour de l’hôte repeint l’écran : le focus reste sur la même source.
    c.participants[0].quality = 'VF · 1080p';
    c.emit('participants', c.participants);
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-host')).not.toBeNull());
    expect(document.activeElement).toBe(radios()[2]);
  });

  it('la ligne cliquée ne change pas de position (LAST-1615)', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, FR_720, EN_720]));
    await open(fakeClient(false));
    radios()[2].click();
    await vi.waitFor(() => expect(checked()).toEqual(['VO EN · 720p']));
    expect(labels()).toEqual(['VF · 1080p', 'VF · 720p', 'VO EN · 720p']);
  });

  it('un nouveau sondage ne déplace pas les lignes déjà affichées (LAST-1615)', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_720], ['torrentio']));
    mocks.pollSources.mockResolvedValue(loadedOf([FR_1080, FR_720]));
    await open(fakeClient(false));
    expect(labels()).toEqual(['VF · 720p']);
    await vi.waitFor(() => expect(labels()).toEqual(['VF · 720p', 'VF · 1080p']), { timeout: 4500, interval: 100 });
  }, 8000);
});

const clickLabel = (text: string) => radios().find((r) => r.querySelector('b')!.textContent === text)!.click();
/** Vues du chargement dont les sources de `urls` ne passent pas dans le navigateur (son DTS / TrueHD). */
const blockedLoaded = (streams: unknown[], urls: string[]) => {
  const l = loadedOf(streams);
  return { ...l, views: l.views.map((v) => (urls.includes(v.stream.url as string) ? { ...v, appAudio: 'unsupported' as const } : v)) };
};

describe('salon d’attente : départ synchronisé (LAST-1615)', () => {
  async function setup() {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080]));
    const c = fakeClient(false);
    let now = 10_000;
    c.serverNow = () => now;
    const launchRoom = vi.spyOn(partyBridge, 'launchRoom').mockResolvedValue(undefined);
    await open(c);
    return { c, launchRoom, setNow: (t: number) => { now = t; } };
  }

  it('countdown null puis state en lecture : le départ retient la lecture, une seule fois', async () => {
    const { c, launchRoom, setNow } = await setup();
    c.countdownAt = 12_000;
    c.emit('countdown', 12_000);
    setNow(12_050);
    c.countdownAt = null;
    c.state = { playing: true, pos: 0, at: 12_000, rev: 2 };
    c.emit('countdown', null);
    c.emit('state', c.state);
    expect(launchRoom).toHaveBeenCalledTimes(1);
    expect(launchRoom.mock.calls[0][1]).toEqual({ hold: true });
  });

  it('countdown null sans state (un participant a envoyé buf false avant l’alarme) : le départ a lieu quand même, avec retenue', async () => {
    const { c, launchRoom, setNow } = await setup();
    c.countdownAt = 12_000;
    c.emit('countdown', 12_000);
    setNow(12_020);
    c.countdownAt = null;
    c.emit('countdown', null);
    expect(launchRoom).toHaveBeenCalledTimes(1);
    expect(launchRoom.mock.calls[0][1]).toEqual({ hold: true });
  });

  it('compte à rebours annulé par l’hôte avant l’échéance : rien ne part', async () => {
    const { c, launchRoom, setNow } = await setup();
    c.countdownAt = 15_000;
    c.emit('countdown', 15_000);
    setNow(11_000);
    c.countdownAt = null;
    c.emit('countdown', null);
    expect(launchRoom).not.toHaveBeenCalled();
  });

  it('arrivée en cours de film : le départ ne retient rien', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080]));
    const c = fakeClient(false);
    c.state = { playing: true, pos: 600, at: Date.now(), rev: 5 };
    const launchRoom = vi.spyOn(partyBridge, 'launchRoom').mockResolvedValue(undefined);
    partyBridge.client = c;
    await mod.openLobby('r1');
    expect(launchRoom).toHaveBeenCalledTimes(1);
    expect(launchRoom.mock.calls[0][1]).toEqual({ hold: false });
  });
});

describe('salon d’attente : critères de la source (LAST-1615)', () => {
  it('départ pendant la recherche, sans choix explicite, avec un repli hors langue : la recherche reprend (aucune source imposée)', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([EN_720], ['torrentio']));
    mocks.pollSources.mockReturnValue(new Promise(() => undefined));
    const c = fakeClient(false);
    const launchRoom = vi.spyOn(partyBridge, 'launchRoom').mockResolvedValue(undefined);
    await open(c);
    c.state = { playing: true, pos: 0, at: 0, rev: 2 };
    c.emit('state', c.state);
    expect(launchRoom).toHaveBeenCalledTimes(1);
    expect(launchRoom.mock.calls[0][0]).toBeNull();
  });

  it('navigateur : une source qui ne passe pas n’est jamais présélectionnée d’office', async () => {
    mocks.loadSources.mockResolvedValue(blockedLoaded([FR_1080, FR_720], [FR_1080.url]));
    await open(fakeClient(false));
    expect(checked()).toEqual(['VF · 720p']);
    expect(lobby()!.querySelector('.pl-src-compat')!.textContent).toContain('Son DTS / TrueHD');
  });

  it('navigateur : le choix explicite d’une source qui ne passe pas reste possible (avertissement sur la ligne)', async () => {
    mocks.loadSources.mockResolvedValue(blockedLoaded([FR_1080, FR_720], [FR_1080.url]));
    await open(fakeClient(false));
    clickLabel('VF · 1080p');
    await vi.waitFor(() => expect(checked()).toEqual(['VF · 1080p']));
    expect(radios()[0].textContent).toContain('Son DTS / TrueHD');
  });

  it('navigateur : si aucune source ne passe, la liste entière sert de repli', async () => {
    mocks.loadSources.mockResolvedValue(blockedLoaded([FR_1080, FR_720], [FR_1080.url, FR_720.url]));
    await open(fakeClient(false));
    expect(checked()).toEqual(['VF · 1080p']);
  });

  it('aucun lien dans le DOM : l’identifiant des lignes est opaque', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, EN_720]));
    await open(fakeClient(false));
    const html = lobby()!.querySelector('.pl-src')!.outerHTML;
    expect(html).not.toMatch(/https?:|\/play\/|u:/);
    expect(radios().every((r) => /^s\d+$/.test(r.dataset.key ?? ''))).toBe(true);
  });

  it('le compteur annonce les sources jouables, pas les 8 lignes affichées', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf(Array.from({ length: 10 }, (_, i) => stream(i + 1))));
    await open(fakeClient(false));
    expect(radios()).toHaveLength(8);
    await vi.waitFor(() => expect(lobby()!.querySelector('.pl-src-status')!.textContent).toBe('10 sources trouvées'));
  });
});

describe('salon d’attente : envois au salon (LAST-1615)', () => {
  it('sélections enchaînées : seul le dernier choix part au salon, après environ 300 ms', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, FR_720, EN_720]));
    const c = fakeClient(false);
    await open(c);
    c.sendReady.mockClear();
    c.sendStatus.mockClear();
    clickLabel('VF · 720p');
    await vi.waitFor(() => expect(checked()).toEqual(['VF · 720p']));
    clickLabel('VO EN · 720p');
    await vi.waitFor(() => expect(checked()).toEqual(['VO EN · 720p']));
    expect(c.sendReady).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(c.sendReady).toHaveBeenCalledWith(true, 'VO EN · 720p'));
    expect(c.sendReady).toHaveBeenCalledTimes(1);
    expect(c.sendStatus).toHaveBeenCalledTimes(1);
  });

  it('touche fléchée maintenue : la répétition est ignorée', async () => {
    mocks.loadSources.mockResolvedValue(loadedOf([FR_1080, FR_720, EN_720]));
    await open(fakeClient(false));
    const first = radios()[0];
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, repeat: true }));
    await new Promise((r) => setTimeout(r, 60));
    expect(checked()).toEqual(['VF · 1080p']);
  });
});
