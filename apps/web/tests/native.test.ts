import { describe, expect, it, vi } from 'vitest';
import { chooseEngine } from '../src/player/engine';
import { NativeEngine } from '../src/player/engines.js';
import { nativeAudioTracks, nativeSubtitleTracks, toNativeSegments, toNativeSubtitles } from '../src/player/native';
import { cleartextAllowed, isLanHost, streamingServerFor } from '../src/data/lan';
import { normalizeBase } from '../src/data/config';
import type { SubtitleTrack } from '../src/player/tracks';

describe('réseau local (http Android)', () => {
  it.each(['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.254', '169.254.1.1', 'monpc.local', '[::1]', 'fd12:3456::1'])('%s est local', (h) => {
    expect(isLanHost(h)).toBe(true);
  });
  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', 'example.com', '300.1.1.1', 'monpc', 'nas.internal', ''])('%s n’est pas local', (h) => {
    expect(isLanHost(h)).toBe(false);
  });
  it('autorise https partout, http seulement en local', () => {
    expect(cleartextAllowed('https://example.com')).toBe(true);
    expect(cleartextAllowed('http://192.168.1.20:7000')).toBe(true);
    expect(cleartextAllowed('http://example.com')).toBe(false);
    expect(cleartextAllowed('ftp://192.168.1.1')).toBe(false);
  });
  it('déduit le serveur de streaming du PC', () => {
    expect(streamingServerFor('http://192.168.1.20:7000')).toBe('http://192.168.1.20:11470');
    expect(streamingServerFor('https://nas.local/addon')).toBe('https://nas.local:11470');
    expect(streamingServerFor('pas une adresse')).toBe('');
  });
  it('hors Android, normalizeBase garde l’ancien comportement', () => {
    expect(normalizeBase('http://example.com/')).toBe('http://example.com');
  });
});

describe('moteur natif', () => {
  const base = { torrent: false, shell: false, serverUp: false, probe: null, caps: { formats: [], videoCodecs: [], audioCodecs: [], maxAudioChannels: 2 }, notWebReady: true, name: 'x.mkv' };
  it('le lecteur natif prime sur tout, même pour du HEVC sans serveur', () => {
    const c = chooseEngine({ ...base, native: true });
    expect(c.engine).toBe('native');
    expect(chooseEngine({ ...base, native: true, torrent: true }).viaServer).toBe(true);
  });
  it('sans natif, le choix existant est inchangé', () => {
    expect(chooseEngine({ ...base, shell: true }).engine).toBe('mpv');
    expect(chooseEngine(base).engine).toBe('direct');
  });
});

describe('conversions vers le plugin', () => {
  it('segments : champs utiles seulement', () => {
    expect(toNativeSegments([{ kind: 'intro', start: 1, end: 9 }, { kind: 'credits', start: 100, end: 120, inferred: true, confidence: 0.4 }])).toEqual([
      { kind: 'intro', start: 1, end: 9 }, { kind: 'credits', start: 100, end: 120, inferred: true, confidence: 0.4 },
    ]);
  });
  const sub = (lang: string, n: number): SubtitleTrack => ({ id: lang + n, lang, label: lang + n, codec: '', forced: false, origin: 'external', renderable: true, selected: false, url: 'http://s/' + lang + n });
  it('sous-titres : langue préférée (4 max) puis anglais (2 max)', () => {
    const list = [...[1, 2, 3, 4, 5].map((n) => sub('fr', n)), ...[1, 2, 3].map((n) => sub('en', n)), sub('de', 1)];
    const out = toNativeSubtitles(list, 'fr');
    expect(out.map((s) => s.label)).toEqual(['fr1', 'fr2', 'fr3', 'fr4', 'en1', 'en2']);
  });
  it('pistes natives vers pistes du lecteur', () => {
    const a = nativeAudioTracks([{ id: 1, label: 'Français · EAC3 5.1', lang: 'fr', selected: true }]);
    expect(a[0]).toMatchObject({ id: '1', lang: 'fr', selected: true });
    const s = nativeSubtitleTracks([{ id: 4, label: 'Français (forcés)', lang: 'fr', selected: false }]);
    expect(s[0]).toMatchObject({ id: '4', forced: true, origin: 'embedded', engineId: 4 });
  });
});

describe('NativeEngine', () => {
  function fakePlugin() {
    const handlers = new Map<string, (d: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
      open: vi.fn(async () => {}), close: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
      seek: vi.fn(async () => {}), setRate: vi.fn(async () => {}), setAudioTrack: vi.fn(async () => {}), setSubtitleTrack: vi.fn(async () => {}),
      addSubtitles: vi.fn(async () => {}), update: vi.fn(async () => {}),
    };
    return { plugin, fire: (ev: string, d: unknown) => handlers.get(ev)?.(d) };
  }

  it('ouvre le lecteur, relaie l’état et signale « ready »', async () => {
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    const ready = vi.fn();
    e.on('ready', ready);
    await e.load({ url: 'http://x/a.mkv', startAt: 42, open: { title: 'T' } });
    expect(plugin.open).toHaveBeenCalledWith({ title: 'T', url: 'http://x/a.mkv', startPosition: 42 });
    fire('state', { position: 43, duration: 3000, paused: false, buffering: false, rate: 1 });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(e.state()).toMatchObject({ time: 43, duration: 3000, paused: false, rate: 1 });
  });

  it('relaie fin, erreur, fermeture et épisode suivant ; ignore les évènements après destroy', async () => {
    vi.useFakeTimers();
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    const got: string[] = [];
    (['ended', 'error', 'closed', 'next', 'trackChanged'] as const).forEach((ev) => e.on(ev, () => got.push(ev)));
    await e.load({ url: 'u', startAt: 0, open: {} });
    fire('ended', {}); fire('error', { code: 'decode' }); fire('closed', { position: 1 }); fire('nextEpisode', {}); fire('trackChanged', { kind: 'audio' });
    expect(got).toEqual(['ended', 'error', 'closed', 'next', 'trackChanged']);
    e.destroy();
    fire('ended', {});
    expect(got).toHaveLength(5);
    vi.advanceTimersByTime(800);
    expect(plugin.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('un load juste après destroy réutilise l’activité (pas de fermeture)', async () => {
    vi.useFakeTimers();
    const { plugin } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'a', startAt: 0, open: {} });
    e.destroy();
    await e.load({ url: 'b', startAt: 0, open: {} });
    vi.advanceTimersByTime(2000);
    expect(plugin.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('commandes et pistes', async () => {
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'u', startAt: 0, open: {} });
    fire('tracks', { audio: [{ id: 1, label: 'Anglais', lang: 'en', selected: true }], subs: [{ id: 3, label: 'Français', lang: 'fr', selected: false }] });
    expect(e.audioTracks()).toHaveLength(1);
    e.setAudioTrack('2'); e.setSubtitleTrack(null); e.setSubtitleTrack('3'); e.seek(12); e.setRate(1.5); e.pause(); e.play();
    expect(plugin.setAudioTrack).toHaveBeenCalledWith({ id: 2 });
    expect(plugin.setSubtitleTrack).toHaveBeenNthCalledWith(1, { id: -1 });
    expect(plugin.setSubtitleTrack).toHaveBeenNthCalledWith(2, { id: 3 });
    expect(plugin.seek).toHaveBeenCalledWith({ position: 12 });
    expect(plugin.setRate).toHaveBeenCalledWith({ rate: 1.5 });
  });
});
