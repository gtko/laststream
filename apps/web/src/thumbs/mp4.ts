/* MP4 / ISO-BMFF : trouve le « moov » (au début ou en fin de fichier), lit la table des échantillons de la piste vidéo
 * (stsd, stts, ctts, stss, stsz, stsc, stco/co64, elst) et en déduit la table des images clés (instant, position, taille).
 * MP4 fragmentés (moof) et pistes chiffrées : non pris en charge (null, donc pas de miniatures). */

import { ByteSource, Cursor } from './bytes';
import { codecStringFor, type VideoCodec } from './codec';
import type { KeyframeRef, VideoIndex, VideoInfo } from './types';

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

interface Box { type: string; start: number; payload: number; end: number }

const fourcc = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u32 = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const i32 = (b: Uint8Array, p: number): number => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const u64 = (b: Uint8Array, p: number): number => u32(b, p) * 4294967296 + u32(b, p + 4);
const u16 = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];

/** Boîtes enfants dans [start, end) ; s'arrête sur une boîte tronquée ou malformée. */
function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64(b, p + 8);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type: fourcc(b, p + 4), start: p, payload: p + header, end: p + size };
    p += size;
  }
}

function child(b: Uint8Array, parent: Box, ...path: string[]): Box | null {
  let cur = parent;
  for (const type of path) {
    let found: Box | null = null;
    for (const c of boxes(b, cur.payload, cur.end)) if (c.type === type) { found = c; break; }
    if (found === null) return null;
    cur = found;
  }
  return cur;
}

interface Tables {
  timescale: number;
  duration: number;
  info: Omit<VideoInfo, 'duration'>;
  stts: Uint32Array; // [count, delta]*
  ctts: Int32Array | null; // [count, offset]*
  stss: Uint32Array | null;
  sampleCount: number;
  sampleSize: (i: number) => number;
  chunkOffsets: number[];
  chunkFirstSample: number[]; // premier échantillon (0-based) de chaque chunk
  mediaTime: number; // elst : premier media_time ≥ 0, en unités du média
}

const SAMPLE_ENTRIES: Record<string, VideoCodec> = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1' };
const RECORD_BOX: Record<VideoCodec, string> = { h264: 'avcC', hevc: 'hvcC', av1: 'av1C' };

function parseVideoTrack(b: Uint8Array, trak: Box): Tables | null {
  const mdia = child(b, trak, 'mdia');
  const hdlr = mdia && child(b, mdia, 'hdlr');
  if (!mdia || !hdlr || fourcc(b, hdlr.payload + 8) !== 'vide') return null;
  const mdhd = child(b, mdia, 'mdhd');
  const stbl = child(b, mdia, 'minf', 'stbl');
  if (!mdhd || !stbl) return null;
  const v1 = b[mdhd.payload] === 1;
  const timescale = u32(b, mdhd.payload + (v1 ? 20 : 12));
  const duration = v1 ? u64(b, mdhd.payload + 24) : u32(b, mdhd.payload + 16);
  if (timescale === 0) return null;

  const stsd = child(b, stbl, 'stsd');
  if (!stsd || u32(b, stsd.payload + 4) < 1) return null;
  const entry = [...boxes(b, stsd.payload + 8, stsd.end)][0];
  const codec = entry === undefined ? undefined : SAMPLE_ENTRIES[entry.type];
  if (entry === undefined || codec === undefined) return null;
  const width = u16(b, entry.payload + 24);
  const height = u16(b, entry.payload + 26);
  const record = [...boxes(b, entry.payload + 78, entry.end)].find((x) => x.type === RECORD_BOX[codec]);
  if (record === undefined) return null;
  const description = b.slice(record.payload, record.end);
  const codecString = codecStringFor(codec, description, entry.type);
  if (codecString === null) return null;

  const stts = child(b, stbl, 'stts');
  const stsz = child(b, stbl, 'stsz');
  const stsc = child(b, stbl, 'stsc');
  const stco = child(b, stbl, 'stco') ?? child(b, stbl, 'co64');
  if (!stts || !stsz || !stsc || !stco) return null;

  const sttsN = u32(b, stts.payload + 4);
  const sttsArr = new Uint32Array(sttsN * 2);
  for (let i = 0; i < sttsN * 2; i += 1) sttsArr[i] = u32(b, stts.payload + 8 + i * 4);

  const cttsBox = child(b, stbl, 'ctts');
  let ctts: Int32Array | null = null;
  if (cttsBox) {
    const n = u32(b, cttsBox.payload + 4);
    ctts = new Int32Array(n * 2);
    for (let i = 0; i < n * 2; i += 1) ctts[i] = i32(b, cttsBox.payload + 8 + i * 4);
  }

  const stssBox = child(b, stbl, 'stss');
  let stss: Uint32Array | null = null;
  if (stssBox) {
    const n = u32(b, stssBox.payload + 4);
    stss = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) stss[i] = u32(b, stssBox.payload + 8 + i * 4);
  }

  const constSize = u32(b, stsz.payload + 4);
  const sampleCount = u32(b, stsz.payload + 8);
  const sizeBase = stsz.payload + 12;
  const sampleSize = (i: number): number => (constSize !== 0 ? constSize : u32(b, sizeBase + i * 4));

  const co64 = stco.type === 'co64';
  const chunkCount = u32(b, stco.payload + 4);
  const chunkOffsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i += 1) chunkOffsets[i] = co64 ? u64(b, stco.payload + 8 + i * 8) : u32(b, stco.payload + 8 + i * 4);

  const runs = u32(b, stsc.payload + 4);
  const chunkFirstSample: number[] = new Array(chunkCount);
  let sample = 0;
  for (let r = 0; r < runs; r += 1) {
    const first = u32(b, stsc.payload + 8 + r * 12);
    const per = u32(b, stsc.payload + 12 + r * 12);
    const last = r + 1 < runs ? u32(b, stsc.payload + 8 + (r + 1) * 12) - 1 : chunkCount;
    for (let c = first - 1; c < last && c < chunkCount; c += 1) { chunkFirstSample[c] = sample; sample += per; }
  }

  let mediaTime = 0;
  const elst = child(b, trak, 'edts', 'elst');
  if (elst) {
    const ver = b[elst.payload];
    const n = u32(b, elst.payload + 4);
    for (let i = 0; i < n; i += 1) {
      const at = elst.payload + 8 + i * (ver === 1 ? 20 : 12);
      const mt = ver === 1 ? u64(b, at + 8) : i32(b, at + 4);
      if (mt >= 0 && !(ver === 1 && b[at + 8] & 0x80)) { mediaTime = mt; break; }
    }
  }

  return {
    timescale, duration, info: { container: 'mp4', codec, codecString, description, width, height },
    stts: sttsArr, ctts, stss, sampleCount, sampleSize, chunkOffsets, chunkFirstSample, mediaTime,
  };
}

/** Table des images clés (instant de présentation en s, position, taille), triée par instant. */
function buildKeyframes(t: Tables): { time: number; offset: number; size: number }[] {
  const sync: number[] = [];
  if (t.stss !== null) for (const n of t.stss) sync.push(n - 1);
  else for (let i = 0; i < t.sampleCount; i += 1) sync.push(i);
  const out: { time: number; offset: number; size: number }[] = [];
  let sIdx = 0, sAcc = 0, sEntry = 0;
  let cIdx = 0, cAcc = 0, cEntry = 0;
  for (const s of sync) {
    if (s < 0 || s >= t.sampleCount) continue;
    while (sEntry * 2 < t.stts.length && s >= sIdx + t.stts[sEntry * 2]) {
      sAcc += t.stts[sEntry * 2] * t.stts[sEntry * 2 + 1];
      sIdx += t.stts[sEntry * 2];
      sEntry += 1;
    }
    if (sEntry * 2 >= t.stts.length) break;
    const dts = sAcc + (s - sIdx) * t.stts[sEntry * 2 + 1];
    let cts = 0;
    if (t.ctts !== null) {
      while (cEntry * 2 < t.ctts.length && s >= cIdx + t.ctts[cEntry * 2]) {
        cAcc += t.ctts[cEntry * 2];
        cIdx += t.ctts[cEntry * 2];
        cEntry += 1;
      }
      if (cEntry * 2 < t.ctts.length) cts = t.ctts[cEntry * 2 + 1];
    }
    // Chunk contenant l'échantillon : dernier dont le premier échantillon est ≤ s (recherche dichotomique).
    let lo = 0, hi = t.chunkFirstSample.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.chunkFirstSample[mid] <= s) lo = mid; else hi = mid - 1;
    }
    let offset = t.chunkOffsets[lo];
    for (let i = t.chunkFirstSample[lo]; i < s; i += 1) offset += t.sampleSize(i);
    out.push({ time: Math.max(0, (dts + cts - t.mediaTime) / t.timescale), offset, size: t.sampleSize(s) });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Image clé la plus proche de `time` (égalité : la plus ancienne). */
export function nearest<T extends { time: number }>(list: readonly T[], time: number): T | null {
  if (list.length === 0) return null;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time < time) lo = mid + 1; else hi = mid;
  }
  const after = list[lo];
  const before = lo > 0 ? list[lo - 1] : null;
  return before !== null && time - before.time <= after.time - time ? before : after;
}

/** Lit le « moov » en le cherchant de boîte en boîte au premier niveau (un mdat de 80 Go se saute d'un coup). */
async function readMoov(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array | null> {
  const cursor = new Cursor(src, 2048);
  let off = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    if (src.size !== null && off >= src.size) return null;
    const h = await cursor.bytes(off, 16, signal);
    if (h.length < 8) return null;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    if (size === 1) {
      if (h.length < 16) return null;
      size = u64(h, 8);
    } else if (size === 0) size = (src.size ?? 0) - off;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      const data = await src.read(off, size, signal);
      return data.length === size ? data : null;
    }
    off += size;
  }
  return null;
}

export async function openMp4(src: ByteSource, signal?: AbortSignal): Promise<VideoIndex | null> {
  const moov = await readMoov(src, signal);
  if (moov === null) return null;
  const moovBox = [...boxes(moov, 0, moov.length)][0];
  if (moovBox === undefined) return null;
  let tables: Tables | null = null;
  for (const trak of boxes(moov, moovBox.payload, moovBox.end)) {
    if (trak.type !== 'trak') continue;
    tables = parseVideoTrack(moov, trak);
    if (tables !== null) break;
  }
  if (tables === null || tables.sampleCount === 0) return null;
  const keyframes = buildKeyframes(tables);
  if (keyframes.length === 0) return null;
  const info: VideoInfo = { ...tables.info, duration: tables.duration / tables.timescale };
  return {
    info,
    keyframeCount: keyframes.length,
    keyframeAt: (time) => {
      const k = nearest(keyframes, time);
      return Promise.resolve(k === null ? null : { offset: k.offset, size: k.size, timestamp: k.time });
    },
    readSample: async (ref: KeyframeRef, signal2) => {
      if (ref.size === null) return null;
      const data = await src.read(ref.offset, ref.size, signal2);
      return data.length === ref.size ? data : null;
    },
  };
}
