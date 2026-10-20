// @vitest-environment node
/* Budget d'arrière-plan des miniatures locales : clé de cache stable, calcul au repos, pause pendant le tamponnage,
 * annulation sans reste, codec non pris en charge sans bruit. Démuxeur réel (fixture MP4), décodeur WebCodecs simulé. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUFFER_RECHECK_MS, IDLE_FALLBACK_MS, IDLE_TIMEOUT_MS, idleSchedule, makeLocalFeed, MemoryThumbStore, stableSourceId, thumbKey,
  type CodecEnv, type FetchFn, type LocalFeedOptions, type ScheduleFn,
} from '../src/thumbs';
import { ThumbFeed } from '../src/player/thumbfeed';

/** Adresses factices : aucune URL débridée réelle. */
const SOURCE = { url: 'https://debrid.example.test/d/fake-link.mp4' };
const mp4 = (): Uint8Array => new Uint8Array(readFileSync(new URL('./fixtures/h264.mp4', import.meta.url)));

/** Serveur de plages en miniature : sert la plage demandée (en-tête Range) du fichier, avec Content-Range. */
function rangeServer(file: Uint8Array, calls: string[]): FetchFn {
  return async (url, init) => {
    calls.push(url);
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? '');
    const s = Number(m?.[1] ?? 0);
    const e = Math.min(Number(m?.[2] ?? file.length - 1), file.length - 1);
    if (s >= file.length) return { status: 416, headers: new Headers({ 'content-range': `bytes */${file.length}` }), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = file.slice(s, e + 1);
    return { status: 206, headers: new Headers({ 'content-range': `bytes ${s}-${e}/${file.length}` }), arrayBuffer: async () => body.buffer };
  };
}

/** WebCodecs simulé : compte les décodeurs créés ; `supported` pilote isConfigSupported. */
function webCodecs(supported = true): { env: CodecEnv; probe: { created: number } } {
  const probe = { created: 0 };
  class Decoder {
    constructor(private readonly init: { output: (f: { displayWidth: number; displayHeight: number; close(): void }) => void }) { probe.created += 1; }
    static isConfigSupported(): Promise<{ supported: boolean }> { return Promise.resolve({ supported }); }
    configure(): void { /* rien */ }
    decode(): void { /* rien */ }
    flush(): Promise<void> { this.init.output({ displayWidth: 320, displayHeight: 180, close: () => undefined }); return Promise.resolve(); }
    close(): void { /* rien */ }
  }
  class Chunk { constructor(init: object) { Object.assign(this, init); } }
  class Canvas {
    getContext(): { drawImage(): void } { return { drawImage: () => undefined }; }
    convertToBlob(o: { type: string }): Promise<Blob> { return Promise.resolve(new Blob(['i'], { type: o.type })); }
  }
  return { env: { VideoDecoder: Decoder, EncodedVideoChunk: Chunk, OffscreenCanvas: Canvas } as unknown as CodecEnv, probe };
}

function makeFeed(extra: Partial<LocalFeedOptions> = {}, codecs = webCodecs()) {
  const calls: string[] = [];
  const feed = makeLocalFeed({
    sourceId: 'ih:0123456789abcdef:0',
    fetchFn: rangeServer(mp4(), calls),
    env: codecs.env,
    resolve: async () => SOURCE,
    ...extra,
  });
  return { feed, calls, probe: codecs.probe };
}

/** Planification immédiate (la tranche part tout de suite). */
const runNow: ScheduleFn = (run) => { run(); return () => undefined; };
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clé de cache stable', () => {
  it('même torrent et même fichier : même clé, quel que soit le lien débridé', () => {
    const a = stableSourceId({ infoHash: 'ABCDEF0123', fileIdx: 1, url: 'https://d1.example.test/a?token=1' });
    const b = stableSourceId({ infoHash: 'abcdef0123', fileIdx: 1, url: 'https://d2.example.test/b?token=2' });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(thumbKey(a!, 4)).toBe(thumbKey(b!, 4));
  });

  it('un autre fichier du même torrent a sa propre clé', () => {
    expect(stableSourceId({ infoHash: 'abc', fileIdx: 1 })).not.toBe(stableSourceId({ infoHash: 'abc', fileIdx: 2 }));
  });

  it('sans infoHash : empreinte de l’adresse sans query string, jamais l’adresse elle-même', () => {
    const id = stableSourceId({ url: 'https://edge.example.test/files/movie.mp4?token=one' });
    expect(id).not.toBeNull();
    expect(id).toBe(stableSourceId({ url: 'https://edge.example.test/files/movie.mp4?token=two' }));
    expect(id).not.toBe(stableSourceId({ url: 'https://edge.example.test/files/other.mp4?token=one' }));
    expect(id).not.toContain('example');
    expect(id).not.toContain('token');
  });

  it('rien d’exploitable : null', () => {
    expect(stableSourceId({})).toBeNull();
    expect(stableSourceId({ url: '' })).toBeNull();
  });

  it('cache partagé après régénération du lien : la tranche déjà décodée est servie sans réseau ni décodage', async () => {
    const store = new MemoryThumbStore();
    const sourceId = stableSourceId({ infoHash: 'abc', fileIdx: 0, url: 'https://d1.example.test/a?t=1' })!;
    const first = makeFeed({ sourceId, store, schedule: runNow, resolve: async () => ({ ...SOURCE, url: 'https://d1.example.test/a?t=1' }) });
    const ctl = new AbortController();
    expect(await first.feed.register(ctl.signal)).toBe('local');
    expect((await first.feed.fetchFn(first.feed.imageUrl('local', 0), { signal: ctl.signal })).status).toBe(200);

    const second = makeFeed({ sourceId, store, schedule: runNow, resolve: async () => ({ ...SOURCE, url: 'https://d2.example.test/b?t=2' }) });
    expect(await second.feed.register(ctl.signal)).toBe('local');
    const before = second.calls.length;
    expect((await second.feed.fetchFn(second.feed.imageUrl('local', 0), { signal: ctl.signal })).status).toBe(200);
    expect(second.calls.length).toBe(before);
    expect(second.probe.created).toBe(0);
  });
});

describe('calcul de tranche au repos du navigateur', () => {
  it('idleSchedule : requestIdleCallback avec un délai de 2 s, annulable', () => {
    expect(IDLE_TIMEOUT_MS).toBe(2000);
    const requested: Array<{ run: () => void; timeout: number }> = [];
    const cancelled: number[] = [];
    vi.stubGlobal('requestIdleCallback', (run: () => void, o: { timeout: number }) => { requested.push({ run, timeout: o.timeout }); return 7; });
    vi.stubGlobal('cancelIdleCallback', (id: number) => { cancelled.push(id); });
    const run = vi.fn();
    const cancel = idleSchedule(run);
    expect(requested).toHaveLength(1);
    expect(requested[0].timeout).toBe(IDLE_TIMEOUT_MS);
    expect(run).not.toHaveBeenCalled();
    requested[0].run();
    expect(run).toHaveBeenCalledTimes(1);
    cancel();
    expect(cancelled).toEqual([7]);
  });

  it('repli setTimeout quand requestIdleCallback n’existe pas ; annulable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const run = vi.fn();
    idleSchedule(run);
    vi.advanceTimersByTime(IDLE_FALLBACK_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    const cancel = idleSchedule(later);
    cancel();
    vi.advanceTimersByTime(IDLE_FALLBACK_MS * 2);
    expect(later).not.toHaveBeenCalled();
  });

  it('une tranche ne décode rien avant le créneau fourni par schedule', async () => {
    const slots: Array<() => void> = [];
    const schedule = vi.fn((run: () => void) => { slots.push(run); return () => undefined; });
    const { feed, probe } = makeFeed({ schedule });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const pending = feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    await tick();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(probe.created).toBe(0);
    slots[0]();
    expect((await pending).status).toBe(200);
    expect(probe.created).toBe(1);
  });

  it('sans schedule explicite : la tranche attend le repli de 100 ms', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const { feed, probe } = makeFeed();
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const pending = feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_MS - 1);
    expect(probe.created).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(probe.created).toBe(1);
  });
});

describe('pause pendant la mise en mémoire tampon', () => {
  it('tant que la lecture tamponne, aucune tranche ne démarre ; reprise à la re-vérification suivante', async () => {
    vi.useFakeTimers();
    let buffering = true;
    const schedule = vi.fn(runNow);
    const { feed, probe } = makeFeed({ schedule, isBuffering: () => buffering });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const pending = feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(BUFFER_RECHECK_MS * 3);
    expect(schedule).not.toHaveBeenCalled();
    expect(probe.created).toBe(0);
    buffering = false;
    await vi.advanceTimersByTimeAsync(BUFFER_RECHECK_MS);
    expect((await pending).status).toBe(200);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(probe.created).toBe(1);
  });

  it('lecture qui ne tamponne pas : aucune pause', async () => {
    const schedule = vi.fn(runNow);
    const { feed } = makeFeed({ schedule, isBuffering: () => false });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    expect((await feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal })).status).toBe(200);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('annulation sans reste', () => {
  it('annulée pendant la pause : 499, aucun timer restant, aucun décodage', async () => {
    vi.useFakeTimers();
    const { feed, probe } = makeFeed({ isBuffering: () => true });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const pending = feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(BUFFER_RECHECK_MS * 2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ctl.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect((await pending).status).toBe(499);
    expect(probe.created).toBe(0);
  });

  it('annulée pendant le créneau planifié : le créneau est annulé ; un lancement tardif ne décode rien', async () => {
    const cancelled = vi.fn();
    const slots: Array<() => void> = [];
    const schedule = (run: () => void): (() => void) => { slots.push(run); return cancelled; };
    const { feed, probe } = makeFeed({ schedule });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const pending = feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    await tick();
    ctl.abort();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect((await pending).status).toBe(499);
    slots[0]();
    await tick();
    expect(probe.created).toBe(0);
  });

  it('reset de la file (changement de source) : tranches en attente abandonnées, aucun timer ni requête restant', async () => {
    vi.useFakeTimers();
    const { feed, probe } = makeFeed({ isBuffering: () => true });
    const onReady = vi.fn();
    const thumbs = new ThumbFeed({
      register: (signal) => feed.register(signal),
      imageUrl: (key, index) => feed.imageUrl(key, index),
      fetchFn: (url, init) => feed.fetchFn(url, init),
      makeUrl: () => 'blob:x',
      revokeUrl: () => undefined,
      wait: async () => undefined,
      onReady,
    });
    thumbs.request(10, 600);
    await vi.advanceTimersByTimeAsync(BUFFER_RECHECK_MS * 2);
    expect(thumbs.inFlight).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    thumbs.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(thumbs.inFlight).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(probe.created).toBe(0);
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe('codec non pris en charge : silencieux', () => {
  it('HEVC refusé par WebCodecs : pas de miniature, pas d’erreur, pas de log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { feed, probe } = makeFeed({}, webCodecs(false));
    const onReady = vi.fn();
    const thumbs = new ThumbFeed({
      register: (signal) => feed.register(signal),
      imageUrl: (key, index) => feed.imageUrl(key, index),
      fetchFn: (url, init) => feed.fetchFn(url, init),
      makeUrl: () => 'blob:x',
      revokeUrl: () => undefined,
      wait: async () => undefined,
      onReady,
    });
    expect(() => thumbs.request(100, 600)).not.toThrow();
    expect(thumbs.request(100, 600)).toBeNull();
    await tick();
    expect(thumbs.dead).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    expect(probe.created).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('register refuse sans erreur : WebCodecs refusé ou absent', async () => {
    const ctl = new AbortController();
    const refused = makeFeed({}, webCodecs(false));
    expect(await refused.feed.register(ctl.signal)).toBeNull();
    const absent = makeLocalFeed({ sourceId: 's', env: {}, fetchFn: rangeServer(mp4(), []), resolve: async () => SOURCE });
    expect(await absent.register(ctl.signal)).toBeNull();
  });
});
