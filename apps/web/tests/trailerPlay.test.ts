import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isKidProfile } from '../src/data/auth';
import { isPlayerOpen, playBest } from '../src/player/session.js';
import { prefetchSources } from '../src/sources/load';

// Modules lourds remplacés : seuls les appels de lecture et de recherche comptent ici.
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(() => Promise.resolve()), isPlayerOpen: vi.fn(() => false) }));
vi.mock('../src/sources/load', () => ({ prefetchSources: vi.fn() }));
vi.mock('../src/data/auth', () => ({ isKidProfile: vi.fn(() => false) }));

let createTrailerPlay: typeof import('../src/ui/trailerPlay.js').createTrailerPlay;
let autoPlayOn: typeof import('../src/ui/trailerPlay.js').autoPlayOn;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"><section class="f-first"></section><button data-play>Lecture</button></div>'
    + '<div id="toast"></div><div id="modal" hidden><div class="modal"><div id="modal-body"></div><button id="modal-close"></button></div></div>';
  ({ createTrailerPlay, autoPlayOn } = await import('../src/ui/trailerPlay.js'));
});

const REQUEST = { type: 'tv', id: '42', name: 'Série', season: 2, episode: 3, key: 'tv:42' };

/** Iframe de la bande-annonce : sa fenêtre reçoit les commandes, et les infos viennent d'elle. */
function trailer() {
  const win = { postMessage: vi.fn() };
  return { iframe: { contentWindow: win } as unknown as HTMLIFrameElement, win };
}

function emit(info: Record<string, unknown>, source: unknown) {
  const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'infoDelivery', info }) });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

const opener = () => document.querySelector('[data-play]') as HTMLElement;
const countdownText = () => document.querySelector('.f-next-up .f-next-txt')?.textContent ?? null;

function setup() {
  const alive = vi.fn(() => true);
  const p = createTrailerPlay({ request: REQUEST, opener: opener(), alive });
  const { iframe, win } = trailer();
  return { p, iframe, win, alive };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  vi.mocked(isPlayerOpen).mockReturnValue(false);
  vi.mocked(isKidProfile).mockReturnValue(false);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('.f-next-up').forEach((el) => el.remove());
});

describe('fiche : recherche silencieuse des sources à 10 s', () => {
  it('lance la recherche à 10 s, sans lancer la lecture', () => {
    const { p } = setup();
    p.start();
    vi.advanceTimersByTime(9999);
    expect(prefetchSources).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetchSources).toHaveBeenCalledTimes(1);
    expect(prefetchSources).toHaveBeenCalledWith(REQUEST);
    expect(playBest).not.toHaveBeenCalled();
    p.stop();
  });

  it('pas de recherche si la fiche n’est plus affichée à 10 s', () => {
    const { p, alive } = setup();
    alive.mockReturnValue(false);
    p.start();
    vi.advanceTimersByTime(10000);
    expect(prefetchSources).not.toHaveBeenCalled();
    p.stop();
  });

  it('pas de recherche si un lecteur ou un mini-lecteur est déjà ouvert', () => {
    vi.mocked(isPlayerOpen).mockReturnValue(true);
    const { p } = setup();
    p.start();
    vi.advanceTimersByTime(10000);
    expect(prefetchSources).not.toHaveBeenCalled();
    p.stop();
  });
});

describe('fiche : compte à rebours puis lecture', () => {
  it('compte les 5 dernières secondes, puis lance la lecture de la cible après le fondu', () => {
    const { p, iframe, win } = setup();
    p.start();
    p.attach(iframe);
    emit({ playerState: 1, currentTime: 10, duration: 120 }, win);
    expect(countdownText()).toBeNull();
    emit({ playerState: 1, currentTime: 115, duration: 120 }, win);
    expect(countdownText()).toBe('Lecture dans 5 s');
    emit({ playerState: 1, currentTime: 116.2, duration: 120 }, win);
    expect(countdownText()).toBe('Lecture dans 4 s');
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    expect(playBest).not.toHaveBeenCalled();
    expect(countdownText()).toBeNull();
    vi.advanceTimersByTime(599);
    expect(playBest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(playBest).toHaveBeenCalledTimes(1);
    expect(playBest).toHaveBeenCalledWith(REQUEST, opener(), { resume: 'auto' });
    p.stop();
  });

  it('une interaction (clic, touche, scroll) annule le compte à rebours et la lecture', () => {
    const { p, iframe, win } = setup();
    p.start();
    p.attach(iframe);
    emit({ playerState: 1, currentTime: 116, duration: 120 }, win);
    expect(countdownText()).toBe('Lecture dans 4 s');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(countdownText()).toBeNull();
    win.postMessage.mockClear();
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    vi.advanceTimersByTime(5000);
    expect(playBest).not.toHaveBeenCalled();
    // Annulée : la bande-annonce reboucle au lieu de rester figée.
    expect(win.postMessage).toHaveBeenCalledWith(expect.stringContaining('seekTo'), '*');
    p.stop();
  });

  it('le bouton « Annuler » du compte à rebours annule l’enchaînement', () => {
    const { p, iframe, win } = setup();
    p.start();
    p.attach(iframe);
    emit({ playerState: 1, currentTime: 117, duration: 120 }, win);
    (document.querySelector('[data-autocancel]') as HTMLButtonElement).click();
    expect(countdownText()).toBeNull();
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    vi.advanceTimersByTime(1000);
    expect(playBest).not.toHaveBeenCalled();
    p.stop();
  });

  it('un défilement de plus de 8 px annule ; un défilement minime non', () => {
    const minor = setup();
    minor.p.start();
    minor.p.attach(minor.iframe);
    Object.defineProperty(window, 'scrollY', { value: 5, configurable: true, writable: true });
    window.dispatchEvent(new Event('scroll'));
    emit({ playerState: 0, currentTime: 120, duration: 120 }, minor.win);
    vi.advanceTimersByTime(600);
    expect(playBest).toHaveBeenCalledTimes(1);
    minor.p.stop();

    vi.clearAllMocks();
    const major = setup();
    major.p.start();
    major.p.attach(major.iframe);
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true, writable: true });
    window.dispatchEvent(new Event('scroll'));
    emit({ playerState: 0, currentTime: 120, duration: 120 }, major.win);
    vi.advanceTimersByTime(1000);
    expect(playBest).not.toHaveBeenCalled();
    major.p.stop();
  });

  it('lecteur déjà ouvert à la fin : rien ne se lance', () => {
    const { p, iframe, win } = setup();
    p.start();
    p.attach(iframe);
    vi.mocked(isPlayerOpen).mockReturnValue(true);
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    vi.advanceTimersByTime(1000);
    expect(playBest).not.toHaveBeenCalled();
    p.stop();
  });

  it('fiche changée avant la fin : rien ne se lance', () => {
    const { p, iframe, win, alive } = setup();
    p.start();
    p.attach(iframe);
    alive.mockReturnValue(false);
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    vi.advanceTimersByTime(1000);
    expect(playBest).not.toHaveBeenCalled();
    p.stop();
  });

  it('à l’arrêt de la fiche : plus de recherche, plus de compte à rebours, plus de lecture', () => {
    const { p, iframe, win } = setup();
    p.start();
    p.attach(iframe);
    emit({ playerState: 1, currentTime: 116, duration: 120 }, win);
    p.stop();
    expect(countdownText()).toBeNull();
    vi.advanceTimersByTime(10000);
    expect(prefetchSources).not.toHaveBeenCalled();
    emit({ playerState: 0, currentTime: 120, duration: 120 }, win);
    vi.advanceTimersByTime(1000);
    expect(playBest).not.toHaveBeenCalled();
  });
});

describe('réglage « Lancer automatiquement après la bande-annonce »', () => {
  it('activé par défaut, désactivé par défaut pour un profil enfant, un réglage explicite prime', () => {
    expect(autoPlayOn()).toBe(true);
    vi.mocked(isKidProfile).mockReturnValue(true);
    expect(autoPlayOn()).toBe(false);
    localStorage.setItem('laststream.trailerAutoplay', '1');
    expect(autoPlayOn()).toBe(true);
    vi.mocked(isKidProfile).mockReturnValue(false);
    localStorage.setItem('laststream.trailerAutoplay', '0');
    expect(autoPlayOn()).toBe(false);
  });

  it('synchronisation du profil : valeur appliquée, absente ou inconnue : retour au défaut', async () => {
    const { applyPrefs } = await import('../src/data/prefsSync');
    localStorage.setItem('laststream.trailerAutoplay', '0');
    applyPrefs({});
    expect(localStorage.getItem('laststream.trailerAutoplay')).toBeNull();
    applyPrefs({ trailerAutoplay: false });
    expect(localStorage.getItem('laststream.trailerAutoplay')).toBe('0');
    applyPrefs({ trailerAutoplay: true });
    expect(localStorage.getItem('laststream.trailerAutoplay')).toBe('1');
  });
});
