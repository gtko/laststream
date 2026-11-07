import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// dom.js lit le squelette de l'application à l'import : on le pose avant de charger les modules.
let textFade: typeof import('../src/ui/playback.js').textFade;
let watchPlayback: typeof import('../src/ui/playback.js').watchPlayback;
let ambientSrc: typeof import('../src/ui/preview.js').ambientSrc;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="toast"></div>'
    + '<div id="modal" hidden><div class="modal"><div id="modal-body"></div><button id="modal-close"></button></div></div>';
  ({ textFade, watchPlayback } = await import('../src/ui/playback.js'));
  ({ ambientSrc } = await import('../src/ui/preview.js'));
});

/** Iframe factice : seul `contentWindow.postMessage` sert ici. */
function fakeIframe() {
  const win = { postMessage: vi.fn() };
  return { iframe: { contentWindow: win } as unknown as HTMLIFrameElement, win };
}

/** Message infoDelivery de l'API IFrame, émis par `source` (la fenêtre de l'iframe, sauf mention contraire). */
function emit(info: Record<string, unknown>, source: unknown) {
  const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'infoDelivery', info }), origin: 'https://www.youtube-nocookie.com' });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

const QUIET = 'is-quiet';

describe('fondu des textes pendant la bande-annonce', () => {
  let zone: HTMLElement;
  let iframe: HTMLIFrameElement;
  let win: { postMessage: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers();
    zone = document.createElement('div');
    zone.innerHTML = '<h1>Titre</h1><p>Synopsis</p>';
    document.body.appendChild(zone);
    ({ iframe, win } = fakeIframe() as unknown as { iframe: HTMLIFrameElement; win: { postMessage: ReturnType<typeof vi.fn> } });
  });
  afterEach(() => {
    vi.useRealTimers();
    zone.remove();
  });

  it('s’estompe après 4 s de lecture effective, pas avant', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1, currentTime: 0, duration: 120 }, win);
    vi.advanceTimersByTime(3999);
    expect(zone.classList.contains(QUIET)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(zone.classList.contains(QUIET)).toBe(true);
    stop();
  });

  it('jamais si la vidéo n’a pas démarré', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: -1 }, win);
    emit({ playerState: 5 }, win);
    emit({ playerState: 3 }, win);
    vi.advanceTimersByTime(30000);
    expect(zone.classList.contains(QUIET)).toBe(false);
    stop();
  });

  it('le mouvement dans la zone rétablit le texte, puis nouveau fondu après 4 s d’inactivité', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(4000);
    expect(zone.classList.contains(QUIET)).toBe(true);
    zone.dispatchEvent(new Event('pointermove'));
    expect(zone.classList.contains(QUIET)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(zone.classList.contains(QUIET)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(zone.classList.contains(QUIET)).toBe(true);
    stop();
  });

  it('le clavier et le toucher dans la zone rétablissent aussi le texte', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(4000);
    zone.dispatchEvent(new Event('keydown'));
    expect(zone.classList.contains(QUIET)).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(zone.classList.contains(QUIET)).toBe(true);
    zone.dispatchEvent(new Event('touchstart'));
    expect(zone.classList.contains(QUIET)).toBe(false);
    stop();
  });

  it('une pause rétablit le texte et annule le délai', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(2000);
    emit({ playerState: 2 }, win);
    vi.advanceTimersByTime(10000);
    expect(zone.classList.contains(QUIET)).toBe(false);
    stop();
  });

  it('une mise en mémoire tampon pendant la lecture ne rétablit pas le texte', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(4000);
    emit({ playerState: 3 }, win);
    expect(zone.classList.contains(QUIET)).toBe(true);
    stop();
  });

  it('ignore les messages d’une autre fenêtre', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, { postMessage: vi.fn() });
    vi.advanceTimersByTime(10000);
    expect(zone.classList.contains(QUIET)).toBe(false);
    stop();
  });

  it('à l’arrêt : classe retirée, plus d’écoute ni de minuterie', () => {
    const stop = textFade(zone, iframe);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(4000);
    expect(zone.classList.contains(QUIET)).toBe(true);
    stop();
    expect(zone.classList.contains(QUIET)).toBe(false);
    emit({ playerState: 1 }, win);
    vi.advanceTimersByTime(10000);
    expect(zone.classList.contains(QUIET)).toBe(false);
  });

  it('sans zone ni iframe : rien à faire, la fonction d’arrêt reste valable', () => {
    expect(textFade(null, iframe)()).toBeUndefined();
    expect(textFade(zone, null)()).toBeUndefined();
  });

  it('s’abonne à l’API IFrame (« listening ») dès l’écoute', () => {
    const stop = textFade(zone, iframe);
    expect(win.postMessage).toHaveBeenCalledWith(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube-nocookie.com');
    stop();
  });
});

describe('watchPlayback', () => {
  it('transmet les infos de lecture de la fenêtre écoutée, puis plus rien après l’arrêt', () => {
    const { iframe, win } = fakeIframe();
    const seen: Record<string, unknown>[] = [];
    const stop = watchPlayback(iframe, (info: Record<string, unknown>) => { seen.push(info); });
    emit({ playerState: 1, currentTime: 3, duration: 90 }, win);
    emit({ playerState: 0, currentTime: 90, duration: 90 }, { postMessage: vi.fn() });
    expect(seen).toEqual([{ playerState: 1, currentTime: 3, duration: 90 }]);
    stop();
    emit({ playerState: 0 }, win);
    expect(seen).toHaveLength(1);
  });
});

describe('bande-annonce de fond : boucle ou non', () => {
  it('boucle par défaut, et ne boucle plus quand l’enchaînement est actif', () => {
    expect(ambientSrc('abc')).toContain('loop=1');
    expect(ambientSrc('abc', true)).toContain('loop=1');
    expect(ambientSrc('abc', false)).toContain('loop=0');
    expect(ambientSrc('abc', false)).toContain('playlist=abc');
  });
});
