import { describe, expect, it, vi } from 'vitest';

// Mouvement réduit : ni fondu, ni écoute de la lecture.
vi.mock('../src/ui/constants.js', () => ({ REDUCE: true, STILL: false }));

describe('prefers-reduced-motion : pas de fondu des textes', () => {
  it('aucune classe posée, aucun abonnement à l’iframe', async () => {
    const { textFade } = await import('../src/ui/playback.js');
    vi.useFakeTimers();
    const zone = document.createElement('div');
    const postMessage = vi.fn();
    const iframe = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
    const stop = textFade(zone, iframe);
    const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }) });
    Object.defineProperty(ev, 'source', { value: iframe.contentWindow });
    window.dispatchEvent(ev);
    vi.advanceTimersByTime(10000);
    expect(zone.classList.contains('is-quiet')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });
});
