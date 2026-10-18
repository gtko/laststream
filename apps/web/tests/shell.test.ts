import { afterEach, describe, expect, it, vi } from 'vitest';
import { MpvEngine } from '../src/player/engines.js';
import {
  announceShellReady, backStep, connectShell, createWebviewTransport, decodeMessage, encodeInvoke, isShellEnvironment, resetShell, setShellFullscreen, setShellPip, startShellDrag,
  type ShellWindow,
} from '../src/player/shell';
import { analyzeUrl, isPrivateHost, REPOLL_EVERY_MS, REPOLL_MAX, shouldRepoll, validAnalyzeDuration } from '../src/player/skip';
import { setShellServerAddress, serverBase } from '../src/player/server';

/** Faux `window.chrome.webview` de WebView2 : enregistre les messages envoyés et permet d'en recevoir. */
function mockWebview() {
  const sent: unknown[] = [];
  const listeners: Array<(ev: { data: unknown }) => void> = [];
  const webview = {
    postMessage: (m: string) => { sent.push(JSON.parse(m)); },
    addEventListener: (_t: 'message', fn: (ev: { data: unknown }) => void) => { listeners.push(fn); },
  };
  const receive = (data: unknown) => listeners.forEach((fn) => fn({ data: typeof data === 'string' ? data : JSON.stringify(data) }));
  return { sent, webview, receive, listeners };
}

/** Réponse de poignée de main de la coque (voir ipc.rs : type 3, propriétés [ "", nom, "", valeur ]). */
const HANDSHAKE = {
  id: 0, object: 'transport', type: 3,
  data: { transport: { properties: [[], ['', 'shellVersion', '', '1.2.3'], ['', 'streamingServerUrl', '', 'http://127.0.0.1:11470'], ['', 'nativeAssSubtitles', '', 'true']], signals: [], methods: [['onEvent', '']] } },
};
const signal = (...args: unknown[]) => ({ id: 1, object: 'transport', type: 1, args });

afterEach(() => { resetShell(); setShellServerAddress(''); });

describe('coque WebView2 : messages', () => {
  it('appel d’une méthode : { id: 0, type: 6, args: [événement, charge] }', () => {
    expect(JSON.parse(encodeInvoke('mpv-command', ['stop']))).toEqual({ id: 0, type: 6, args: ['mpv-command', ['stop']] });
    expect(JSON.parse(encodeInvoke('app-ready'))).toEqual({ id: 0, type: 6, args: ['app-ready'] });
    expect(JSON.parse(encodeInvoke('win-set-visibility', { fullscreen: true })).args).toEqual(['win-set-visibility', { fullscreen: true }]);
  });

  it('poignée de main et signaux', () => {
    expect(decodeMessage(JSON.stringify(HANDSHAKE))).toEqual({ kind: 'init', info: { shellVersion: '1.2.3', streamingServerUrl: 'http://127.0.0.1:11470', nativeAssSubtitles: 'true' } });
    expect(decodeMessage(JSON.stringify(signal('mpv-prop-change', { name: 'pause', data: true })))).toEqual({ kind: 'signal', event: 'mpv-prop-change', payload: { name: 'pause', data: true } });
    expect(decodeMessage(signal('media-key', 'play-pause'))).toEqual({ kind: 'signal', event: 'media-key', payload: 'play-pause' });
    expect(decodeMessage('pas du json')).toBeNull();
    expect(decodeMessage({ type: 99 })).toBeNull();
    expect(decodeMessage(null)).toBeNull();
  });
});

describe('coque WebView2 : transport', () => {
  it('détection : seul chrome.webview ou qt.webChannelTransport comptent (pas un Chrome ordinaire)', () => {
    expect(isShellEnvironment({})).toBe(false);
    expect(isShellEnvironment({ chrome: {} as never })).toBe(false);
    expect(isShellEnvironment({ chrome: { webview: mockWebview().webview } })).toBe(true);
    expect(isShellEnvironment({ qt: { webChannelTransport: {} } })).toBe(true);
  });

  it('envoie la poignée de main, puis relaie les signaux et les appels', async () => {
    const m = mockWebview();
    const qt = { webChannelTransport: {} as { onmessage?: (ev: unknown) => void } };
    const win: ShellWindow = { chrome: { webview: m.webview }, qt };
    const p = createWebviewTransport(win);
    expect(m.sent[0]).toEqual({ id: 0, type: 3 });
    // La coque appelle qt.webChannelTransport.onmessage à chaque message : il doit exister et ne rien casser.
    expect(typeof qt.webChannelTransport.onmessage).toBe('function');
    m.receive(HANDSHAKE);
    const t = (await p)!;
    expect(t.kind).toBe('webview2');
    expect(t.info.shellVersion).toBe('1.2.3');
    expect(serverBase()).toBe('http://127.0.0.1:11470');

    const got: unknown[] = [];
    t.on('mpv-prop-change', (a) => got.push(a));
    t.on('mpv-prop-change', () => { throw new Error('un écouteur défaillant'); });
    m.receive(signal('mpv-prop-change', { name: 'time-pos', data: 12.5 }));
    m.receive(signal('win-state-changed', { state: 2 }));
    expect(got).toEqual([{ name: 'time-pos', data: 12.5 }]);

    t.send('mpv-set-prop', ['pause', true]);
    t.send('quit');
    expect(m.sent.slice(1)).toEqual([
      { id: 0, type: 6, args: ['mpv-set-prop', ['pause', true]] },
      { id: 0, type: 6, args: ['quit'] },
    ]);
  });

  it('coque muette : null après le délai, la lecture se fait dans le navigateur', async () => {
    vi.useFakeTimers();
    const m = mockWebview();
    const p = createWebviewTransport({ chrome: { webview: m.webview } }, 500);
    vi.advanceTimersByTime(600);
    expect(await p).toBeNull();
    vi.useRealTimers();
  });

  it('plein écran : la coque agit sur la fenêtre', async () => {
    const m = mockWebview();
    const p = connectShell({ chrome: { webview: m.webview } });
    m.receive(HANDSHAKE);
    setShellFullscreen((await p)!, true);
    expect(m.sent[m.sent.length - 1]).toEqual({ id: 0, type: 6, args: ['win-set-visibility', { fullscreen: true }] });
  });

  it('image dans l’image : la coque réduit la fenêtre, le glissement la déplace', async () => {
    const m = mockWebview();
    const p = connectShell({ chrome: { webview: m.webview } });
    m.receive(HANDSHAKE);
    const t = (await p)!;
    setShellPip(t, true);
    expect(m.sent[m.sent.length - 1]).toEqual({ id: 0, type: 6, args: ['win-set-pip', { pip: true }] });
    startShellDrag(t);
    expect(m.sent[m.sent.length - 1]).toEqual({ id: 0, type: 6, args: ['win-drag'] });
  });

  it('app-ready : envoyé une seule fois, jamais hors coque', async () => {
    const m = mockWebview();
    const win: ShellWindow = { chrome: { webview: m.webview } };
    const first = announceShellReady(win);
    m.receive(HANDSHAKE);
    expect(await first).toBe(true);
    expect(await announceShellReady(win)).toBe(false);
    expect(m.sent.filter((x) => (x as { args?: string[] }).args?.[0] === 'app-ready')).toHaveLength(1);
    resetShell();
    expect(await announceShellReady({})).toBe(false);
  });
});

describe('Échap / Retour dans le lecteur', () => {
  it('ferme d’abord le panneau, puis quitte le plein écran, puis ferme le lecteur', () => {
    expect(backStep({ panelOpen: true, shellFullscreen: true, docFullscreen: false })).toBe('panel');
    expect(backStep({ panelOpen: false, shellFullscreen: true, docFullscreen: false })).toBe('shell-fullscreen');
    expect(backStep({ panelOpen: false, shellFullscreen: false, docFullscreen: true })).toBe('doc-fullscreen');
    expect(backStep({ panelOpen: false, shellFullscreen: false, docFullscreen: false })).toBe('close');
  });
});

describe('mpv par la coque', () => {
  // Propriétés et commandes acceptées par la coque (stremio_player/communication.rs).
  const OBSERVABLE = ['pause', 'paused-for-cache', 'seeking', 'eof-reached', 'keepaspect', 'aid', 'vid', 'sid', 'time-pos', 'mute', 'volume', 'duration', 'sub-delay', 'sub-scale', 'cache-buffering-state', 'demuxer-cache-time', 'sub-pos', 'speed', 'panscan', 'ffmpeg-version', 'hwdec', 'metadata', 'mpv-version', 'path', 'track-list', 'video-params'];
  const COMMANDS = ['stop', 'loadfile', 'sub-add', 'sub-remove'];

  function setup() {
    const sent: Array<[string, unknown]> = [];
    const handlers = new Map<string, (a: unknown) => void>();
    const ipc = { send: (e: string, a?: unknown) => sent.push([e, a]), on: (e: string, fn: (a: unknown) => void) => { handlers.set(e, fn); } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const engine = new MpvEngine(ipc, container);
    return { sent, handlers, engine, container };
  }

  it('n’observe que des propriétés que la coque accepte', () => {
    const { sent } = setup();
    const observed = sent.filter(([e]) => e === 'mpv-observe-prop').map(([, a]) => a as string);
    expect(observed.length).toBeGreaterThan(8);
    expect(observed.filter((p) => !OBSERVABLE.includes(p))).toEqual([]);
  });

  it('charge le fichier à la bonne position et n’envoie que des commandes autorisées', async () => {
    const { sent, handlers, engine, container } = setup();
    handlers.get('mpv-prop-change')!({ name: 'mpv-version', data: 'mpv 0.39.0' });
    await engine.load({ url: 'http://127.0.0.1:11470/abc/2', startAt: 90 });
    const cmds = sent.filter(([e]) => e === 'mpv-command').map(([, a]) => a as string[]);
    expect(cmds.every((c) => COMMANDS.includes(c[0]))).toBe(true);
    expect(cmds.find((c) => c[0] === 'loadfile')).toEqual(['loadfile', 'http://127.0.0.1:11470/abc/2', 'replace', '-1', 'start=+90']);
    // La page devient transparente pour laisser voir mpv, et redevient normale à l'arrêt.
    expect(container.style.background).toBe('transparent');
    engine.destroy();
    expect(container.style.background).toBe('');
  });

  it('piste audio : `aid` est envoyé comme nombre et le panneau suit le changement', () => {
    const { sent, handlers, engine } = setup();
    handlers.get('mpv-prop-change')!({ name: 'mpv-version', data: 'mpv 0.39.0' });
    engine.live = true;
    handlers.get('mpv-prop-change')!({ name: 'track-list', data: [{ id: 1, type: 'audio', lang: 'eng', selected: true }, { id: 2, type: 'audio', lang: 'fre', selected: false }] });
    engine.setAudioTrack('2');
    expect(sent.filter(([e]) => e === 'mpv-set-prop').pop()).toEqual(['mpv-set-prop', ['aid', 2]]);
    handlers.get('mpv-prop-change')!({ name: 'aid', data: 2 });
    expect(engine.audioTracks().map((t) => [t.id, t.selected])).toEqual([['1', false], ['2', true]]);
  });

  it('état : position, durée, pause, volume (0 à 100 → 0 à 1), pistes', () => {
    const { handlers, engine } = setup();
    const emit = (name: string, data: unknown) => handlers.get('mpv-prop-change')!({ name, data });
    (engine as unknown as { live: boolean }).live = true;
    emit('time-pos', 61.5);
    emit('duration', 1440);
    emit('pause', true);
    emit('volume', 80);
    emit('mute', 'no');
    emit('track-list', [
      { id: 1, type: 'audio', lang: 'fre', title: 'Français VFF', codec: 'eac3', 'audio-channels': 6, selected: true },
      { id: 2, type: 'audio', lang: 'jpn', codec: 'aac', 'audio-channels': 2 },
      { id: 1, type: 'sub', lang: 'fre', codec: 'subrip' },
    ]);
    const st = engine.state();
    expect(st).toMatchObject({ time: 61.5, duration: 1440, paused: true, volume: 0.8, muted: false });
    expect(engine.audioTracks().map((t: { lang: string }) => t.lang)).toEqual(['fr', 'ja']);
    expect(engine.audioTracks()[0].label).toBe('Français VFF · Dolby Digital+ 5.1');
    expect(engine.subtitleTracks()).toHaveLength(1);
  });

  it('commandes de lecture : pause, position, volume, piste audio, sous-titres', () => {
    const { sent, engine } = setup();
    sent.length = 0;
    engine.pause();
    engine.seek(30);
    engine.setVolume(0.5);
    engine.setAudioTrack('2');
    engine.setSubtitleTrack('3');
    engine.setSubtitleTrack(null);
    expect(sent).toEqual([
      ['mpv-set-prop', ['pause', true]],
      ['mpv-set-prop', ['time-pos', 30]],
      ['mpv-set-prop', ['mute', 'no']],
      ['mpv-set-prop', ['volume', 50]],
      ['mpv-set-prop', ['aid', 2]],
      ['mpv-set-prop', ['sid', 3]],
      ['mpv-set-prop', ['sid', 'no']],
    ]);
  });
});

describe('analyse de l’épisode et nouvelle interrogation des segments', () => {
  it('adresses privées', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.143', '172.16.0.1', '172.31.9.9', '169.254.1.1', 'nas', 'box.local', '::1', 'fe80::1']) expect(isPrivateHost(h)).toBe(true);
    for (const h of ['cdn.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', 'debrid.link']) expect(isPrivateHost(h)).toBe(false);
  });

  it('lien envoyé : débrideur ou serveur de streaming local, jamais une autre adresse privée', () => {
    expect(analyzeUrl('https://cdn.debrid.example/dl/abc/film.mkv')).toBe('https://cdn.debrid.example/dl/abc/film.mkv');
    expect(analyzeUrl('http://127.0.0.1:11470/abcdef/3')).toBe('http://127.0.0.1:11470/abcdef/3');
    expect(analyzeUrl('http://localhost:11470/abcdef/3')).toBe('http://localhost:11470/abcdef/3');
    expect(analyzeUrl('http://192.168.1.143:11470/abcdef/3')).toBeNull();
    expect(analyzeUrl('http://127.0.0.1:8080/secret')).toBeNull();
    expect(analyzeUrl('http://nas/video.mkv')).toBeNull();
    expect(analyzeUrl('ftp://example.com/a.mkv')).toBeNull();
    expect(analyzeUrl('pas une adresse')).toBeNull();
    // Derrière le relais de l'application, on redonne l'adresse locale du serveur.
    expect(analyzeUrl('http://localhost:8080/_ss/abcdef/3?tr=x', 'http://localhost:8080/_ss')).toBe('http://127.0.0.1:11470/abcdef/3?tr=x');
  });

  it('durée valide : 60 s à 24 h', () => {
    expect([59, 60, 1440, 86400, 86401, NaN].map(validAnalyzeDuration)).toEqual([false, true, true, true, false, false]);
  });

  it('nouvelle interrogation : seulement pendant l’analyse, en lecture, toutes les 30 s, 10 fois', () => {
    const base = { analyzing: true, polls: 0, lastAt: 0, now: REPOLL_EVERY_MS, playing: true };
    expect(shouldRepoll(base)).toBe(true);
    expect(shouldRepoll({ ...base, now: REPOLL_EVERY_MS - 1 })).toBe(false);
    expect(shouldRepoll({ ...base, analyzing: false })).toBe(false);
    expect(shouldRepoll({ ...base, playing: false })).toBe(false);
    expect(shouldRepoll({ ...base, polls: REPOLL_MAX })).toBe(false);
    expect(shouldRepoll({ ...base, polls: REPOLL_MAX - 1 })).toBe(true);
  });
});
