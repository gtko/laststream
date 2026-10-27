// Moteur de lecture de la coque Windows (LAST-504) : capacités annoncées par la coque (player-capabilities),
// choix mpv / libVLC / automatique, envoi de player-set-backend et bascule automatique unique vers libVLC.
import { afterEach, describe, expect, it } from 'vitest';
import { MpvEngine } from '../src/player/engines.js';
import { chooseEngine, detectCaps, pickShellBackend, shouldRetryOnLibvlc, type EngineInput } from '../src/player/engine';
import { createWebviewTransport, recordPlayerCapabilities, resetShell, shellHasLibvlc, type ShellWindow } from '../src/player/shell';

afterEach(() => { resetShell(); });

describe('capacités annoncées par la coque', () => {
  it('sans annonce (ancienne coque) : pas de libVLC', () => {
    expect(shellHasLibvlc()).toBe(false);
  });

  it('annonce de libVLC prise en compte, puis retirée si la coque ne l’annonce plus', () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    expect(shellHasLibvlc()).toBe(true);
    recordPlayerCapabilities({ backends: ['mpv'] });
    expect(shellHasLibvlc()).toBe(false);
  });

  it('une charge invalide ne change rien ; les moteurs inconnus sont ignorés', () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    recordPlayerCapabilities(null);
    recordPlayerCapabilities({});
    recordPlayerCapabilities({ backends: 'libvlc' });
    expect(shellHasLibvlc()).toBe(true);
    recordPlayerCapabilities({ backends: ['vlc'] });
    expect(shellHasLibvlc()).toBe(false);
  });

  it('reçue sur le canal WebView2, comme les autres signaux de la coque', async () => {
    const listeners: Array<(ev: { data: unknown }) => void> = [];
    const win: ShellWindow = {
      chrome: { webview: { postMessage: () => undefined, addEventListener: (_t: 'message', fn: (ev: { data: unknown }) => void) => { listeners.push(fn); } } },
    };
    const emit = (d: unknown): void => listeners.forEach((fn) => fn({ data: JSON.stringify(d) }));
    const p = createWebviewTransport(win);
    emit({ id: 0, object: 'transport', type: 3, data: { transport: { properties: [] } } });
    await p;
    emit({ id: 1, object: 'transport', type: 1, args: ['player-capabilities', { backends: ['mpv', 'libvlc'] }] });
    expect(shellHasLibvlc()).toBe(true);
  });
});

describe('choix du moteur de la coque', () => {
  const CAPS = detectCaps(() => '', { chromium: true, maxChannels: 2 });
  const shell: EngineInput = { shell: true, serverUp: true, probe: null, caps: CAPS, notWebReady: false, name: 'film.mkv' };

  it('pickShellBackend : libVLC seulement si demandé et annoncé, sinon mpv', () => {
    expect(pickShellBackend('auto', true)).toBe('mpv');
    expect(pickShellBackend('mpv', true)).toBe('mpv');
    expect(pickShellBackend('libvlc', true)).toBe('libvlc');
    expect(pickShellBackend('libvlc', false)).toBe('mpv');
  });

  it('sans réglage : mpv, même si libVLC est annoncé', () => {
    const c = chooseEngine({ ...shell, libvlcAvailable: true });
    expect(c.engine).toBe('mpv');
    expect(c.backend).toBe('mpv');
  });

  it('libVLC choisi et annoncé : moteur mpv côté app, backend libvlc', () => {
    const c = chooseEngine({ ...shell, desktopEngine: 'libvlc', libvlcAvailable: true });
    expect(c.engine).toBe('mpv');
    expect(c.backend).toBe('libvlc');
  });

  it('libVLC choisi mais non annoncé : repli sur mpv', () => {
    expect(chooseEngine({ ...shell, desktopEngine: 'libvlc', libvlcAvailable: false }).backend).toBe('mpv');
  });

  it('mpv forcé : mpv même si libVLC est annoncé', () => {
    expect(chooseEngine({ ...shell, desktopEngine: 'mpv', libvlcAvailable: true }).backend).toBe('mpv');
  });
});

describe('bascule automatique vers libVLC', () => {
  const failing = { mode: 'auto' as const, backend: 'mpv' as const, videoReady: false, libvlcAvailable: true, alreadyRetried: false };

  it('en mode auto, un échec mpv avant la première image relance une fois avec libVLC', () => {
    expect(shouldRetryOnLibvlc(failing)).toBe(true);
  });

  it('jamais en mode forcé (mpv ou libVLC)', () => {
    expect(shouldRetryOnLibvlc({ ...failing, mode: 'mpv' })).toBe(false);
    expect(shouldRetryOnLibvlc({ ...failing, mode: 'libvlc' })).toBe(false);
  });

  it('jamais une fois la première image affichée', () => {
    expect(shouldRetryOnLibvlc({ ...failing, videoReady: true })).toBe(false);
  });

  it('jamais sans libVLC annoncé', () => {
    expect(shouldRetryOnLibvlc({ ...failing, libvlcAvailable: false })).toBe(false);
  });

  it('jamais si le moteur en échec n’est pas mpv (libVLC déjà essayé, lecteur HTML5…)', () => {
    expect(shouldRetryOnLibvlc({ ...failing, backend: 'libvlc' })).toBe(false);
    expect(shouldRetryOnLibvlc({ ...failing, backend: undefined })).toBe(false);
  });

  it('jamais deux fois pour la même source : l’état « déjà rebasculé » bloque la boucle', () => {
    const tried = new Set<string>();
    const key = 'source-1';
    expect(shouldRetryOnLibvlc({ ...failing, alreadyRetried: tried.has(key) })).toBe(true);
    tried.add(key);
    expect(shouldRetryOnLibvlc({ ...failing, alreadyRetried: tried.has(key) })).toBe(false);
  });
});

describe('player-set-backend (MpvEngine)', () => {
  function setup() {
    const sent: Array<[string, unknown]> = [];
    const handlers = new Map<string, (a: unknown) => void>();
    const ipc = { send: (e: string, a?: unknown) => sent.push([e, a]), on: (e: string, fn: (a: unknown) => void) => { handlers.set(e, fn); } };
    const engine = new MpvEngine(ipc, document.createElement('div'));
    // Version connue : pas d'attente de 400 ms avant loadfile.
    handlers.get('mpv-prop-change')!({ name: 'mpv-version', data: 'mpv 0.39.0' });
    return { sent, engine };
  }
  const backendMsgs = (sent: Array<[string, unknown]>): unknown[] => sent.filter(([e]) => e === 'player-set-backend').map(([, a]) => a);

  it('coque sans libVLC : aucun player-set-backend, même si libVLC est demandé', async () => {
    const { sent, engine } = setup();
    await engine.load({ url: 'http://127.0.0.1:11470/abc/1', startAt: 0, backend: 'libvlc' });
    expect(backendMsgs(sent)).toEqual([]);
  });

  it('libVLC annoncé : player-set-backend part avant loadfile', async () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    const { sent, engine } = setup();
    await engine.load({ url: 'http://127.0.0.1:11470/abc/1', startAt: 0, backend: 'libvlc' });
    expect(backendMsgs(sent)).toEqual([{ backend: 'libvlc' }]);
    const idxSet = sent.findIndex(([e]) => e === 'player-set-backend');
    const idxLoad = sent.findIndex(([e, a]) => e === 'mpv-command' && (a as string[])[0] === 'loadfile');
    expect(idxSet).toBeGreaterThanOrEqual(0);
    expect(idxSet).toBeLessThan(idxLoad);
  });

  it('après libVLC, un retour à mpv est aussi envoyé', async () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    const { sent, engine } = setup();
    await engine.load({ url: 'http://127.0.0.1:11470/abc/1', startAt: 0, backend: 'libvlc' });
    await engine.load({ url: 'http://127.0.0.1:11470/abc/2', startAt: 0, backend: 'mpv' });
    expect(backendMsgs(sent)).toEqual([{ backend: 'libvlc' }, { backend: 'mpv' }]);
  });

  it('mpv sans choix précédent : rien n’est envoyé', async () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    const { sent, engine } = setup();
    await engine.load({ url: 'http://127.0.0.1:11470/abc/1', startAt: 0, backend: 'mpv' });
    expect(backendMsgs(sent)).toEqual([]);
  });
});
