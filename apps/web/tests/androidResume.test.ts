// Lecteur natif Android et retour à l'accueil : la progression écrite à la fermeture du lecteur ne doit pas être effacée
// par une relecture du compte qui part avant l'arrivée de l'écriture, et l'accueil relit le compte dès le retour de l'app.
// Jsdom, aucun réseau réel : le compte lastAddon et le plugin natif sont simulés.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const player = vi.hoisted(() => ({ open: false }));
const remote = vi.hoisted(() => ({ refreshRemote: vi.fn(async (): Promise<void> => undefined) }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/player/sessionLoader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/player/sessionLoader.js')>()),
  isPlayerOpen: () => player.open,
}));
vi.mock('../src/data/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/auth')>()),
  refreshRemote: remote.refreshRemote,
}));

const T0 = Date.parse('2026-10-19T10:00:00Z');
const BASE = 'http://localhost:7000';
const PROFILE = { id: 'p', name: 'Greg' };
const ENTRY = { key: 'movie:551', type: 'movie' as const, id: 551, title: 'Titre 551', poster: '/p.jpg', backdrop: '/b.jpg', position: 1200, duration: 6000 };

let userStore: typeof import('../src/data/userStore').userStore;
let events: typeof import('../src/data/events');
let state: typeof import('../src/ui/state.js').state;
let home: typeof import('../src/ui/home.js');
let ServerUserStore: typeof import('../src/data/serverUserStore').ServerUserStore;
let NativeEngine: typeof import('../src/player/engines.js').NativeEngine;
let resetFiltersCache: typeof import('../src/data/homeFilters').resetFiltersCache;
let SETTINGS_STORAGE_KEY: string;
let reloadSettings: () => void;
let reloadSession: () => void;
let setSession: (token: string, expiresAt: string, name: string) => void;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ userStore } = await import('../src/data/userStore'));
  events = await import('../src/data/events');
  ({ state } = await import('../src/ui/state.js'));
  home = await import('../src/ui/home.js');
  ({ ServerUserStore } = await import('../src/data/serverUserStore'));
  ({ NativeEngine } = await import('../src/player/engines.js'));
  ({ resetFiltersCache } = await import('../src/data/homeFilters'));
  ({ SETTINGS_STORAGE_KEY, reloadSettings } = await import('../src/data/config'));
  ({ reloadSession, setSession } = await import('../src/data/session'));
});

beforeEach(() => {
  localStorage.clear();
  resetFiltersCache();
  remote.refreshRemote.mockClear();
  player.open = false;
  state.inDetail = false;
  state.status = 'ready';
  const app = document.getElementById('app')!;
  app.hidden = false;
  app.innerHTML = '<div id="cont-slot"></div><div id="lib-slot"></div>';
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'x' }));
  reloadSettings();
  reloadSession();
  setSession('T'.repeat(30), new Date(T0 + 1e9).toISOString(), 'greg');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Compte lastAddon simulé : une progression n'est visible du serveur qu'une fois son écriture reçue. */
function fakeAccount(opts: { gate?: Promise<void>; down?: () => boolean } = {}) {
  const acc = { items: [] as Array<Record<string, unknown>>, puts: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.method === 'PUT' && /\/progress$/.test(u.pathname)) {
      acc.puts += 1;
      await opts.gate;
      if (opts.down?.()) return json({ error: 'network' }, 503);
      const b = JSON.parse(String(init.body));
      acc.items = [{ type: b.type, tmdbId: b.tmdbId, positionSec: b.positionSec, durationSec: b.durationSec, updatedAt: new Date(T0).toISOString() }];
      return json({});
    }
    if (/\/continue$/.test(u.pathname)) return json({ items: acc.items });
    if (/\/library$/.test(u.pathname)) return json({ items: [] });
    const m = /\/lt\/tmdb\/(movie|tv)\/(\d+)$/.exec(u.pathname);
    if (m) return json({ id: Number(m[2]), title: 'Titre ' + m[2], name: 'Titre ' + m[2], poster_path: '/p.jpg', backdrop_path: '/b.jpg' });
    return json({ error: 'not_found' }, 404);
  }));
  return acc;
}

const keys = (s: InstanceType<typeof ServerUserStore>) => s.continueWatching().map((e) => e.key);

describe('compte : la relecture ne défait pas l’écriture de fin de lecture', () => {
  it('relecture lancée pendant l’envoi de la progression : le titre reste jusqu’à l’acquittement du serveur', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fakeAccount({ gate });
    const s = new ServerUserStore([PROFILE], PROFILE);
    await s.hydrate();
    s.setProgress(ENTRY); // fermeture du lecteur : l'écriture part, le serveur ne la tient pas encore
    const relecture = s.refresh(); // l'accueil relit le compte aussitôt
    release();
    await relecture;
    expect(keys(s)).toEqual(['movie:551']);
  });

  it('écriture refusée : la progression reste affichée et part à la relecture suivante', async () => {
    let down = true;
    const acc = fakeAccount({ down: () => down });
    const s = new ServerUserStore([PROFILE], PROFILE);
    await s.hydrate();
    s.setProgress(ENTRY);
    await s.refresh();
    expect(keys(s)).toEqual(['movie:551']);
    down = false;
    await s.refresh();
    expect(acc.items).toHaveLength(1);
    expect(keys(s)).toEqual(['movie:551']);
  });
});

/** Plugin natif simulé : `fire` joue un évènement émis par libVLC (`state`, `progress`, `closed`…). */
function fakeNativePlugin() {
  const handlers = new Map<string, (d: unknown) => void>();
  const plugin = {
    addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { plugin, fire: (ev: string, d: unknown) => handlers.get(ev)?.(d) };
}

const card = (key: string) => document.querySelector<HTMLElement>('#cont-slot .cont-card[data-resume="' + key + '"]');

describe('lecteur natif simulé : progression → « Reprendre la lecture »', () => {
  it('position et durée remontées par libVLC : la progression est enregistrée et la rangée la montre', async () => {
    const { plugin, fire } = fakeNativePlugin();
    const engine = new NativeEngine(plugin as never);
    await engine.load({ url: 'http://x/a.mkv', startAt: 0, open: { title: 'Titre 551' } } as never);
    fire('state', { position: 0, duration: 0, paused: false, buffering: true, rate: 1 }); // durée pas encore connue
    fire('state', { position: 1200, duration: 6000, paused: false, buffering: false, rate: 1 });
    fire('progress', { position: 1210, duration: 6000 });
    const st = engine.state();
    // Ce que la session écrit à chaque sauvegarde, à partir de la position et de la durée du moteur :
    userStore.setProgress({ key: 'movie:551', type: 'movie', id: 551, title: 'Titre 551', poster: '/p.jpg', backdrop: '/b.jpg', position: st.time, duration: st.duration });
    home.renderContinue();
    expect(card('movie:551')).not.toBeNull();
    expect(card('movie:551')!.querySelector('.cont-left')!.textContent).toContain('20 %');
  });

  it('fermeture du lecteur natif : la position de l’évènement « closed » est celle qui est enregistrée', async () => {
    const { plugin, fire } = fakeNativePlugin();
    const engine = new NativeEngine(plugin as never);
    await engine.load({ url: 'http://x/a.mkv', startAt: 0, open: { title: 'Titre 551' } } as never);
    fire('state', { position: 300, duration: 6000, paused: false, buffering: false, rate: 1 });
    fire('closed', { position: 3000, duration: 6000 });
    expect(engine.state().time).toBe(3000);
    expect(engine.state().duration).toBe(6000);
  });
});

describe('accueil : relecture du compte au retour de l’app et à la fermeture du lecteur', () => {
  it('fermeture du lecteur : relecture aussitôt', () => {
    events.emitDataEvent({ kind: 'player' });
    expect(remote.refreshRemote).toHaveBeenCalledTimes(1);
  });

  it('retour de l’app (évènement « resume » du document, émis par Capacitor) : relecture aussitôt', () => {
    document.dispatchEvent(new Event('resume'));
    expect(remote.refreshRemote).toHaveBeenCalledTimes(1);
  });

  it('une fermeture arrivée pendant une relecture en cours : une seule relecture de plus, pas une par évènement', async () => {
    let finish!: () => void;
    remote.refreshRemote.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    document.dispatchEvent(new Event('resume')); // retour de l'app : relecture en cours
    events.emitDataEvent({ kind: 'player' }); // fermeture pendant la relecture
    events.emitDataEvent({ kind: 'player' });
    expect(remote.refreshRemote).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(remote.refreshRemote).toHaveBeenCalledTimes(2));
  });
});
