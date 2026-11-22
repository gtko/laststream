// @vitest-environment jsdom
/* Télécommande LG (webOS, LAST-1643) : détection, touche Retour (Échap puis règle du retour Android, double appui pour
 * quitter sur l'accueil) et touches média renvoyées sous leur nom standard. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const layers = { open: false };
const player = { full: false };
vi.mock('../src/ui/router.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/ui/state.js', () => ({ state: { inDetail: false } }));
vi.mock('../src/ui/dom.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/backStack.js', () => ({ hasLayers: () => layers.open }));
vi.mock('../src/player/sessionLoader.js', () => ({ isPlayerFull: () => player.full, leavePlayer: vi.fn() }));

const UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.211 Safari/537.36 WebAppManager';
const realUa = navigator.userAgent;
const setUa = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });

const { isTvDevice, isWebOs } = await import('../src/ui/device.js');
const { startWebOsKeys, webosBackAction, webosMediaKey, WEBOS_BACK } = await import('../src/ui/webosKeys.js');
const { goBack } = await import('../src/ui/router.js');
const { state } = await import('../src/ui/state.js');
const { toast } = await import('../src/ui/dom.js');
const { leavePlayer } = await import('../src/player/sessionLoader.js');

/** Touche de la télécommande, avec son keyCode LG. */
function press(keyCode: number, key = 'Unidentified') {
  const ev = new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
  return ev;
}

describe('détection webOS', () => {
  afterEach(() => setUa(realUa));
  it('reconnaît une TV ou un projecteur LG à son agent utilisateur, même avec un pointeur (Magic Remote)', () => {
    setUa(UA);
    expect(isWebOs()).toBe(true);
    expect(isTvDevice()).toBe(true);
  });
  it("ne prend pas un navigateur de bureau pour une TV", () => {
    setUa('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
    expect(isWebOs()).toBe(false);
    expect(isTvDevice()).toBe(false);
  });
});

describe('webosBackAction', () => {
  const base = { handled: false, layers: false, player: false, inDetail: false, armed: false };
  it("ne fait rien de plus quand l'interface a déjà traité Échap", () => {
    expect(webosBackAction({ ...base, handled: true, layers: true, inDetail: true })).toBe('none');
  });
  it('ferme la couche, puis quitte le lecteur, puis revient à la page précédente', () => {
    expect(webosBackAction({ ...base, layers: true, player: true })).toBe('back');
    expect(webosBackAction({ ...base, player: true, inDetail: true })).toBe('player');
    expect(webosBackAction({ ...base, inDetail: true })).toBe('page');
  });
  it("sur l'accueil : un premier appui prévient, le second quitte", () => {
    expect(webosBackAction(base)).toBe('arm');
    expect(webosBackAction({ ...base, armed: true })).toBe('exit');
  });
});

describe('webosMediaKey', () => {
  it('donne le nom standard des touches média LG', () => {
    expect(webosMediaKey(415, 'Unidentified')).toBe('MediaPlay');
    expect(webosMediaKey(19, 'Pause')).toBe('MediaPause');
    expect(webosMediaKey(413, '')).toBe('MediaStop');
    expect(webosMediaKey(417, '')).toBe('MediaFastForward');
    expect(webosMediaKey(412, '')).toBe('MediaRewind');
  });
  it('laisse passer les autres touches, et une touche qui porte déjà son nom', () => {
    expect(webosMediaKey(37, 'ArrowLeft')).toBeNull();
    expect(webosMediaKey(415, 'MediaPlay')).toBeNull();
  });
});

describe('startWebOsKeys', () => {
  const seen: string[] = [];
  let escHandled = false;
  const listener = (e: KeyboardEvent) => { seen.push(e.key); if (e.key === 'Escape' && escHandled) e.preventDefault(); };
  beforeAll(() => {
    setUa(UA);
    startWebOsKeys();
    setUa(realUa);
    document.addEventListener('keydown', listener);
  });
  afterEach(() => {
    seen.length = 0;
    escHandled = false;
    layers.open = false;
    player.full = false;
    state.inDetail = false;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('Retour devient Échap ; traité par la page, rien d’autre ne se passe', () => {
    escHandled = true;
    state.inDetail = true;
    const ev = press(WEBOS_BACK);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual(['Escape']);
    expect(goBack).not.toHaveBeenCalled();
  });
  it('Retour non traité : lecteur quitté, sinon page précédente', () => {
    player.full = true;
    press(WEBOS_BACK);
    expect(leavePlayer).toHaveBeenCalledTimes(1);
    player.full = false;
    state.inDetail = true;
    press(WEBOS_BACK);
    expect(goBack).toHaveBeenCalledTimes(1);
  });
  it("sur l'accueil : prévient au premier Retour, rend la main à la TV au second (dans le délai)", () => {
    vi.useFakeTimers();
    const platformBack = vi.fn();
    (window as unknown as { webOS?: unknown }).webOS = { platformBack };
    press(WEBOS_BACK);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(platformBack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    press(WEBOS_BACK);
    expect(platformBack).toHaveBeenCalledTimes(1);
    // Trop tard : on prévient à nouveau au lieu de quitter.
    press(WEBOS_BACK);
    vi.advanceTimersByTime(5000);
    press(WEBOS_BACK);
    expect(platformBack).toHaveBeenCalledTimes(1);
    delete (window as unknown as { webOS?: unknown }).webOS;
  });
  it('touches média renvoyées sous leur nom standard, la touche LG est arrêtée', () => {
    press(415);
    press(417);
    expect(seen).toEqual(['MediaPlay', 'MediaFastForward']);
  });
  it('les flèches passent telles quelles', () => {
    const ev = press(37, 'ArrowLeft');
    expect(ev.defaultPrevented).toBe(false);
    expect(seen).toEqual(['ArrowLeft']);
  });
});
