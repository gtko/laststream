// Actions rejouables (ODY-257) : verrou des actions du menu contextuel, clé de verrou par saison, retour arrière de l'écriture
// bibliothèque quand le serveur refuse. Jsdom, aucun réseau réel.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mark: vi.fn() }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/ui/watched.js', async (orig) => ({ ...(await orig<typeof import('../src/ui/watched.js')>()), mark: h.mark }));

const BASE = 'http://localhost:7000';
const PROFILE = { id: 'p', name: 'Greg' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let ctx: typeof import('../src/ui/ctxmenu.js');
let busy: typeof import('../src/ui/busy.js');
let watched: typeof import('../src/ui/watched.js');
let state: typeof import('../src/ui/state.js').state;
let ServerUserStore: typeof import('../src/data/serverUserStore').ServerUserStore;
let SETTINGS_STORAGE_KEY: string;
let reloadSettings: () => void;
let reloadSession: () => void;
let setSession: (token: string, expiresAt: string, name: string) => void;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  busy = await import('../src/ui/busy.js');
  watched = await import('../src/ui/watched.js');
  ({ state } = await import('../src/ui/state.js'));
  ({ ServerUserStore } = await import('../src/data/serverUserStore'));
  ({ SETTINGS_STORAGE_KEY, reloadSettings } = await import('../src/data/config'));
  ({ reloadSession, setSession } = await import('../src/data/session'));
  (state as any).byKey.set('movie:5', { key: 'movie:5', id: 5, name: 'Alien', type: 'movie' });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  busy.resetBusy();
  h.mark.mockReset();
  localStorage.clear();
});
afterEach(() => { ctx.closeCtx(false); vi.useRealTimers(); vi.unstubAllGlobals(); });

const movieT = { kind: 'title', key: 'movie:5', el: document.body };
const choose = (id: string) => {
  ctx.openCtx(movieT as never, 10, 10);
  (document.querySelector('.ctxmenu [data-ctx="' + id + '"]') as HTMLElement).click();
};

describe('menu contextuel : verrou des bascules', () => {
  it('« Marquer comme vu » choisi deux fois de suite n’écrit qu’une fois, puis de nouveau après le délai', () => {
    choose('seen');
    choose('seen');
    expect(h.mark).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(busy.TOGGLE_COOLDOWN_MS + 1);
    choose('seen');
    expect(h.mark).toHaveBeenCalledTimes(2);
  });

  it('la clé de verrou distingue la cible et l’action (deux épisodes ne se bloquent pas)', () => {
    const model = { key: 'tv:9' };
    const k = (season: number, episode: number) => ctx.ctxLockKey({ kind: 'episode', model, season, episode } as never, 'seen');
    expect(k(1, 2)).not.toBe(k(1, 3));
    expect(k(1, 2)).not.toBe(k(2, 2));
    expect(ctx.ctxLockKey(movieT as never, 'seen')).not.toBe(ctx.ctxLockKey(movieT as never, 'lib'));
  });
});

describe('« Marquer la saison » : une clé par saison', () => {
  it('marquer la saison 2 juste après la 1 n’est pas ignoré, la même saison deux fois si', () => {
    const fn = vi.fn();
    const once = (season: number) => busy.runOnce(watched.seasonLockKey('tv:9', season), fn, { cooldown: busy.TOGGLE_COOLDOWN_MS });
    once(1);
    once(2);
    expect(fn).toHaveBeenCalledTimes(2);
    once(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('écriture bibliothèque : retour arrière si le serveur refuse', () => {
  const ENTRY = { id: 7, type: 'movie' as const, title: 'Titre 7', poster: '', year: '' };
  async function store(put: () => Response | Promise<Response>) {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'x' }));
    reloadSettings();
    reloadSession();
    setSession('T'.repeat(30), new Date(Date.now() + 1e9).toISOString(), 'greg');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/library/.test(new URL(url).pathname) && init?.method && init.method !== 'GET') return put();
      return json({ items: [] });
    }));
    const s = new ServerUserStore([PROFILE], PROFILE);
    await s.hydrate();
    return s;
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it('ajout refusé (HTTP 500) : le titre disparaît de la bibliothèque', async () => {
    const s = await store(() => json({ error: 'server' }, 500));
    expect(s.toggleLibrary(ENTRY)).toBe(true);
    expect(s.inLibrary('movie:7')).toBe(true); // affichage immédiat
    await flush();
    expect(s.inLibrary('movie:7')).toBe(false);
  });

  it('retrait refusé (HTTP 500) : le titre revient', async () => {
    let refuse = false;
    const s = await store(() => (refuse ? json({ error: 'server' }, 500) : json({})));
    s.addToLibrary(ENTRY);
    await flush();
    refuse = true;
    s.removeFromLibrary('movie:7');
    expect(s.inLibrary('movie:7')).toBe(false);
    await flush();
    expect(s.inLibrary('movie:7')).toBe(true);
  });

  it('retrait refusé après un changement de profil : rien n’est réinjecté dans la bibliothèque du nouveau profil', async () => {
    let refuse = false;
    const other = { id: 'q', name: 'Léo' };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'x' }));
    reloadSettings();
    reloadSession();
    setSession('T'.repeat(30), new Date(Date.now() + 1e9).toISOString(), 'greg');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (/\/library/.test(new URL(url).pathname) && init?.method && init.method !== 'GET') return refuse ? json({ error: 'server' }, 500) : json({});
      return json({ items: [] });
    }));
    const s = new ServerUserStore([PROFILE, other], PROFILE);
    await s.hydrate();
    s.addToLibrary(ENTRY);
    await flush();
    refuse = true;
    s.removeFromLibrary('movie:7');
    s.setProfile('q');
    await flush();
    expect(s.inLibrary('movie:7')).toBe(false);
  });

  it('réseau coupé : l’ajout reste affiché (comportement hors ligne inchangé)', async () => {
    const s = await store(() => { throw new TypeError('Failed to fetch'); });
    s.addToLibrary(ENTRY);
    await flush();
    expect(s.inLibrary('movie:7')).toBe(true);
  });
});
