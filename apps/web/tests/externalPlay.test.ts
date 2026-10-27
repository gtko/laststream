// Lecteur externe (LAST-495 L3) : court-circuit avant la sonde et le moteur, repli iOS après une erreur du lecteur intégré,
// écran externe (ouvrir, changer de lecteur, « Marquer comme vu ») et aucune écriture de progression.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { getExternalPlayer, setExternalPlayer } from '../src/data/prefs';

const ext = vi.hoisted(() => ({
  launch: vi.fn((_plan: unknown) => true),
  mark: vi.fn(async (_key: string, _refs: unknown, _watched: boolean) => true),
  setProgress: vi.fn((_entry: unknown) => undefined),
}));

vi.mock('../src/player/external', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/player/external')>();
  return { ...mod, launch: ext.launch };
});
vi.mock('../src/ui/watched.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ui/watched.js')>();
  return { ...mod, mark: ext.mark };
});
vi.mock('../src/data/userStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/data/userStore')>();
  const userStore = new Proxy(mod.userStore, { get: (t, prop, r) => (prop === 'setProgress' ? ext.setProgress : Reflect.get(t, prop, r)) });
  return { ...mod, userStore };
});
vi.mock('../src/player/server', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/player/server')>();
  return { ...mod, fetchProbe: vi.fn(mod.fetchProbe) };
});
vi.mock('../src/player/engine', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/player/engine')>();
  return { ...mod, chooseEngine: vi.fn(mod.chooseEngine) };
});
vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: async () => 50_000 };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { clearSourceCache } = await import('../src/sources/load');
const { loadAddonSources } = await import('../src/sources/addonSources');
// Lecture de l'état de session : la session est ouverte dans chaque test (pas de null à ce moment).
const { S } = (await import('../src/player/sessionState.js')) as unknown as {
  S: { ui: { video: HTMLVideoElement; root: HTMLElement }; P: { engine: unknown }; html: { emit(ev: string, err: Error): void } };
};
const { saveProgress, stopTicks } = await import('../src/player/sessionTick.js');
const { fetchProbe } = await import('../src/player/server');
const { chooseEngine } = await import('../src/player/engine');
const { closePlayer } = await import('../src/player/session.js');

const STREAM_URL = 'https://addon.test/stream/anime/fk%3A123.json';
const CDN = 'https://cdn.test/ep1';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** Titre d'addon (séance « addon » : pas de « vu » côté serveur). */
const REQUEST = {
  type: 'tv', id: 'fk:123', name: 'Anime test', key: 'addon:anime:fk:123', season: 1, episode: 1,
  addon: { key: 'https://addon.test', base: 'https://addon.test', type: 'anime', id: 'fk:123', title: 'Anime test', videos: [{ id: 'fk:123:1:1', season: 1, episode: 1 }] },
};
/** Série hors addon : le « vu » passe par la clé de la série. */
const SERIE = { type: 'tv', id: '1399', name: 'Série test', key: 'tv:1399', season: 1, episode: 1 };

/** En-têtes exigés par l'hébergeur : la lecture passe alors par le proxy du serveur (`media.proxied`). */
const PROXY_HINTS = { proxyHeaders: { request: { Referer: 'https://ref.test/' } } };

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};
type Agent = keyof typeof UA;

let streams: Array<Record<string, unknown>> = [];

/** Navigateur simulé : iPhone, Android, ou le jsdom par défaut. */
function useAgent(agent: Agent) {
  const nav = window.navigator;
  Object.defineProperty(nav, 'userAgent', { configurable: true, get: () => UA[agent] });
  Object.defineProperty(nav, 'platform', { configurable: true, get: () => (agent === 'iphone' ? 'iPhone' : 'Linux armv8l') });
  Object.defineProperty(nav, 'maxTouchPoints', { configurable: true, get: () => 5 });
}
function resetAgent() {
  const nav = window.navigator as unknown as Record<string, unknown>;
  for (const k of ['userAgent', 'platform', 'maxTouchPoints']) delete nav[k];
}

/**
 * Ouvre une source de l'addon (ou d'une série hors addon) avec le flux donné. `hints` complète les `behaviorHints` de la vue : la lecture
 * d'un appareil (normalizeDeviceStream) ne garde pas `proxyHeaders`, c'est le cas d'un flux livré par le serveur qu'on simule ici.
 */
async function start(stream: Record<string, unknown>, request: Record<string, unknown> = REQUEST, hints: Record<string, unknown> = {}) {
  streams = [{ name: 'Direct', title: 'Anime 1080p\ncdn', ...stream }];
  const views = await loadAddonSources({ manifestUrl: 'https://addon.test/manifest.json', name: 'Addon' }, 'anime', 'fk:123');
  views[0].stream.behaviorHints = { ...views[0].stream.behaviorHints, ...hints };
  const { playSource } = await import('../src/player/session.js');
  await playSource(request, views, views[0], null, { resume: 'none' });
}

const videoSrc = () => S.ui.video.getAttribute('src');
const errorTitle = () => S.ui.root.querySelector('.lp-err-title')?.textContent;
const errorMsg = () => S.ui.root.querySelector('.lp-err-msg')?.textContent;
const hrefs = () => ext.launch.mock.calls.map((c) => (c[0] as { href?: string }).href);
function click(sel: string) {
  const el = S.ui.root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error('bouton absent : ' + sel);
  el.click();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = () => Promise.resolve();
  proto.pause = () => undefined;
  proto.load = () => undefined;
  ext.launch.mockClear(); ext.mark.mockClear(); ext.setProgress.mockClear();
  vi.mocked(fetchProbe).mockClear();
  vi.mocked(chooseEngine).mockClear();
  // Le serveur répond (proxy possible) ; toute autre adresse échoue.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === STREAM_URL) return json({ streams });
    if (String(url).endsWith('/settings')) return json({});
    throw new Error('appel inattendu ' + url);
  }));
});
afterEach(() => {
  closePlayer();
  stopTicks();
  resetAgent();
  vi.unstubAllGlobals();
});

describe('court-circuit avant la sonde et le moteur (LAST-495 L3)', () => {
  it('vlc sur iPhone : écran externe, lancement vlc-x-callback, ni sonde ni moteur', async () => {
    useAgent('iphone');
    setExternalPlayer('vlc');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalledTimes(1));
    expect(ext.launch.mock.calls[0][0]).toEqual({ kind: 'href', href: expect.stringMatching(/^vlc-x-callback:\/\/x-callback-url\/stream\?url=/) });
    expect(fetchProbe).not.toHaveBeenCalled();
    expect(chooseEngine).not.toHaveBeenCalled();
    expect(videoSrc()).toBeNull();
    expect(S.P.engine).toBeNull();
    expect(errorTitle()).toBe('S1 · E1');
    expect(S.ui.root.querySelector('[data-act="ext-seen"]')).toBeNull(); // titre d'addon : pas de « vu »
  });

  it('réglage « intégré » : chemin inchangé, la vidéo démarre et rien ne s’ouvre à l’extérieur', async () => {
    useAgent('iphone');
    setExternalPlayer('builtin');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(videoSrc()).toBe(`${CDN}.mp4`));
    expect(chooseEngine).toHaveBeenCalled();
    expect(ext.launch).not.toHaveBeenCalled();
  });

  it('iPhone « auto » + MKV : lecteur externe, sans sonde', async () => {
    useAgent('iphone');
    await start({ url: `${CDN}.mkv` });
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalledTimes(1));
    expect(hrefs()[0]).toMatch(/^vlc-x-callback:\/\//);
    expect(chooseEngine).not.toHaveBeenCalled();
  });

  it('iPhone « auto » + MP4 : lecture intégrée', async () => {
    useAgent('iphone');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(videoSrc()).toBe(`${CDN}.mp4`));
    expect(ext.launch).not.toHaveBeenCalled();
  });

  it('lien proxifié + lecteur externe sur iPhone : message d’erreur, aucun lancement', async () => {
    useAgent('iphone');
    setExternalPlayer('vlc');
    await start({ url: `${CDN}.mp4` }, REQUEST, PROXY_HINTS);
    await vi.waitFor(() => expect(errorMsg()).toContain('passe par notre serveur'));
    expect(ext.launch).not.toHaveBeenCalled();
    expect(chooseEngine).not.toHaveBeenCalled();
  });

  it('lien proxifié hors iPhone : lecture intégrée (proxy), aucun lancement externe', async () => {
    useAgent('android');
    setExternalPlayer('intent');
    await start({ url: `${CDN}.mp4` }, REQUEST, PROXY_HINTS);
    await vi.waitFor(() => expect(videoSrc()).toContain('/proxy/'));
    expect(ext.launch).not.toHaveBeenCalled();
  });
});

describe('repli iPhone après une erreur du lecteur intégré', () => {
  it('media-error:4 sur iPhone « auto » : écran externe, sans changer de source', async () => {
    useAgent('iphone');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(videoSrc()).toBe(`${CDN}.mp4`));
    S.html.emit('error', new Error('media-error:4'));
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalledTimes(1));
    expect(hrefs()[0]).toMatch(/^vlc-x-callback:\/\//); // préféré par défaut
    expect(errorTitle()).toBe('S1 · E1');
    expect(S.P.engine).toBeNull();
  });
});

describe('écran externe', () => {
  it('aucune écriture de progression pendant la lecture externe', async () => {
    useAgent('iphone');
    setExternalPlayer('vlc');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalled());
    saveProgress(true);
    expect(ext.setProgress).not.toHaveBeenCalled();
  });

  it('« Marquer comme vu » : mark avec la clé de la série et l’épisode courant', async () => {
    useAgent('iphone');
    setExternalPlayer('vlc');
    await start({ url: `${CDN}.mkv` }, SERIE);
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalled());
    click('[data-act="ext-seen"]');
    await vi.waitFor(() => expect(ext.mark).toHaveBeenCalledWith('tv:1399', [{ season: 1, episode: 1 }], true));
  });

  it('« Changer de lecteur » : choix ponctuel, le réglage reste vlc', async () => {
    useAgent('iphone');
    setExternalPlayer('vlc');
    await start({ url: `${CDN}.mp4` });
    await vi.waitFor(() => expect(ext.launch).toHaveBeenCalledTimes(1));
    click('[data-act="ext-other"]');
    click('[data-act="ext-pick:infuse"]');
    expect(ext.launch).toHaveBeenCalledTimes(2);
    expect(hrefs()[1]).toMatch(/^infuse:\/\/x-callback-url\/play\?url=/);
    expect(S.ui.root.querySelector('.lp-err-msg')?.textContent).toBe('Lecture dans Infuse…');
    expect(getExternalPlayer()).toBe('vlc');
  });
});
