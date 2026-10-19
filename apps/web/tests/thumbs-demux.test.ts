// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ByteSource, avcCodecString, av1CodecString, canDecode, decodeKeyframe, hashText, hevcCodecString, makeLocalFeed, MemoryThumbStore, openVideoIndex,
  proxyFetchRange, proxyRangeUrl, readId, readSize, thumbKey, THUMB_QUALITY, totalFromContentRange, webCodecsAvailable,
  type CodecEnv, type FetchFn, type FetchRange, type VideoIndex } from '../src/thumbs';
import { ThumbFeed } from '../src/player/thumbfeed';
import { thumbSource } from '../src/player/thumbs';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Fichier servi par plages ; journalise les plages demandées (début, fin incluse). */
function served(file: Uint8Array): { fetchRange: FetchRange; log: [number, number][] } {
  const log: [number, number][] = [];
  const fetchRange: FetchRange = async (start, end) => {
    log.push([start, end]);
    if (start >= file.length) return { data: new Uint8Array(0), total: file.length };
    return { data: file.slice(start, Math.min(end + 1, file.length)), total: file.length };
  };
  return { fetchRange, log };
}

/** Les NAL d'un échantillon à longueurs de 4 octets doivent couvrir exactement l'échantillon ; renvoie leurs types. */
function nalTypes(sample: Uint8Array, codec: 'h264' | 'hevc'): number[] {
  const types: number[] = [];
  let p = 0;
  while (p + 4 <= sample.length) {
    const len = ((sample[p] << 24) | (sample[p + 1] << 16) | (sample[p + 2] << 8) | sample[p + 3]) >>> 0;
    if (len === 0 || p + 4 + len > sample.length) return [];
    types.push(codec === 'h264' ? sample[p + 4] & 31 : (sample[p + 4] >> 1) & 63);
    p += 4 + len;
  }
  return p === sample.length ? types : [];
}
const isIdr = (types: number[], codec: 'h264' | 'hevc'): boolean =>
  types.some((t) => (codec === 'h264' ? t === 5 : t >= 16 && t <= 21));

async function open(name: string, file = fixture(name), options = {}): Promise<{ index: VideoIndex; source: ByteSource; log: [number, number][] }> {
  const s = served(file);
  const r = await openVideoIndex(s.fetchRange, options);
  if (r === null) throw new Error(`index null pour ${name}`);
  return { ...r, log: s.log };
}

const KEY_TIMES = [0, 2, 4, 6, 8];

describe('MP4 H.264 : index des images clés', () => {
  for (const name of ['h264.mp4', 'h264-faststart.mp4']) {
    it(`${name} : 5 images clés exactes, échantillons valides`, async () => {
      const file = fixture(name);
      const { index } = await open(name, file, { headBytes: 16 * 1024 });
      expect(index.info.container).toBe('mp4');
      expect(index.info.codec).toBe('h264');
      expect(index.info.width).toBe(320);
      expect(index.info.height).toBe(180);
      expect(index.info.duration).toBeCloseTo(10, 1);
      expect(index.keyframeCount).toBe(5);
      const seen: number[] = [];
      for (const t of KEY_TIMES) {
        const ref = await index.keyframeAt(t + 0.3);
        expect(ref).not.toBeNull();
        expect(ref!.timestamp).toBeCloseTo(t, 3);
        expect(ref!.offset + ref!.size!).toBeLessThanOrEqual(file.length);
        const sample = (await index.readSample(ref!))!;
        expect(sample.length).toBe(ref!.size);
        expect(isIdr(nalTypes(sample, 'h264'), 'h264')).toBe(true);
        seen.push(ref!.timestamp);
      }
      expect(seen.length).toBe(5);
    });
  }

  it('codec string = octets 1 à 3 de l\'avcC', async () => {
    const { index } = await open('h264.mp4');
    const d = index.info.description;
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
    expect(index.info.codecString).toBe(`avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}`);
    expect(index.info.codecString).toMatch(/^avc1\.[0-9A-F]{6}$/);
    expect(avcCodecString(new Uint8Array([1, 0x64, 0, 0x1f]))).toBe('avc1.64001F');
    expect(avcCodecString(new Uint8Array([2, 0x64, 0, 0x1f]))).toBeNull();
  });

  it('sélection : la plus proche, égalité vers l\'arrière, bornes', async () => {
    const { index } = await open('h264.mp4');
    expect((await index.keyframeAt(5))!.timestamp).toBeCloseTo(4, 3); // à égale distance de 4 et 6
    expect((await index.keyframeAt(5.1))!.timestamp).toBeCloseTo(6, 3);
    expect((await index.keyframeAt(-10))!.timestamp).toBeCloseTo(0, 3);
    expect((await index.keyframeAt(9999))!.timestamp).toBeCloseTo(8, 3);
  });

  it('plages demandées : moov en fin de fichier lu sans télécharger le mdat, une plage par échantillon', async () => {
    const file = fixture('h264.mp4');
    const { index, source, log } = await open('h264.mp4', file, { headBytes: 8 * 1024 });
    const afterIndex = log.length;
    expect(source.size).toBe(file.length);
    expect(source.bytes).toBeLessThan(file.length / 4); // en-têtes + moov seulement
    expect(log.every(([s, e]) => e - s + 1 <= 4 * 1024 * 1024)).toBe(true);
    const ref = (await index.keyframeAt(4))!;
    await index.readSample(ref);
    expect(log.length).toBe(afterIndex + 1);
    expect(log[afterIndex]).toEqual([ref.offset, ref.offset + ref.size! - 1]);
  });

  it('plage de 4 Mo au plus même pour une grande lecture', async () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    const s = served(big);
    const src = new ByteSource(s.fetchRange, { headBytes: 1024 });
    await src.open();
    const out = await src.read(0, 9 * 1024 * 1024);
    expect(out.length).toBe(9 * 1024 * 1024);
    expect(Math.max(...s.log.map(([a, b]) => b - a + 1))).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('MKV : index des images clés', () => {
  it('h264.mkv par Cues : instants exacts, échantillons valides', async () => {
    const file = fixture('h264.mkv');
    const { index } = await open('h264.mkv', file, { headBytes: 16 * 1024 });
    expect(index.info.container).toBe('mkv');
    expect(index.info.codec).toBe('h264');
    expect(index.info.width).toBe(320);
    expect(index.info.height).toBe(180);
    expect(index.info.duration).toBeCloseTo(10, 1);
    expect(index.keyframeCount).toBe(5);
    for (const t of KEY_TIMES) {
      const ref = (await index.keyframeAt(t + 0.4))!;
      expect(Math.abs(ref.timestamp - t)).toBeLessThan(0.06); // MKV : instants du conteneur (décalage B-frames, ~46 ms)
      const sample = (await index.readSample(ref))!;
      expect(isIdr(nalTypes(sample, 'h264'), 'h264')).toBe(true);
    }
  });

  it('même image clé que le MP4 (mêmes octets) à chaque instant', async () => {
    const mp4 = (await open('h264.mp4')).index;
    const mkv = (await open('h264.mkv')).index;
    for (const t of [0, 4, 8]) {
      const a = (await mp4.readSample((await mp4.keyframeAt(t))!))!;
      const b = (await mkv.readSample((await mkv.keyframeAt(t))!))!;
      expect(a.length).toBe(b.length);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  it('sans Cues : dichotomie de Clusters, bloc clé valide', async () => {
    const file = fixture('h264.mkv').slice();
    // Remplace l'élément Cues par un Void de même taille (l'entrée du SeekHead pointe alors sur autre chose).
    const at = findBytes(file, [0x1c, 0x53, 0xbb, 0x6b]);
    expect(at).toBeGreaterThan(0);
    const sz = readSize(file, at + 4)!;
    const total = 4 + sz.len + sz.value;
    const newLen = sz.len + 3;
    file[at] = 0xec;
    const first = 0x80 >> (newLen - 1);
    let v = sz.value;
    for (let i = newLen; i >= 1; i -= 1) { file[at + i] = v & 0xff; v = Math.floor(v / 256); }
    file[at + 1] = (file[at + 1] & (0xff >> newLen)) | first;
    expect(1 + newLen + sz.value).toBe(total);
    const s = served(file);
    const r = (await openVideoIndex(s.fetchRange, { headBytes: 16 * 1024 }))!;
    expect(r.index.keyframeCount).toBe(0);
    const ref = (await r.index.keyframeAt(5))!;
    expect(ref).not.toBeNull();
    expect(ref.timestamp).toBeLessThanOrEqual(5);
    const sample = (await r.index.readSample(ref))!;
    expect(isIdr(nalTypes(sample, 'h264'), 'h264')).toBe(true);
    // Le bloc lu fait partie des images clés réelles du fichier.
    const withCues = (await open('h264.mkv')).index;
    const known = await Promise.all(KEY_TIMES.map(async (t) => (await withCues.readSample((await withCues.keyframeAt(t))!))!));
    expect(known.some((k) => Buffer.from(k).equals(Buffer.from(sample)))).toBe(true);
  });

  it('EBML : identifiants et tailles', () => {
    expect(readId(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0)).toEqual({ id: 0x1a45dfa3, len: 4 });
    expect(readId(new Uint8Array([0xa3]), 0)).toEqual({ id: 0xa3, len: 1 });
    expect(readSize(new Uint8Array([0x81]), 0)).toEqual({ value: 1, len: 1 });
    expect(readSize(new Uint8Array([0x40, 0x02]), 0)).toEqual({ value: 2, len: 2 });
    expect(readSize(new Uint8Array([0xff]), 0)).toEqual({ value: -1, len: 1 }); // taille inconnue
  });
});

describe('HEVC', () => {
  it('MP4 et MKV : même codec string hvc1.1.6.L…, échantillons IDR/CRA', async () => {
    const mp4 = (await open('hevc.mp4')).index;
    const mkv = (await open('hevc.mkv')).index;
    expect(mp4.info.codec).toBe('hevc');
    expect(mp4.info.codecString).toMatch(/^hvc1\.1\.6\.L\d+(\.[0-9A-F]+)*$/);
    expect(mkv.info.codecString).toBe(mp4.info.codecString);
    for (const idx of [mp4, mkv]) {
      expect(idx.keyframeCount).toBeGreaterThanOrEqual(3);
      const ref = (await idx.keyframeAt(2))!;
      expect(ref.timestamp).toBeCloseTo(2, 2);
      expect(isIdr(nalTypes((await idx.readSample(ref))!, 'hevc'), 'hevc')).toBe(true);
    }
  });

  it('hvcC et av1C construits à la main', () => {
    // profil 1 (Main), compat 0x60000000, niveau 93, contraintes B0 00… → hvc1.1.6.L93.B0
    const hvcC = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0, 0]);
    expect(hevcCodecString(hvcC)).toBe('hvc1.1.6.L93.B0');
    expect(hevcCodecString(hvcC, 'hev1')).toBe('hev1.1.6.L93.B0');
    expect(hevcCodecString(new Uint8Array([1, 0x22, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 0, 0]))).toBe('hvc1.2.8.H120');
    expect(hevcCodecString(new Uint8Array(5))).toBeNull();
    expect(av1CodecString(new Uint8Array([0x81, 0x08, 0x0c, 0]))).toBe('av01.0.08M.08');
    expect(av1CodecString(new Uint8Array([0x81, 0x09, 0xcc, 0]))).toBe('av01.0.09H.10');
    expect(av1CodecString(new Uint8Array([0x81, 0x28, 0x2c, 0]))).toBe('av01.1.08M.12');
    expect(av1CodecString(new Uint8Array([0x01, 0, 0, 0]))).toBeNull();
  });
});

describe('WebCodecs simulé', () => {
  interface Spy { configs: Record<string, unknown>[]; chunks: { type: string; data: Uint8Array }[]; canvases: [number, number][]; closed: number; qualities: number[] }
  function fakeEnv(opts: { supported?: boolean; fail?: boolean; blobType?: string } = {}): { env: CodecEnv; spy: Spy } {
    const spy: Spy = { configs: [], chunks: [], canvases: [], closed: 0, qualities: [] };
    class FakeDecoder {
      constructor(private readonly init: { output: (f: { displayWidth: number; displayHeight: number; close(): void }) => void; error: (e: unknown) => void }) {}
      static isConfigSupported(): Promise<{ supported: boolean }> { return Promise.resolve({ supported: opts.supported !== false }); }
      configure(c: Record<string, unknown>): void { spy.configs.push(c); }
      decode(chunk: { type: string; data: Uint8Array }): void { spy.chunks.push(chunk); }
      flush(): Promise<void> {
        if (opts.fail) { this.init.error(new Error('boom')); return Promise.reject(new Error('boom')); }
        this.init.output({ displayWidth: 320, displayHeight: 180, close: () => { spy.closed += 1; } });
        return Promise.resolve();
      }
      close(): void { /* rien */ }
    }
    class FakeChunk { constructor(init: { type: string; timestamp: number; data: Uint8Array }) { Object.assign(this, init); } }
    class FakeCanvas {
      constructor(w: number, h: number) { spy.canvases.push([w, h]); }
      getContext(): { drawImage(): void } { return { drawImage: () => undefined }; }
      convertToBlob(o: { type: string; quality: number }): Promise<Blob> {
        spy.qualities.push(o.quality);
        const type = opts.blobType ?? o.type;
        return Promise.resolve(new Blob([`img:${o.type}`], { type }));
      }
    }
    return { env: { VideoDecoder: FakeDecoder as never, EncodedVideoChunk: FakeChunk as never, OffscreenCanvas: FakeCanvas as never }, spy };
  }

  it('disponibilité et prise en charge du codec', async () => {
    expect(webCodecsAvailable({})).toBe(false);
    const { env } = fakeEnv();
    expect(webCodecsAvailable(env)).toBe(true);
    const { index } = await open('h264.mp4');
    expect(await canDecode(index.info, env)).toBe(true);
    expect(await canDecode(index.info, fakeEnv({ supported: false }).env)).toBe(false);
    expect(await canDecode(index.info, {})).toBe(false);
  });

  it('décode un échantillon clé en WebP 160 px (ratio conservé) avec la bonne configuration', async () => {
    const { index } = await open('h264.mp4');
    const sample = (await index.readSample((await index.keyframeAt(2))!))!;
    const { env, spy } = fakeEnv();
    const blob = await decodeKeyframe(sample, index.info, {}, env);
    expect(blob?.type).toBe('image/webp');
    expect(spy.configs[0].codec).toBe(index.info.codecString);
    expect(spy.configs[0].description).toBe(index.info.description);
    expect(spy.chunks).toHaveLength(1);
    expect(spy.chunks[0].type).toBe('key');
    expect(spy.chunks[0].data).toBe(sample);
    expect(spy.canvases[0]).toEqual([160, 90]);
    expect(spy.closed).toBe(1);
    expect(THUMB_QUALITY).toBe(0.6);
    expect(spy.qualities).toEqual([0.6]);
  });

  it('repli JPEG si le WebP n\'est pas encodé ; null sur erreur du décodeur', async () => {
    const { index } = await open('h264.mp4');
    const sample = (await index.readSample((await index.keyframeAt(0))!))!;
    const fallback = fakeEnv({ blobType: 'image/png' });
    const jpeg = await decodeKeyframe(sample, index.info, {}, fallback.env);
    expect(jpeg).not.toBeNull();
    expect(await jpeg!.text()).toBe('img:image/jpeg');
    expect(fallback.spy.qualities).toEqual([0.6, 0.6]); // WebP refusé, JPEG à la même qualité
    expect(await decodeKeyframe(sample, index.info, {}, fakeEnv({ fail: true }).env)).toBeNull();
    expect(await decodeKeyframe(sample, index.info, {}, {})).toBeNull();
  });
});

/** Le Worker en miniature : lit s/e dans l'URL et sert la plage du fichier (206 + Content-Range). */
function workerFetch(file: Uint8Array, calls: string[], status = 206): FetchFn {
  return async (url) => {
    calls.push(url);
    if (status !== 206) return { status, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    const q = new URL(url).searchParams;
    const s = Number(q.get('s'));
    const e = Math.min(Number(q.get('e')), file.length - 1);
    if (s >= file.length) return { status: 416, headers: new Headers({ 'content-range': `bytes */${file.length}` }), arrayBuffer: async () => new ArrayBuffer(0) };
    const body = file.slice(s, e + 1);
    return { status: 206, headers: new Headers({ 'content-range': `bytes ${s}-${e}/${file.length}` }), arrayBuffer: async () => body.buffer };
  };
}

describe('relais et pont ThumbFeed', () => {
  const src = { url: 'https://abc.debrid.it/f.mkv', token: '123.tok', base: 'https://edge.test' };

  it('URL du relais et Content-Range', () => {
    const u = new URL(proxyRangeUrl(src, 10, 99));
    expect(u.origin + u.pathname).toBe('https://edge.test/__laststream/range');
    expect(Object.fromEntries(u.searchParams)).toEqual({ u: src.url, s: '10', e: '99', t: '123.tok' });
    expect(totalFromContentRange('bytes 0-9/1234')).toBe(1234);
    expect(totalFromContentRange('bytes */77')).toBe(77);
    expect(totalFromContentRange(null)).toBeNull();
  });

  it('lit un MP4 à travers le relais', async () => {
    const calls: string[] = [];
    const r = await openVideoIndex(proxyFetchRange(src, workerFetch(fixture('h264.mp4'), calls)));
    expect(r!.index.keyframeCount).toBe(5);
    expect(calls.every((c) => c.startsWith('https://edge.test/__laststream/range?'))).toBe(true);
  });

  it('miniature d\'une tranche : décodée, mise en cache, relue sans réseau ; au-delà de la durée : introuvable', async () => {
    const calls: string[] = [];
    const store = new MemoryThumbStore();
    const { env } = (() => { const e = fakeEnvLite(); return e; })();
    const feed = makeLocalFeed({
      sourceId: 'https://addon/play/x', store, env, fetchFn: workerFetch(fixture('h264.mkv'), calls),
      resolve: async () => src,
    });
    const ctl = new AbortController();
    expect(await feed.register(ctl.signal)).toBe('local');
    const url = feed.imageUrl('local', 0);
    const res = await feed.fetchFn(url, { signal: ctl.signal });
    expect(res.status).toBe(200);
    expect((await res.blob()).type).toBe('image/webp');
    const before = calls.length;
    expect((await feed.fetchFn(url, { signal: ctl.signal })).status).toBe(200); // cache
    expect(calls.length).toBe(before);
    expect((await feed.fetchFn(feed.imageUrl('local', 2), { signal: ctl.signal })).status).toBe(404); // 60 s > 10 s
    expect(feed.stats().thumbs).toBe(1);
    expect(thumbKey('a', 1)).toBe(thumbKey('a', 1));
    expect(thumbKey('a', 1)).not.toBe(thumbKey('a', 2));
    expect(hashText('x')).toBe(hashText('x'));
  });

  it('jeton refusé : « unknown_source » pour que ThumbFeed réenregistre ; codec non pris en charge : pas de miniatures', async () => {
    const file = fixture('h264.mp4');
    const calls: string[] = [];
    let status = 206;
    const flaky: FetchFn = (url, init) => workerFetch(file, calls, status)(url, init);
    const { env } = fakeEnvLite();
    const feed = makeLocalFeed({ sourceId: 's', env, source: { headBytes: 512 }, fetchFn: flaky, resolve: async () => src });
    const ctl = new AbortController();
    await feed.register(ctl.signal);
    status = 401;
    const res = await feed.fetchFn(feed.imageUrl('local', 0), { signal: ctl.signal });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_source' });

    const none = makeLocalFeed({ sourceId: 's2', env: fakeEnvLite({ supported: false }).env, fetchFn: workerFetch(file, []), resolve: async () => src });
    expect(await none.register(ctl.signal)).toBeNull();
    const refused = makeLocalFeed({ sourceId: 's3', env, fetchFn: workerFetch(file, []), resolve: async () => null });
    expect(await refused.register(ctl.signal)).toBeNull();
    const noCodecs = makeLocalFeed({ sourceId: 's4', env: {}, fetchFn: workerFetch(file, []), resolve: async () => src });
    expect(await noCodecs.register(ctl.signal)).toBeNull();
  });

  it('ThumbFeed : au plus 2 demandes en vol, tranches de 30 s autour du curseur', async () => {
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    const feed = new ThumbFeed({
      register: async () => 'k',
      imageUrl: (_k, i) => `local:${i}`,
      maxParallel: 2,
      fetchFn: async (url) => {
        asked.push(url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { status: 200, blob: async () => new Blob(['x']), json: async () => ({}) };
      },
      makeUrl: () => 'blob:x', revokeUrl: () => undefined, wait: async () => undefined, onReady: () => undefined,
    });
    feed.request(150, 600); // tranche 5
    await new Promise((r) => setTimeout(r, 60));
    expect(peak).toBe(2);
    expect(asked[0]).toBe('local:5');
    expect(new Set(asked)).toEqual(new Set(['local:5', 'local:6', 'local:4', 'local:7', 'local:3']));
  });

  it('thumbSource : la voie par plages passe avant les autres, sur tous les moteurs', () => {
    for (const engine of ['direct', 'hls', 'mpv', 'native']) {
      expect(thumbSource({ engine, hasMedia: true, serverUp: false, range: true })).toEqual({ mode: 'range' });
    }
    expect(thumbSource({ engine: 'native', hasMedia: true, serverUp: false })).toEqual({ mode: 'none' });
    expect(thumbSource({ engine: 'mpv', hasMedia: true, serverUp: true, addon: true })).toEqual({ mode: 'addon' });
    expect(thumbSource({ engine: 'direct', hasMedia: false, serverUp: true, range: true })).toEqual({ mode: 'none' });
  });
});

function findBytes(b: Uint8Array, pat: number[]): number {
  outer: for (let i = 0; i + pat.length <= b.length; i += 1) {
    for (let j = 0; j < pat.length; j += 1) if (b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

function fakeEnvLite(opts: { supported?: boolean } = {}): { env: CodecEnv } {
  class D {
    constructor(private readonly init: { output: (f: { displayWidth: number; displayHeight: number; close(): void }) => void }) {}
    static isConfigSupported(): Promise<{ supported: boolean }> { return Promise.resolve({ supported: opts.supported !== false }); }
    configure(): void { /* rien */ }
    decode(): void { /* rien */ }
    flush(): Promise<void> { this.init.output({ displayWidth: 320, displayHeight: 180, close: () => undefined }); return Promise.resolve(); }
    close(): void { /* rien */ }
  }
  class C { constructor(init: unknown) { Object.assign(this, init); } }
  class V {
    getContext(): { drawImage(): void } { return { drawImage: () => undefined }; }
    convertToBlob(o: { type: string }): Promise<Blob> { return Promise.resolve(new Blob(['i'], { type: o.type })); }
  }
  return { env: { VideoDecoder: D as never, EncodedVideoChunk: C as never, OffscreenCanvas: V as never } };
}
