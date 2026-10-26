// Montage et démontage répétés des vues qui arment une minuterie ou des écouteurs sur window / document (LAST-134) : après
// chaque démontage, aucune minuterie reste active et le nombre d'écouteurs encore actifs sur window et document ne croît pas.
// Jsdom, horloge simulée, aucun réseau réel.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const CYCLES = 30;

vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/player/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/player/session.js')>()),
  isPlayerOpen: () => false,
}));
vi.mock('../src/data/appUpdate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/appUpdate')>()),
  updateSupported: () => true,
  checkForUpdate: async () => null,
}));

let partypanel: typeof import('../src/ui/partypanel.js');
let home: typeof import('../src/ui/home.js');
let banners: typeof import('../src/ui/update-banner.js');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  partypanel = await import('../src/ui/partypanel.js');
  home = await import('../src/ui/home.js');
  banners = await import('../src/ui/update-banner.js');
});

/** Écouteurs ajoutés pendant le test sur window ou document, avec leur signal éventuel. */
type Watched = { target: EventTarget; type: string; listener: unknown; capture: boolean; signal?: AbortSignal };
let watched: Watched[] = [];
let unwatch: Array<() => void> = [];

/** Écouteurs encore actifs sur window et document : retirés explicitement, ou dont le signal est annulé, ils ne comptent plus. */
const activeWindowDocListeners = () => watched.filter((w) => !w.signal?.aborted).length;

/** Espionne addEventListener / removeEventListener d'une cible (propre à l'objet ou hérité) ; renvoie de quoi rétablir. */
function watchTarget(target: EventTarget): () => void {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'addEventListener');
  const origAdd = target.addEventListener;
  const origRemove = target.removeEventListener;
  target.addEventListener = (type, listener, options) => {
    if (listener) {
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      const signal = typeof options === 'object' ? options.signal ?? undefined : undefined;
      watched.push({ target, type, listener, capture, signal });
    }
    return origAdd.call(target, type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    watched = watched.filter((w) => !(w.target === target && w.type === type && w.listener === listener && w.capture === capture));
    return origRemove.call(target, type, listener, options);
  };
  return () => {
    if (hadOwn) {
      target.addEventListener = origAdd;
      target.removeEventListener = origRemove;
    } else {
      delete (target as Partial<EventTarget>).addEventListener;
      delete (target as Partial<EventTarget>).removeEventListener;
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  watched = [];
  unwatch = [watchTarget(window), watchTarget(document)];
});

afterEach(() => {
  partypanel.unmountPartyPanel();
  home.stopHomeLive();
  document.querySelectorAll('.uiupd-banner, .upd-banner').forEach((n) => n.remove());
  unwatch.forEach((restore) => restore());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('vues à minuterie ou à écouteurs : montage et démontage répétés', () => {
  it('panneau de watch party : chaque démontage arrête le compte à rebours et retire le panneau', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const timers = vi.getTimerCount();
    for (let i = 0; i < CYCLES; i++) {
      partypanel.mountPartyPanel(root, { adapter: () => null });
      expect(vi.getTimerCount()).toBe(timers + 1);
      expect(root.querySelector('aside.lp-party')).not.toBeNull();
      partypanel.unmountPartyPanel();
      expect(vi.getTimerCount()).toBe(timers);
      expect(root.children.length).toBe(0);
    }
    expect(activeWindowDocListeners()).toBe(0);
    root.remove();
  });

  it('accueil : chaque arrêt coupe la resynchronisation et ses écouteurs, chaque démarrage les remet', () => {
    home.stopHomeLive();
    const timers = vi.getTimerCount();
    expect(activeWindowDocListeners()).toBe(0);
    for (let i = 0; i < CYCLES; i++) {
      home.startHomeLive();
      expect(vi.getTimerCount()).toBe(timers + 1);
      expect(activeWindowDocListeners()).toBe(3); // resume, visibilitychange, focus
      home.stopHomeLive();
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeWindowDocListeners()).toBe(0);
    }
  });

  it('bannière Android : chaque arrêt retire le contrôle horaire', () => {
    const timers = vi.getTimerCount();
    for (let i = 0; i < CYCLES; i++) {
      const stop = banners.initUpdateBanner();
      expect(vi.getTimerCount()).toBe(timers + 1);
      stop();
      expect(vi.getTimerCount()).toBe(timers);
    }
  });

  it('bannière web : chaque démontage retire minuteries, écouteurs et bannière', async () => {
    const timers = vi.getTimerCount();
    for (let i = 0; i < CYCLES; i++) {
      const ui = banners.initUiUpdateBanner({
        active: true, current: 'a-1', fetchBuild: async () => 'b-2', apply: () => undefined, isBusy: () => false,
        now: () => Date.now(), firstDelay: 0,
      })!;
      expect(vi.getTimerCount()).toBe(timers + 2); // premier contrôle et contrôle périodique
      expect(activeWindowDocListeners()).toBe(6); // 4 d'activité sur window, fullscreenchange et visibilitychange
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.uiupd-banner')).not.toBeNull();
      ui.destroy();
      expect(document.querySelector('.uiupd-banner')).toBeNull();
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeWindowDocListeners()).toBe(0);
    }
  });

  it('bannière web : une vérification encore en cours au démontage ne ramène ni bannière ni minuterie', async () => {
    const timers = vi.getTimerCount();
    let answer!: (build: string) => void;
    const ui = banners.initUiUpdateBanner({
      active: true, current: 'a-1', fetchBuild: () => new Promise<string>((resolve) => { answer = resolve; }),
      apply: () => undefined, isBusy: () => false, now: () => Date.now(), firstDelay: 0,
    })!;
    await vi.advanceTimersByTimeAsync(0); // le premier contrôle part et attend la réponse du réseau
    ui.destroy();
    answer('b-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.uiupd-banner')).toBeNull();
    expect(vi.getTimerCount()).toBe(timers);
  });
});
