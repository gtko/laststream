import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebAudio, type WebAudioHost } from '../src/player/webaudio/controller';
import type { WebAudioFallback } from '../src/player/webaudio/engine';
import { prepareWebAudio, type PrepareDeps } from '../src/player/webaudio/prepare';
import type { InspectedAudio } from '../src/player/webaudio/source';
import { NOTE_CORS, NOTE_DTS, NOTE_STALLED } from '../src/player/webaudio/policy';

import { rangeDenied, resetRangeMemory } from '../src/sources/hostRange';

/* Sélection du mode et repli CORS, avec des mocks : sonde de plage, en-tête et moteur sont injectés. */

const caps = { audioCodecs: ['aac', 'mp3', 'opus'], videoCodecs: ['h264'] };
const URL_ = 'https://hote.example/film.mkv';

type View = { index: number; filename: string; playable: boolean; stream: { url: string } };
const view = (index: number, filename: string): View => ({ index, filename, playable: true, stream: { url: 'https://h/' + index } });

function fakeVideo() {
  const v = Object.assign(new EventTarget(), {
    currentTime: 0, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1, volume: 1, muted: false,
    webkitAudioDecodedByteCount: 0 as number | undefined,
    play: () => Promise.resolve(), pause: () => undefined,
  });
  return v;
}

function inspected(codec: string, container = 'Matroska', canDecode = true): InspectedAudio {
  return {
    info: { codec, container, sampleRate: 48000, channels: 6, duration: 100 },
    canDecode,
    createSource: () => { throw new Error('non utilisé'); },
    close: vi.fn(),
  };
}

function engineStub(): WebAudioFallback {
  return { start: vi.fn(), destroy: vi.fn(), holding: false, muted: false, volume: 1 } as unknown as WebAudioFallback;
}

function setup(over: Partial<WebAudioHost<View>> = {}) {
  const video = fakeVideo();
  const host: WebAudioHost<View> = {
    video, caps,
    attach: vi.fn(), onChange: vi.fn(), toast: vi.fn(),
    alternatives: () => [view(0, 'Film.DDP5.1.mkv'), view(1, 'Film.1080p.AAC.mp4')],
    currentIndex: () => 0,
    probeView: async () => null,
    describe: (v) => 'source ' + v.index,
    play: vi.fn(), setMode: vi.fn(),
    ...over,
  };
  return { video, host };
}

const input = { url: URL_, nameCodec: 'eac3', stale: () => false };

describe('controller du son de repli', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('E-AC-3 non lu par le navigateur, CORS permis : le moteur de l’app est attaché et démarré', async () => {
    const { host } = setup();
    const engine = engineStub();
    const deps: PrepareDeps = { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('eac3'), createEngine: () => engine };
    const h = await startWebAudio(host, input, deps);
    expect(h.plan.mode).toBe('app');
    expect(host.attach).toHaveBeenCalledWith(engine);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(host.setMode).toHaveBeenCalledWith('app', '');
    expect(host.toast).toHaveBeenCalledWith('Son décodé par l’app', 3500);
    h.dispose();
    expect(engine.destroy).toHaveBeenCalled();
  });

  it('CORS refusé : note claire, puis meilleure source au son lisible proposée avec un bouton', async () => {
    const { host } = setup();
    const inspect = vi.fn();
    const h = await startWebAudio(host, input, { probeRange: async () => 'denied', inspect });
    expect(h.plan).toEqual({ mode: 'cors', note: NOTE_CORS });
    expect(inspect).not.toHaveBeenCalled(); // l'en-tête est illisible : pas d'essai
    expect(host.attach).not.toHaveBeenCalled();
    expect(host.setMode).toHaveBeenCalledWith('cors', NOTE_CORS);
    expect(host.toast).toHaveBeenCalledWith(NOTE_CORS, 9000);
    await vi.waitFor(() => expect((host.toast as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));
    const [msg, ms, action] = (host.toast as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(msg).toContain(NOTE_CORS);
    expect(msg).toContain('source 1');
    expect(ms).toBe(20000);
    action.run();
    expect(host.play).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it('CORS refusé sans alternative lisible : la note seule', async () => {
    const { host } = setup({ alternatives: () => [view(0, 'Film.DDP5.1.mkv'), view(2, 'Autre.DTS.mkv')] });
    await startWebAudio(host, input, { probeRange: async () => 'denied' });
    await vi.advanceTimersByTimeAsync(50);
    expect((host.toast as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('DTS lu dans l’en-tête : note DTS et alternative proposée', async () => {
    const { host } = setup();
    const deps: PrepareDeps = { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('dts', 'Matroska', false) };
    const h = await startWebAudio(host, { ...input, nameCodec: null }, deps);
    expect(h.plan).toMatchObject({ mode: 'unsupported', note: NOTE_DTS });
    expect(host.toast).toHaveBeenCalledWith(NOTE_DTS, 9000);
    await vi.waitFor(() => expect((host.toast as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));
  });

  it('DTS annoncé par le nom, en-tête illisible (CORS) : note DTS, pas « son non disponible »', async () => {
    const { host } = setup();
    const h = await startWebAudio(host, { ...input, nameCodec: 'dts' }, { probeRange: async () => 'denied' });
    expect(h.plan).toMatchObject({ mode: 'unsupported', note: NOTE_DTS });
  });

  it('le moteur abandonne le son (délai) : note persistante, alternative proposée, mode « error »', async () => {
    const { host } = setup();
    let fail: () => void = () => undefined;
    const engine = engineStub();
    const deps: PrepareDeps = {
      probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('eac3'),
      createEngine: (_v, _a, opts) => { fail = () => opts?.onError?.(new Error('délai')); return engine; },
    };
    await startWebAudio(host, input, deps);
    fail();
    expect(host.setMode).toHaveBeenLastCalledWith('error', NOTE_STALLED);
    await vi.waitFor(() => expect((host.toast as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('source 1'))).toBe(true));
  });

  it('en-tête jamais livré (Range lent, index MKV introuvable) : après 10 s, note persistante et alternative', async () => {
    const { host } = setup();
    const closeLate = vi.fn();
    let resolveLate: (i: InspectedAudio) => void = () => undefined;
    const deps: PrepareDeps = {
      probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }),
      inspect: () => new Promise<InspectedAudio>((r) => { resolveLate = r; }),
    };
    const pending = startWebAudio(host, input, deps);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(host.setMode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    const h = await pending;
    expect(h.plan).toEqual({ mode: 'stalled', note: NOTE_STALLED });
    expect(host.setMode).toHaveBeenCalledWith('error', NOTE_STALLED);
    expect(host.attach).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((host.toast as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('source 1'))).toBe(true));
    resolveLate({ ...inspected('eac3'), close: closeLate });
    await vi.advanceTimersByTimeAsync(10);
    expect(closeLate).toHaveBeenCalled(); // l'ouverture tardive est libérée
  });

  it('hôte refusé : mémorisé (sans chemin ni requête) pour le sélecteur', async () => {
    resetRangeMemory();
    const { host } = setup();
    await startWebAudio(host, { ...input, url: 'https://f.example.ca/secret/chemin.mkv?token=abc' }, { probeRange: async () => 'denied' });
    expect(rangeDenied('https://f.example.ca/autre.mkv')).toBe(true);
    expect(rangeDenied('https://autre.example/film.mkv')).toBe(false);
    resetRangeMemory();
  });

  it('AAC : le navigateur joue seul, aucun moteur, aucune note', async () => {
    const { host } = setup();
    const deps: PrepareDeps = { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('aac', 'MP4') };
    const h = await startWebAudio(host, { ...input, nameCodec: 'aac' }, deps);
    expect(h.plan.mode).toBe('native');
    expect(host.attach).not.toHaveBeenCalled();
    expect(host.toast).not.toHaveBeenCalled();
    h.dispose();
  });

  it('CORS refusé mais le nom annonce un son lisible (AAC) : le navigateur garde la main, pas de fausse alerte', async () => {
    const { host } = setup();
    const h = await startWebAudio(host, { ...input, nameCodec: 'aac' }, { probeRange: async () => 'denied' });
    expect(h.plan.mode).toBe('native');
    expect(host.toast).not.toHaveBeenCalled();
    h.dispose();
  });

  it('navigateur muet malgré canPlayType (octets décodés à 0 après 2,5 s) : l’app prend le relais', async () => {
    const { host, video } = setup();
    const engine = engineStub();
    const withEac3 = { ...caps, audioCodecs: [...caps.audioCodecs, 'eac3'] };
    const deps: PrepareDeps = { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('eac3', 'MP4'), createEngine: () => engine };
    const h = await startWebAudio({ ...host, caps: withEac3 }, input, deps);
    expect(h.plan.mode).toBe('native');
    for (let i = 0; i < 4; i++) { video.currentTime += 1; await vi.advanceTimersByTimeAsync(1000); }
    expect(host.attach).toHaveBeenCalledWith(engine);
    expect(engine.start).toHaveBeenCalled();
    expect(h.plan.mode).toBe('app');
    h.dispose();
  });

  it('navigateur qui décode vraiment : aucune bascule', async () => {
    const { host, video } = setup();
    video.webkitAudioDecodedByteCount = 123456;
    const withEac3 = { ...caps, audioCodecs: [...caps.audioCodecs, 'eac3'] };
    const deps: PrepareDeps = { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('eac3', 'MP4') };
    const h = await startWebAudio({ ...host, caps: withEac3 }, input, deps);
    for (let i = 0; i < 5; i++) { video.currentTime += 1; await vi.advanceTimersByTimeAsync(1000); }
    expect(host.attach).not.toHaveBeenCalled();
    expect(h.plan.mode).toBe('native');
    h.dispose();
  });

  it('lecture changée entre-temps (stale) : tout est libéré, rien n’est attaché', async () => {
    const { host } = setup();
    const engine = engineStub();
    let stale = false;
    const deps: PrepareDeps = {
      probeRange: async () => { stale = true; return 'ok'; },
      reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => inspected('eac3'), createEngine: () => engine,
    };
    await startWebAudio(host, { ...input, stale: () => stale }, deps);
    expect(host.attach).not.toHaveBeenCalled();
  });
});

describe('préparation : mode et codec', () => {
  it('lien non HTTP(S), HLS ou hors navigateur : aucun repli', async () => {
    const video = fakeVideo();
    const base = { video, url: URL_, caps, web: true, hls: false, nameCodec: null };
    expect((await prepareWebAudio({ ...base, url: 'magnet:?xt=urn:btih:abc' })).plan.mode).toBe('none');
    expect((await prepareWebAudio({ ...base, hls: true })).plan.mode).toBe('none');
    expect((await prepareWebAudio({ ...base, web: false })).plan.mode).toBe('none');
  });

  it('en-tête illisible malgré la sonde : le navigateur garde la main', async () => {
    const p = await prepareWebAudio(
      { video: fakeVideo(), url: URL_, caps, web: true, hls: false, nameCodec: null },
      { probeRange: async () => 'ok', reader: () => ({ size: async () => 1, read: async () => new Uint8Array(1) }), inspect: async () => { throw new Error('conteneur inconnu'); } },
    );
    expect(p.plan.mode).toBe('native');
  });
});
