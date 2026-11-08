// LAST-504 : relance libVLC (mode auto) de la session, avec un `S.P` simulé : une fois par source, sans consommer d'essai.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const playView = vi.fn();
let mode = 'auto';
vi.mock('../src/player/sessionPlay.js', () => ({ playView, releaseLocal: vi.fn() }));
vi.mock('../src/player/sessionUi.js', () => ({ expandPlayer: vi.fn() }));
vi.mock('../src/player/session.js', () => ({ searchAndPlay: vi.fn(), searchInstead: vi.fn() }));
vi.mock('../src/player/sessionOpen.js', () => ({ loaderExtra: vi.fn() }));
vi.mock('../src/sources/load', () => ({ requestKey: () => 'req', webCompatContext: () => ({}) }));
vi.mock('../src/sources/webCompat', () => ({ failoverCandidates: (pool: unknown[]) => pool }));
vi.mock('../src/player/shell', () => ({ shellHasLibvlc: () => true }));
vi.mock('../src/data/prefs', () => ({ getDesktopEngine: () => mode }));

const { retryOnLibvlc, failover } = await import('../src/player/sessionFailover.js');
const { S, MAX_ATTEMPTS } = await import('../src/player/sessionState.js');

const view = (index: number, hash: string) => ({ index, playable: true, hasFrench: true, quality: '1080p', sourceType: 'torrent', langs: [], stream: { infoHash: hash } });
const X = view(0, 'aaa');
const Y = view(1, 'bbb');
const Z = view(2, 'ccc');

function session(v: ReturnType<typeof view>, extra: Record<string, unknown> = {}) {
  const engine = { kind: 'mpv', state: () => ({ time: 42 }), pause: vi.fn() };
  const p = {
    view: v, engine, choice: { backend: 'mpv' }, videoReady: false, startAt: 0, attempts: 1, tried: new Set([v.index]),
    ranked: [X, Y, Z], req: {}, meta: {}, ...extra,
  };
  (S as { P: unknown }).P = p;
  (S as { ui: unknown }).ui = { toast: vi.fn(), setLoading: vi.fn(), setError: vi.fn() };
  return { p, engine };
}

beforeEach(() => { playView.mockClear(); mode = 'auto'; });

describe('retryOnLibvlc (session simulée)', () => {
  it('source X échoue en mpv avant ready : une seule relance libVLC, à la même position', () => {
    const { p, engine } = session(X);
    expect(retryOnLibvlc(p, engine)).toBe(true);
    expect(playView).toHaveBeenCalledTimes(1);
    expect(playView).toHaveBeenCalledWith(X, 42, { shellBackend: 'libvlc' });
  });

  it('second échec de X : pas de nouvelle relance, le repli prend le relais', () => {
    const { p, engine } = session(X);
    expect(retryOnLibvlc(p, engine)).toBe(true);
    playView.mockClear();
    expect(retryOnLibvlc(p, engine)).toBe(false);
    expect(playView).not.toHaveBeenCalled();
    failover('Erreur de lecture (x)');
    expect(playView).toHaveBeenCalledTimes(1);
    expect(playView.mock.calls[0][0]).not.toBe(X);
    expect(playView.mock.calls[0][2]?.shellBackend).toBeUndefined();
    expect(playView.mock.calls[0][2]?.notice).toContain('Erreur de lecture');
  });

  it('une autre source Y obtient sa propre relance', () => {
    const { p, engine } = session(X);
    expect(retryOnLibvlc(p, engine)).toBe(true);
    p.view = Y;
    expect(retryOnLibvlc(p, engine)).toBe(true);
    expect(playView).toHaveBeenLastCalledWith(Y, 42, { shellBackend: 'libvlc' });
    expect(playView).toHaveBeenCalledTimes(2);
  });

  it('vidéo prête, ou mode mpv : aucune relance', () => {
    const a = session(X, { videoReady: true });
    expect(retryOnLibvlc(a.p, a.engine)).toBe(false);
    mode = 'mpv';
    const b = session(X);
    expect(retryOnLibvlc(b.p, b.engine)).toBe(false);
    expect(playView).not.toHaveBeenCalled();
  });

  it('la relance ne consomme pas un essai de MAX_ATTEMPTS', () => {
    // playView compte une tentative (+1) : la relance rend la sienne, le compteur reste inchangé au final.
    const { p, engine } = session(X, { attempts: MAX_ATTEMPTS });
    playView.mockImplementation(() => { p.attempts += 1; });
    expect(retryOnLibvlc(p, engine)).toBe(true);
    expect(p.attempts).toBe(MAX_ATTEMPTS);
    playView.mockReset();
  });
});
