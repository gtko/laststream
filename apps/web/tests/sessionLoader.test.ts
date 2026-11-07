// Chargement différé du lecteur (LAST-129) : un seul import, nouvel essai après un échec, fermeture pendant le chargement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('../src/ui/dom.js', () => ({ toast }));

const SESSION = '../src/player/session.js';
let loads = 0;
let sessionFactory: () => unknown;
const fake = () => ({ isPlayerOpen: vi.fn(() => true), closePlayer: vi.fn(), playBest: vi.fn(async () => 'best'), playSource: vi.fn(async () => 'src') });

beforeEach(() => {
  vi.resetModules();
  toast.mockClear();
  loads = 0;
  sessionFactory = fake;
  vi.doMock(SESSION, () => { loads++; return sessionFactory() as never; });
});
afterEach(() => { vi.doUnmock(SESSION); });

const load = () => import('../src/player/sessionLoader.js');

describe('sessionLoader', () => {
  it('un seul import du lecteur pour plusieurs lectures', async () => {
    const l = await load();
    await Promise.all([l.playBest({} as never), l.playSource({} as never), l.playBest({} as never)]);
    expect(loads).toBe(1);
  });

  it('isPlayerOpen est faux avant le chargement, puis suit le lecteur', async () => {
    const l = await load();
    expect(l.isPlayerOpen()).toBe(false);
    await l.playBest({} as never);
    expect(l.isPlayerOpen()).toBe(true);
  });

  it('échec de l’import : toast, erreur relancée, nouvel essai possible', async () => {
    sessionFactory = () => { throw new Error('chunk introuvable'); };
    const l = await load();
    await expect(l.playBest({} as never)).rejects.toThrow();
    expect(toast).toHaveBeenCalledWith('Lecteur indisponible, vérifiez la connexion.');
    vi.resetModules();
    vi.doMock(SESSION, () => { loads++; return fake(); });
    const l2 = await load();
    await expect(l2.playBest({} as never)).resolves.toBe('best');
  });

  it('nouvel essai sur le même module après un rejet', async () => {
    let first = true;
    sessionFactory = () => { if (first) { first = false; throw new Error('réseau'); } return fake(); };
    const l = await load();
    await expect(l.playBest({} as never)).rejects.toThrow();
    // le module d'import n'est pas remis en cache par vitest : le chargeur doit retenter l'import
    const before = loads;
    await l.playBest({} as never).catch(() => undefined);
    expect(loads).toBeGreaterThan(before);
  });

  it('closePlayer pendant le chargement annule la lecture', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = fake();
    vi.resetModules();
    vi.doMock(SESSION, async () => { await gate; return m; });
    const l = await load();
    const p = l.playBest({} as never);
    l.closePlayer();
    release();
    await p;
    expect(m.playBest).not.toHaveBeenCalled();
    // une lecture demandée ensuite démarre normalement
    await l.playBest({} as never);
    expect(m.playBest).toHaveBeenCalledTimes(1);
  });
  it('retour du navigateur (popstate) pendant le chargement : la lecture ne démarre pas', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = fake();
    vi.resetModules();
    vi.doMock(SESSION, async () => { await gate; return m; });
    const l = await load();
    const p = l.playBest({} as never);
    window.dispatchEvent(new PopStateEvent('popstate'));
    release();
    await p;
    expect(m.playBest).not.toHaveBeenCalled();
  });

  it('sans popstate la lecture démarre, et l’écouteur est retiré après le chargement', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const m = fake();
    vi.resetModules();
    vi.doMock(SESSION, () => m);
    const l = await load();
    await l.playBest({} as never);
    expect(m.playBest).toHaveBeenCalledTimes(1);
    const added = add.mock.calls.filter((c) => c[0] === 'popstate');
    const removed = remove.mock.calls.filter((c) => c[0] === 'popstate');
    expect(added.length).toBe(1);
    expect(removed.map((c) => c[1])).toEqual(added.map((c) => c[1]));
    // popstate tardif : sans effet sur une lecture suivante
    window.dispatchEvent(new PopStateEvent('popstate'));
    await l.playBest({} as never);
    expect(m.playBest).toHaveBeenCalledTimes(2);
    add.mockRestore();
    remove.mockRestore();
  });

  it('écouteur retiré aussi après un échec de chargement', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    sessionFactory = () => { throw new Error('réseau'); };
    const l = await load();
    await expect(l.playBest({} as never)).rejects.toThrow();
    expect(remove.mock.calls.some((c) => c[0] === 'popstate')).toBe(true);
    remove.mockRestore();
  });
});
