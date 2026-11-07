// Vue TV de l'écran Téléchargements (ODY-234) : détection de l'appareil, navigation D-pad entre rangées, action au OK,
// rendu mobile/bureau inchangé hors TV. Service mocké.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mgr = { pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), remove: vi.fn(() => Promise.resolve()), pauseAll: vi.fn(), resumeAll: vi.fn(), list: vi.fn(() => []) };
  return { mgr, native: false, items: [] as unknown[] };
});

vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => h.native } };
});
vi.mock('../src/downloads/service', () => ({
  downloadDestination: () => 'app',
  platformAvailability: () => ({ ok: true }),
  getDownloads: vi.fn(() => Promise.resolve(h.mgr)),
  subscribeDownloads: vi.fn((fn: (items: unknown[]) => void) => { fn(h.items); return vi.fn(); }),
  listDownloads: () => h.items,
  getSpace: vi.fn(() => Promise.resolve({ used: 1, limit: 10, ratio: 0.1, warn: false, full: false })),
  persistStorage: vi.fn(() => Promise.resolve(true)),
  purgeAll: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/player/sessionLoader.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

type Item = { id: string; metaId: string; title: string; state: string; bytesDone: number; bytesTotal: number; source: { copies: never[] } };
const item = (id: string, state: string): Item => ({ id, metaId: id, title: 'Titre ' + id, state, bytesDone: 620, bytesTotal: 1000, source: { copies: [] } });

const setUA = (ua: string) => Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
const setPointerNone = (none: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: none && q.includes('pointer: none'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.hidden = false;
  // jsdom n'a pas de mise en page : tout élément compte comme visible pour la navigation spatiale.
  HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
});

beforeEach(() => {
  h.native = false;
  h.items = [];
  localStorage.clear();
  delete document.documentElement.dataset.device;
  setPointerNone(false);
  setUA('Mozilla/5.0 (Windows NT 10.0) Chrome/120');
});

afterEach(async () => {
  const { teardownDownloads } = await import('../src/ui/downloads.js');
  teardownDownloads();
  localStorage.clear();
});

const detail = () => document.getElementById('detail')!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const open = async () => {
  const { showDownloads } = await import('../src/ui/downloads.js');
  await showDownloads();
  await flush();
};

describe('isTvDevice', () => {
  it('faux sur le web ordinaire, même avec un agent de télévision', async () => {
    const { isTvDevice } = await import('../src/ui/device.js');
    expect(isTvDevice()).toBe(false);
    setUA('Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit');
    expect(isTvDevice()).toBe(false);
  });

  it('vrai sur Android natif avec un agent de TV, faux avec un téléphone', async () => {
    const { isTvDevice } = await import('../src/ui/device.js');
    h.native = true;
    setUA('Mozilla/5.0 (Linux; Android 11; Pixel 7) Mobile');
    expect(isTvDevice()).toBe(false);
    for (const ua of ['Android TV', 'GoogleTV', 'AFTMM Build', 'BRAVIA', 'SMART-TV']) {
      setUA('Mozilla/5.0 (Linux; ' + ua + ') AppleWebKit');
      expect(isTvDevice()).toBe(true);
    }
  });

  it('vrai sur Android natif sans pointeur (pointer: none)', async () => {
    const { isTvDevice } = await import('../src/ui/device.js');
    h.native = true;
    setUA('Mozilla/5.0 (Linux; Android 11; Pixel 7) Mobile');
    setPointerNone(true);
    expect(isTvDevice()).toBe(true);
    h.native = false;
    expect(isTvDevice()).toBe(false);
  });

  it('forçage par localStorage, et applyDeviceMode pose data-device', async () => {
    const { isTvDevice, applyDeviceMode } = await import('../src/ui/device.js');
    applyDeviceMode();
    expect(document.documentElement.dataset.device).toBeUndefined();
    localStorage.setItem('laststream.ui.tv', '1');
    expect(isTvDevice()).toBe(true);
    applyDeviceMode();
    expect(document.documentElement.dataset.device).toBe('tv');
    localStorage.setItem('laststream.ui.tv', '0');
    applyDeviceMode();
    expect(document.documentElement.dataset.device).toBeUndefined();
  });

  it('un stockage inaccessible ne casse rien', async () => {
    const { isTvDevice } = await import('../src/ui/device.js');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(isTvDevice()).toBe(false);
    spy.mockRestore();
  });
});

describe('#/downloads en vue TV', () => {
  beforeEach(() => {
    localStorage.setItem('laststream.ui.tv', '1');
    h.items = [item('movie:1', 'running'), item('movie:2', 'done'), item('movie:3', 'done')];
  });

  it('le focus arrive sur la première action, les rangées sont des groupes data-nav, l’indication des touches est là', async () => {
    await open();
    const first = detail().querySelector('[data-dl-row="movie:1"] [data-dl-act]');
    expect(document.activeElement).toBe(first);
    expect(detail().querySelectorAll('[data-dl-row][data-nav]')).toHaveLength(3);
    expect(detail().querySelector('.dl-tv-hint')?.textContent).toBe('OK : choisir · Retour : fermer');
  });

  it('un nouveau rendu ne vole pas le focus : un bouton de l’en-tête le garde', async () => {
    await open();
    const head = detail().querySelector('.dl-head-acts')!;
    const btn = head.querySelector('button') as HTMLElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    const { subscribeDownloads } = await import('../src/downloads/service');
    const fn = vi.mocked(subscribeDownloads).mock.calls.at(-1)![0] as (items: unknown[]) => void;
    h.items = [item('movie:1', 'done'), item('movie:2', 'done'), item('movie:3', 'done')]; // signature changée : redessin
    fn(h.items);
    await flush();
    const now = document.activeElement as HTMLElement;
    expect(now.closest('.dl-head-acts')).not.toBeNull();
    expect(now.closest('[data-dl-row]')).toBeNull();
  });

  it('ArrowDown passe d’une rangée à l’autre, ArrowUp revient', async () => {
    await open();
    const { onNavKey } = await import('../src/ui/events.js');
    const key = (k: string) => onNavKey(new KeyboardEvent('keydown', { key: k }));
    const act = (id: string) => detail().querySelector('[data-dl-row="' + id + '"] [data-dl-act]');
    expect(key('ArrowDown')).toBe(true);
    expect(document.activeElement).toBe(act('movie:2'));
    key('ArrowDown');
    expect(document.activeElement).toBe(act('movie:3'));
    key('ArrowUp');
    expect(document.activeElement).toBe(act('movie:2'));
  });

  it('OK sur une rangée en cours met en pause, sur une rangée terminée la cible est la lecture hors ligne', async () => {
    await open();
    const { onNavKey } = await import('../src/ui/events.js');
    (document.activeElement as HTMLElement).click(); // OK sur la première action : pause
    await flush();
    expect(h.mgr.pause).toHaveBeenCalledWith('movie:1');
    onNavKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const play = document.activeElement as HTMLElement;
    expect(play.dataset.dlAct).toBe('play');
    expect(play.closest('[data-dl-row]')?.getAttribute('data-dl-row')).toBe('movie:2');
  });
});

describe('hors TV, rendu inchangé', () => {
  it('pas de groupes data-nav sur le résumé d’espace ni de bandeau de touches, classes de la liste identiques', async () => {
    h.items = [item('movie:1', 'running'), item('movie:2', 'done')];
    await open();
    expect(document.documentElement.dataset.device).toBeUndefined();
    expect(detail().querySelector('.dl-tv-hint')).toBeNull();
    expect(detail().querySelector('.dl-space-h')?.hasAttribute('data-nav')).toBe(false);
    expect(detail().querySelector('[data-dl-row="movie:2"]')?.className).toBe('dl-row is-done');
    expect(Array.from(detail().querySelectorAll('.dl-page, .dl-head, .dl-list, .dl-sec')).map((e) => e.className)).toEqual(['svc-page dl-page', 'dl-head', 'dl-sec', 'dl-list', 'dl-sec', 'dl-list']);
  });
});
