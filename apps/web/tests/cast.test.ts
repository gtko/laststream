// Chromecast (LAST-347) : chargement du SDK Google Cast à la demande, disponibilité, envoi à la position voulue, suivi du téléviseur.
// Le SDK est simulé : jsdom ne télécharge pas le script, le test appelle lui-même __onGCastApiAvailable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => cap.native } };
});

import { CAST_SDK_URL, CastError, castPossible, followRemote, loadCastSdk, remoteSeek, resetCastForTests, startCast, stopCast, watchCastAvailability, type CastWindow } from '../src/player/cast';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const w = globalThis as unknown as CastWindow & Record<string, unknown>;

/** Faux SDK : CastContext, session, RemotePlayer et son contrôleur, chrome.cast.media. */
function fakeSdk() {
  const ctxListeners: Array<(e: { castState?: string }) => void> = [];
  const remoteListeners = new Set<() => void>();
  const loads: Array<Record<string, unknown>> = [];
  let castState = 'NO_DEVICES_AVAILABLE';
  const session = { getCastDevice: () => ({ friendlyName: 'Salon TV' }), loadMedia: vi.fn(async (req: Record<string, unknown>) => { loads.push(req); }) };
  let current: typeof session | null = null;
  const ctx = {
    setOptions: vi.fn(),
    getCastState: () => castState,
    getCurrentSession: () => current,
    requestSession: vi.fn(async () => { current = session; }),
    endCurrentSession: vi.fn(() => { current = null; }),
    addEventListener: (_t: string, fn: (e: { castState?: string }) => void) => { ctxListeners.push(fn); },
  };
  const player = { isConnected: true, currentTime: 0, duration: 0, isPaused: false, playerState: null as string | null };
  const ctl = {
    addEventListener: (_t: string, fn: () => void) => { remoteListeners.add(fn); },
    removeEventListener: (_t: string, fn: () => void) => { remoteListeners.delete(fn); },
    playOrPause: vi.fn(),
    seek: vi.fn(),
  };
  class MediaInfo { streamType = ''; metadata: unknown = null; constructor(readonly contentId: string, readonly contentType: string) {} }
  class GenericMediaMetadata {}
  class LoadRequest { currentTime = 0; autoplay = false; constructor(readonly media: unknown) {} }
  class Image { constructor(readonly url: string) {} }
  w.cast = {
    framework: {
      CastContext: { getInstance: () => ctx },
      CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged' },
      CastState: { NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE' },
      RemotePlayer: function RemotePlayer() { return player; } as unknown as new () => typeof player,
      RemotePlayerController: function RemotePlayerController() { return ctl; } as unknown as new () => typeof ctl,
      RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
    },
  } as unknown as CastWindow['cast'];
  (w.chrome as Record<string, unknown>).cast = {
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    Image,
    media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845', StreamType: { BUFFERED: 'BUFFERED' }, MediaInfo, GenericMediaMetadata, LoadRequest },
  };
  return {
    ctx, session, player, ctl, loads,
    setDevices(on: boolean) { castState = on ? 'NOT_CONNECTED' : 'NO_DEVICES_AVAILABLE'; for (const fn of ctxListeners) fn({ castState }); },
    emit(patch: Partial<typeof player>) { Object.assign(player, patch); for (const fn of [...remoteListeners]) fn(); },
    listeners: () => remoteListeners.size,
  };
}

/** SDK pas encore là : le script est ajouté, puis « chargé » à la main. */
async function loadWith(sdk: () => ReturnType<typeof fakeSdk>, ok = true) {
  const pending = loadCastSdk();
  const script = document.head.querySelector('script[src="' + CAST_SDK_URL + '"]');
  expect(script).not.toBeNull();
  const fake = sdk();
  w.__onGCastApiAvailable!(ok);
  return { fw: await pending, fake };
}

beforeEach(() => {
  cap.native = false;
  resetCastForTests();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME_UA);
  w.chrome = {};
  delete w.cast;
  delete w.__onGCastApiAvailable;
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});
afterEach(() => { vi.restoreAllMocks(); delete w.chrome; delete w.cast; });

describe('castPossible : seulement dans un navigateur Chromium', () => {
  it('Chrome : oui', () => { expect(castPossible()).toBe(true); });
  it('Firefox (pas de window.chrome) : non, et aucun script chargé', async () => {
    delete w.chrome;
    expect(castPossible()).toBe(false);
    expect(await loadCastSdk()).toBeNull();
    expect(document.head.querySelector('script')).toBeNull();
  });
  it('application Android (Capacitor) : non, sans erreur', async () => {
    cap.native = true;
    expect(castPossible()).toBe(false);
    const seen: boolean[] = [];
    await watchCastAvailability((ok) => seen.push(ok));
    expect(seen).toEqual([false]);
    expect(document.head.querySelector('script')).toBeNull();
  });
  it('coque Windows (WebView2) : non', () => {
    (w as Record<string, unknown>).chrome = { webview: { postMessage: () => undefined, addEventListener: () => undefined } };
    expect(castPossible()).toBe(false);
  });
});

describe('loadCastSdk', () => {
  it('ajoute le script une seule fois et règle le récepteur par défaut', async () => {
    const { fw, fake } = await loadWith(fakeSdk);
    expect(fw).not.toBeNull();
    expect(fake.ctx.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' });
    await loadCastSdk();
    expect(document.head.querySelectorAll('script').length).toBe(1);
  });
  it('SDK indisponible (navigateur non pris en charge) : null', async () => {
    const { fw } = await loadWith(fakeSdk, false);
    expect(fw).toBeNull();
  });
  it('script en échec : null', async () => {
    const pending = loadCastSdk();
    const s = document.head.querySelector('script') as HTMLScriptElement;
    s.onerror!(new Event('error'));
    expect(await pending).toBeNull();
  });
});

describe('watchCastAvailability', () => {
  it('suit l’apparition et la disparition des appareils', async () => {
    const { fake } = await loadWith(fakeSdk);
    const seen: boolean[] = [];
    await watchCastAvailability((ok) => seen.push(ok));
    fake.setDevices(true);
    fake.setDevices(false);
    expect(seen).toEqual([false, true, false]);
  });
});

describe('startCast : envoi à la position exacte', () => {
  it('ouvre une session et charge la source à currentTime, avec titre et affiche', async () => {
    const { fake } = await loadWith(fakeSdk);
    const name = await startCast({ url: 'https://cdn.test/x.mp4', contentType: 'video/mp4', startAt: 1834.5, title: 'Film', subtitle: 'S1:É2', poster: 'https://img.test/p.jpg' });
    expect(name).toBe('Salon TV');
    expect(fake.ctx.requestSession).toHaveBeenCalledTimes(1);
    const req = fake.loads[0] as { currentTime: number; autoplay: boolean; media: { contentId: string; contentType: string; streamType: string; metadata: Record<string, unknown> } };
    expect(req.currentTime).toBe(1834.5);
    expect(req.autoplay).toBe(true);
    expect(req.media).toMatchObject({ contentId: 'https://cdn.test/x.mp4', contentType: 'video/mp4', streamType: 'BUFFERED' });
    expect(req.media.metadata).toMatchObject({ title: 'Film', subtitle: 'S1:É2', images: [{ url: 'https://img.test/p.jpg' }] });
  });

  it('session déjà ouverte : pas de nouvelle fenêtre de choix', async () => {
    const { fake } = await loadWith(fakeSdk);
    await startCast({ url: 'https://cdn.test/a.mp4', contentType: 'video/mp4', startAt: 0, title: 'A' });
    await startCast({ url: 'https://cdn.test/b.mp4', contentType: 'video/mp4', startAt: 10, title: 'B' });
    expect(fake.ctx.requestSession).toHaveBeenCalledTimes(1);
    expect(fake.loads).toHaveLength(2);
  });

  it('choix de l’appareil annulé : CastError « cancel »', async () => {
    const { fake } = await loadWith(fakeSdk);
    fake.ctx.requestSession.mockRejectedValueOnce('cancel');
    await expect(startCast({ url: 'https://cdn.test/x.mp4', contentType: 'video/mp4', startAt: 0, title: 'X' })).rejects.toMatchObject({ code: 'cancel' });
  });

  it('source refusée par le téléviseur : CastError « load_failed »', async () => {
    const { fake } = await loadWith(fakeSdk);
    fake.session.loadMedia.mockRejectedValueOnce(new Error('x'));
    const err = await startCast({ url: 'https://cdn.test/x.mp4', contentType: 'video/mp4', startAt: 0, title: 'X' }).catch((e) => e);
    expect(err).toBeInstanceOf(CastError);
    expect(err.code).toBe('load_failed');
  });

  it('sans SDK : CastError « unavailable »', async () => {
    delete w.chrome;
    await expect(startCast({ url: 'https://cdn.test/x.mp4', contentType: 'video/mp4', startAt: 0, title: 'X' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('followRemote : relevés du téléviseur', () => {
  it('transmet position et durée, puis signale la déconnexion avec le dernier relevé', async () => {
    const { fake } = await loadWith(fakeSdk);
    const states: unknown[] = [];
    const ends: unknown[] = [];
    await followRemote((s) => states.push(s), (finished, last) => ends.push([finished, last]));
    fake.emit({ playerState: 'BUFFERING' }); // durée encore inconnue : rien
    fake.emit({ playerState: 'PLAYING', currentTime: 1835, duration: 3000 });
    fake.emit({ currentTime: 1836, isPaused: true, playerState: 'PAUSED' });
    expect(states).toEqual([{ time: 1835, duration: 3000, paused: false }, { time: 1836, duration: 3000, paused: true }]);
    fake.emit({ isConnected: false });
    expect(ends).toEqual([[false, { time: 1836, duration: 3000, paused: true }]]);
    expect(fake.listeners()).toBe(0);
  });

  it('fin du média (IDLE après lecture) : finished', async () => {
    const { fake } = await loadWith(fakeSdk);
    const ends: boolean[] = [];
    await followRemote(() => undefined, (finished) => ends.push(finished));
    fake.emit({ playerState: 'IDLE' }); // chargement : pas une fin
    fake.emit({ playerState: 'PLAYING', currentTime: 2990, duration: 3000 });
    fake.emit({ playerState: 'IDLE' });
    expect(ends).toEqual([true]);
  });

  it('remoteSeek et stopCast pilotent le SDK', async () => {
    const { fake } = await loadWith(fakeSdk);
    const off = await followRemote(() => undefined, () => undefined);
    remoteSeek(-5);
    expect(fake.player.currentTime).toBe(0);
    expect(fake.ctl.seek).toHaveBeenCalledTimes(1);
    stopCast();
    expect(fake.ctx.endCurrentSession).toHaveBeenCalledWith(true);
    off();
    expect(fake.listeners()).toBe(0);
  });
});
