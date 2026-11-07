// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeAuthError, openVideoIndex, type FetchRange } from '../src/thumbs';
import { ByteSource, MAX_CHUNK } from '../src/thumbs/bytes';
import { openMediabunnyIndex } from '../src/thumbs/mediabunny';

/* mediabunny simulé : les lectures passent par CustomSource.read (end exclu), les paquets sont ceux de `fake.spec`. */
interface Pkt { timestamp: number; key: boolean; data: Uint8Array }
interface Spec {
  mime: string | null;
  codec: string | null;
  cfgCodec: string;
  description: Uint8Array | undefined;
  track: boolean;
  width: number;
  height: number;
  duration: number;
  packets: Pkt[];
}

const fake = vi.hoisted(() => ({
  spec: null as unknown as Spec,
  created: 0,
  disposed: 0,
}));

vi.mock('mediabunny', () => {
  type Opts = { getSize(): number; read(start: number, end: number): Promise<Uint8Array> };
  class CustomSource {
    readonly options: Opts;
    constructor(options: Opts) {
      this.options = options;
      fake.created += 1;
    }
  }
  class Input {
    readonly source: CustomSource;
    constructor(init: { source: CustomSource; formats: unknown[] }) {
      this.source = init.source;
    }
    async getFormat(): Promise<{ mimeType: string }> {
      const size = this.source.options.getSize();
      await this.source.options.read(0, 12);
      await this.source.options.read(size - 8, size);
      if (fake.spec.mime === null) throw new Error('Input has an unsupported or unrecognizable format.');
      return { mimeType: fake.spec.mime };
    }
    async getPrimaryVideoTrack(): Promise<unknown> {
      const s = fake.spec;
      if (!s.track) return null;
      return {
        codec: s.codec,
        codedWidth: s.width,
        codedHeight: s.height,
        getDecoderConfig: async () => ({ codec: s.cfgCodec, description: s.description }),
      };
    }
    async computeDuration(): Promise<number> {
      return fake.spec.duration;
    }
    dispose(): void {
      fake.disposed += 1;
    }
  }
  const view = (p: Pkt, metadataOnly: boolean) => ({
    timestamp: p.timestamp,
    byteLength: p.data.length,
    data: metadataOnly ? new Uint8Array(0) : p.data,
  });
  class EncodedPacketSink {
    readonly track: unknown;
    constructor(track: unknown) {
      this.track = track;
    }
    async getKeyPacket(t: number, o: { metadataOnly?: boolean } = {}) {
      const keys = fake.spec.packets.filter((p) => p.key && p.timestamp <= t);
      const last = keys[keys.length - 1];
      return last === undefined ? null : view(last, o.metadataOnly === true);
    }
    async getFirstKeyPacket(o: { metadataOnly?: boolean } = {}) {
      const first = fake.spec.packets.find((p) => p.key);
      return first === undefined ? null : view(first, o.metadataOnly === true);
    }
    async getNextKeyPacket(prev: { timestamp: number }, o: { metadataOnly?: boolean } = {}) {
      const next = fake.spec.packets.find((p) => p.key && p.timestamp > prev.timestamp);
      return next === undefined ? null : view(next, o.metadataOnly === true);
    }
  }
  return { ALL_FORMATS: [], CustomSource, EncodedPacketSink, Input };
});

/* Un avcC minimal (profil 100, niveau 31) : codec string attendue avc1.64001F. */
const AVCC = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x00]);
/* Clés toutes les 2 s (0, 2, 4, 6) avec des images intermédiaires à 1, 3, 5 s. */
const packets = (): Pkt[] => [0, 1, 2, 3, 4, 5, 6].map((t) => ({
  timestamp: t,
  key: t % 2 === 0,
  data: t % 2 === 0 ? new Uint8Array([0, 0, 0, 2, 0x65, t]) : new Uint8Array([0, 0, 0, 2, 0x41, t]),
}));

const defaults = (): Spec => ({
  mime: 'video/mp4', codec: 'avc', cfgCodec: 'avc1.64001f', description: AVCC, track: true,
  width: 320, height: 180, duration: 8, packets: packets(),
});

const SIZE = 10 * 1024 * 1024;

/** Fichier factice de `size` octets (zéros sauf `prefix` au début), journalise les plages demandées (début, fin incluse). */
function fileOf(size: number, opts: { total?: boolean; prefix?: Uint8Array; fail?: (start: number) => unknown } = {}): { fetchRange: FetchRange; log: [number, number][] } {
  const log: [number, number][] = [];
  const fetchRange: FetchRange = async (start, end) => {
    log.push([start, end]);
    const fail = opts.fail?.(start);
    if (fail !== undefined) throw fail;
    if (start >= size) return { data: new Uint8Array(0), total: size };
    const data = new Uint8Array(Math.min(end, size - 1) - start + 1);
    if (opts.prefix !== undefined && start < opts.prefix.length) data.set(opts.prefix.subarray(start, start + data.length));
    return { data, total: opts.total === false ? null : size };
  };
  return { fetchRange, log };
}

/** Fichier servi tel quel (fixtures) : même logique que dans thumbs-demux.test.ts. */
function served(file: Uint8Array): { fetchRange: FetchRange; log: [number, number][] } {
  const log: [number, number][] = [];
  const fetchRange: FetchRange = async (start, end) => {
    log.push([start, end]);
    if (start >= file.length) return { data: new Uint8Array(0), total: file.length };
    return { data: file.slice(start, Math.min(end + 1, file.length)), total: file.length };
  };
  return { fetchRange, log };
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

beforeEach(() => {
  fake.spec = defaults();
  fake.created = 0;
  fake.disposed = 0;
});

describe('mediabunny simulé : index', () => {
  it('info : conteneur, codec, chaîne WebCodecs (avcC), dimensions, durée ; pas d\'index d\'images clés', async () => {
    const { fetchRange } = fileOf(SIZE);
    const index = await openMediabunnyIndex(fetchRange, { headBytes: 4096 });
    expect(index.info.container).toBe('mp4');
    expect(index.info.codec).toBe('h264');
    expect(index.info.codecString).toBe('avc1.64001F');
    expect(Array.from(index.info.description)).toEqual(Array.from(AVCC));
    expect(index.info.width).toBe(320);
    expect(index.info.height).toBe(180);
    expect(index.info.duration).toBe(8);
    expect(index.keyframeCount).toBe(0);
  });

  it('conteneurs : WebM et Matroska → mkv, QuickTime → mp4 ; HEVC (hev1) et AV1 : chaînes WebCodecs', async () => {
    const { fetchRange } = fileOf(SIZE);
    fake.spec.mime = 'video/webm';
    expect((await openMediabunnyIndex(fetchRange, { headBytes: 4096 })).info.container).toBe('mkv');
    fake.spec.mime = 'video/x-matroska';
    expect((await openMediabunnyIndex(fetchRange, { headBytes: 4096 })).info.container).toBe('mkv');
    fake.spec.mime = 'video/quicktime';
    expect((await openMediabunnyIndex(fetchRange, { headBytes: 4096 })).info.container).toBe('mp4');

    fake.spec.codec = 'hevc';
    fake.spec.cfgCodec = 'hev1.1.6.L93.B0';
    fake.spec.description = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0, 0]);
    const hevc = await openMediabunnyIndex(fetchRange, { headBytes: 4096 });
    expect(hevc.info.codec).toBe('hevc');
    expect(hevc.info.codecString).toBe('hev1.1.6.L93.B0');

    fake.spec.codec = 'av1';
    fake.spec.cfgCodec = 'av01.0.08M.08';
    fake.spec.description = new Uint8Array([0x81, 0x08, 0x0c, 0]);
    const av1 = await openMediabunnyIndex(fetchRange, { headBytes: 4096 });
    expect(av1.info.codec).toBe('av1');
    expect(av1.info.codecString).toBe('av01.0.08M.08');
  });

  it('keyframeAt : image clé la plus proche, égalité vers la plus ancienne, bornes', async () => {
    const index = await openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 });
    const at = async (t: number) => (await index.keyframeAt(t))?.timestamp ?? null;
    expect(await at(2.4)).toBe(2);
    expect(await at(3.1)).toBe(4);
    expect(await at(3)).toBe(2); // à égale distance de 2 et 4 : la plus ancienne
    expect(await at(-1)).toBe(0);
    expect(await at(99)).toBe(6);
    const ref = (await index.keyframeAt(4.2))!;
    expect(ref.size).toBe(6); // taille de l'échantillon connue dès l'index
    expect(ref.offset).toBe(-1); // position dans le fichier inconnue avec mediabunny
  });

  it('readSample : octets exacts de l\'image clé ; null si l\'instant n\'est pas une image clé', async () => {
    const index = await openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 });
    const ref = (await index.keyframeAt(4.2))!;
    expect(Array.from((await index.readSample(ref))!)).toEqual([0, 0, 0, 2, 0x65, 4]);
    expect(await index.readSample({ offset: -1, size: null, timestamp: 3 })).toBeNull();
  });

  it('plages : fin de fichier lue en plage exacte [fin - 8, fin - 1], toutes ≤ 4 Mo et dans le fichier', async () => {
    const { fetchRange, log } = fileOf(SIZE);
    await openMediabunnyIndex(fetchRange, { headBytes: 4096 });
    expect(log).toContainEqual([SIZE - 8, SIZE - 1]);
    expect(log.every(([s, e]) => e - s + 1 <= MAX_CHUNK && e < SIZE)).toBe(true);
  });

  it('annulation : keyframeAt et readSample rejettent avec un signal annulé', async () => {
    const index = await openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 });
    const ref = (await index.keyframeAt(2))!;
    const ctl = new AbortController();
    ctl.abort();
    await expect(index.keyframeAt(2, ctl.signal)).rejects.toThrow();
    await expect(index.readSample(ref, ctl.signal)).rejects.toThrow();
  });

  it('refus : codec non géré, piste vidéo absente, format non reconnu → rejet, démultiplexeur libéré', async () => {
    fake.spec.codec = 'vp9';
    await expect(openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 })).rejects.toThrow('mediabunny_codec');
    expect(fake.disposed).toBe(1);

    fake.spec = defaults();
    fake.spec.track = false;
    await expect(openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 })).rejects.toThrow('mediabunny_no_video');
    expect(fake.disposed).toBe(2);

    fake.spec = defaults();
    fake.spec.mime = null;
    await expect(openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 })).rejects.toThrow('unrecognizable');
    expect(fake.disposed).toBe(3);

    fake.spec = defaults();
    fake.spec.mime = 'video/MP2T';
    await expect(openMediabunnyIndex(fileOf(SIZE).fetchRange, { headBytes: 4096 })).rejects.toThrow('mediabunny_container');
    expect(fake.disposed).toBe(4);
  });

  it('taille inconnue (Content-Range absent sur un fichier plus grand que l\'en-tête) : rejet avant d\'ouvrir', async () => {
    await expect(openMediabunnyIndex(fileOf(SIZE, { total: false }).fetchRange, { headBytes: 4096 })).rejects.toThrow('mediabunny_size_unknown');
    expect(fake.created).toBe(0);
  });

  it('erreur réseau pendant la lecture : rejet propagé', async () => {
    const { fetchRange } = fileOf(SIZE, { fail: (start) => (start >= 4096 ? new Error('network') : undefined) });
    await expect(openMediabunnyIndex(fetchRange, { headBytes: 4096 })).rejects.toThrow('network');
  });
});

/** Fichier de 1 Mo dont la première boîte (« free » de 256 Ko) fait sauter le parseur maison au-delà de l'en-tête lu : toute lecture là échoue via `fail`. */
function boxFile(fail: (start: number) => unknown): { fetchRange: FetchRange; log: [number, number][] } {
  return fileOf(1 << 20, {
    prefix: new Uint8Array([0x00, 0x04, 0x00, 0x00, 0x66, 0x72, 0x65, 0x65]),
    fail: (start) => (start >= 256 * 1024 ? fail(start) : undefined),
  });
}

describe('openVideoIndex : repli sur mediabunny', () => {
  it('démuxeur maison sans résultat (contenu non reconnu) : mediabunny prend le relais', async () => {
    const zeros = fileOf(1 << 20);
    const r = await openVideoIndex(zeros.fetchRange, { headBytes: 4096 });
    expect(r).not.toBeNull();
    expect(r!.index.info.codec).toBe('h264');
    expect(r!.index.keyframeCount).toBe(0);
    expect(r!.source).toBeInstanceOf(ByteSource);
    expect(fake.created).toBe(1);
  });

  it('démuxeur maison en erreur réseau et mediabunny en échec : erreur du maison relancée', async () => {
    fake.spec.mime = null;
    await expect(openVideoIndex(boxFile(() => new Error('network')).fetchRange, { headBytes: 4096 })).rejects.toThrow('network');
  });

  it('ni l\'un ni l\'autre sans erreur (format non reconnu) : null, sans exception', async () => {
    fake.spec.mime = null;
    expect(await openVideoIndex(fileOf(1 << 20).fetchRange, { headBytes: 4096 })).toBeNull();
  });

  it('refus de la source (RangeAuthError) pendant le démuxeur maison : relancé, pas avalé', async () => {
    await expect(openVideoIndex(boxFile(() => new RangeAuthError()).fetchRange, { headBytes: 4096 })).rejects.toBeInstanceOf(RangeAuthError);
  });

  it('annulation pendant le démuxeur maison : relancée, pas de repli', async () => {
    const ctl = new AbortController();
    const fr = boxFile(() => { ctl.abort(); return new DOMException('aborted', 'AbortError'); }).fetchRange;
    await expect(openVideoIndex(fr, { headBytes: 4096 }, ctl.signal)).rejects.toThrow();
    expect(fake.created).toBe(0);
  });

  it('MP4 reconnu par le démuxeur maison : pas de repli (mediabunny non ouvert)', async () => {
    const r = await openVideoIndex(served(fixture('h264.mp4')).fetchRange);
    expect(r!.index.info.container).toBe('mp4');
    expect(r!.index.keyframeCount).toBe(5);
    expect(fake.created).toBe(0);
  });
});
