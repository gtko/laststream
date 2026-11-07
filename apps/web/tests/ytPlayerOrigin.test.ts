// LAST-120 : les messages vers le lecteur YouTube (API IFrame) ciblent son origine explicite, jamais « * ».
import { afterEach, describe, expect, it, vi } from 'vitest';

// `dom.js` lit la page à l'import : squelette minimal avant de charger preview.js.
document.body.innerHTML = '<div id="app"></div><div id="detail" hidden></div><div id="modal" hidden><div class="modal"><div id="modal-body"></div></div><button id="modal-close"></button></div><div id="toast"></div>';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/** Iframe factice : seul `contentWindow.postMessage` est observé. */
function fakeFrame() {
  const postMessage = vi.fn();
  return { iframe: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement, postMessage };
}

describe('messages vers le lecteur YouTube : origine explicite', () => {
  it('postYT, whenPlaying et whenEnded ciblent https://www.youtube-nocookie.com', async () => {
    const { postYT, whenEnded, whenPlaying } = await import('../src/ui/preview.js');
    const { iframe, postMessage } = fakeFrame();
    postYT(iframe, 'mute');
    const offEnded = whenEnded(iframe, () => undefined);
    const offPlaying = whenPlaying(iframe, () => undefined, 60_000, 60_000);
    offEnded();
    offPlaying();
    expect(postMessage).toHaveBeenCalledTimes(3);
    for (const [, target] of postMessage.mock.calls) expect(target).toBe(YT_ORIGIN);
  });
});

const EVIL_ORIGIN = 'https://evil.example';

/** Message entrant venu de la fenêtre `source` (iframe du lecteur), avec l'origine donnée. */
function incoming(source: unknown, origin: string, data: string): MessageEvent {
  const ev = new MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  return ev;
}

/** Corps d'un message `infoDelivery` de l'API IFrame (état de lecture). */
const infoDelivery = (info: Record<string, unknown>): string => JSON.stringify({ event: 'infoDelivery', info });

describe('messages entrants du lecteur YouTube : origine vérifiée', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('whenPlaying ignore un message d’une autre origine et accepte YT_ORIGIN', async () => {
    const { whenPlaying } = await import('../src/ui/preview.js');
    const { iframe } = fakeFrame();
    vi.useFakeTimers();
    const cb = vi.fn();
    const off = whenPlaying(iframe, cb, 100, 60_000);
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, infoDelivery({ playerState: 1 })));
    vi.advanceTimersByTime(1_000);
    expect(cb).not.toHaveBeenCalled();
    window.dispatchEvent(incoming(iframe.contentWindow, YT_ORIGIN, infoDelivery({ playerState: 1 })));
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('whenEnded ignore une fin de lecture d’une autre origine et accepte YT_ORIGIN', async () => {
    const { whenEnded } = await import('../src/ui/preview.js');
    const { iframe } = fakeFrame();
    const cb = vi.fn();
    const off = whenEnded(iframe, cb);
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, infoDelivery({ playerState: 0 })));
    expect(cb).not.toHaveBeenCalled();
    window.dispatchEvent(incoming(iframe.contentWindow, YT_ORIGIN, infoDelivery({ playerState: 0 })));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('watchPlayback ignore un état de lecture d’une autre origine et accepte YT_ORIGIN', async () => {
    const { watchPlayback } = await import('../src/ui/playback.js');
    const { iframe } = fakeFrame();
    const onInfo = vi.fn();
    const off = watchPlayback(iframe, onInfo);
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, infoDelivery({ playerState: 1, currentTime: 5 })));
    expect(onInfo).not.toHaveBeenCalled();
    window.dispatchEvent(incoming(iframe.contentWindow, YT_ORIGIN, infoDelivery({ playerState: 1, currentTime: 5 })));
    expect(onInfo).toHaveBeenCalledTimes(1);
    off();
  });

  it('textFade n’estompe pas les textes sur une lecture d’une autre origine et accepte YT_ORIGIN', async () => {
    const { textFade, FADE_AFTER_MS, QUIET_CLASS } = await import('../src/ui/playback.js');
    const { iframe } = fakeFrame();
    vi.useFakeTimers();
    const zone = document.createElement('div');
    const stop = textFade(zone, iframe);
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, infoDelivery({ playerState: 1 })));
    vi.advanceTimersByTime(FADE_AFTER_MS + 1_000);
    expect(zone.classList.contains(QUIET_CLASS)).toBe(false);
    window.dispatchEvent(incoming(iframe.contentWindow, YT_ORIGIN, infoDelivery({ playerState: 1 })));
    vi.advanceTimersByTime(FADE_AFTER_MS);
    expect(zone.classList.contains(QUIET_CLASS)).toBe(true);
    stop();
  });

  it('guardEmbed ignore une erreur ou une lecture d’une autre origine et accepte YT_ORIGIN', async () => {
    const { guardEmbed } = await import('../src/ui/trailerFallback.js');
    const { iframe } = fakeFrame();
    const onFail = vi.fn();
    const onPlaying = vi.fn();
    const off = guardEmbed(iframe, { onFail, onPlaying, revealMs: 60_000 });
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, JSON.stringify({ event: 'onError', info: 150 })));
    window.dispatchEvent(incoming(iframe.contentWindow, EVIL_ORIGIN, infoDelivery({ playerState: 1 })));
    expect(onFail).not.toHaveBeenCalled();
    expect(onPlaying).not.toHaveBeenCalled();
    window.dispatchEvent(incoming(iframe.contentWindow, YT_ORIGIN, infoDelivery({ playerState: 1 })));
    expect(onPlaying).toHaveBeenCalledTimes(1);
    off();
    expect(onFail).not.toHaveBeenCalled();
  });
});
