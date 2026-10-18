/* Matroska / WebM (EBML) : lit SeekHead, Info (TimecodeScale, Duration), Tracks (piste vidéo + CodecPrivate) et Cues pour obtenir
 * les images clés. Sans Cues (ou Cues inexploitables), recherche par dichotomie des Clusters. Le bloc de l'image clé se lit
 * ensuite par une plage (SimpleBlock ou BlockGroup ; lacing Xiph, EBML et fixe : première trame). */

import { ByteSource, Cursor } from './bytes';
import { codecStringFor, type VideoCodec } from './codec';
import { nearest } from './mp4';
import type { KeyframeRef, VideoIndex, VideoInfo } from './types';

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7,
  TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
  ReferenceBlock: 0xfb,
} as const;

const CODECS: Record<string, VideoCodec> = { 'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', V_AV1: 'av1' };
const MAX_BODY = 16 * 1024 * 1024;
const CLUSTER_ID_BYTES = [0x1f, 0x43, 0xb6, 0x75];

/** Identifiant d'élément (marqueur conservé) à `p`, ou null. */
export function readId(b: Uint8Array, p: number): { id: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  if (first === 0) return null;
  const len = Math.clz32(first) - 23; // 1..4 pour first ≥ 0x10
  if (len < 1 || len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i += 1) id = id * 256 + b[p + i];
  return { id, len };
}

/** Taille d'élément à `p` : valeur sans marqueur ; -1 si « inconnue » (tous les bits à 1). */
export function readSize(b: Uint8Array, p: number): { value: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  if (first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 8 || p + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value: allOnes ? -1 : value, len };
}

const uint = (b: Uint8Array, s: number, e: number): number => {
  let v = 0;
  for (let i = s; i < e; i += 1) v = v * 256 + b[i];
  return v;
};

function float(b: Uint8Array, s: number, e: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + s, e - s);
  return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0;
}

interface El { id: number; start: number; data: number; end: number }

/** Éléments enfants dans [start, end) d'un tampon ; une taille inconnue court jusqu'à `end`. */
function* elements(b: Uint8Array, start: number, end: number): Generator<El> {
  let p = start;
  while (p < end) {
    const id = readId(b, p);
    if (id === null) return;
    const sz = readSize(b, p + id.len);
    if (sz === null) return;
    const data = p + id.len + sz.len;
    const stop = sz.value < 0 ? end : data + sz.value;
    if (stop > end) return;
    yield { id: id.id, start: p, data, end: stop };
    p = stop;
  }
}

interface TrackInfo { number: number; codec: VideoCodec; codecId: string; priv: Uint8Array; width: number; height: number }

function parseTracks(b: Uint8Array): TrackInfo | null {
  for (const tracks of elements(b, 0, b.length)) {
    if (tracks.id !== ID.Tracks) continue;
    for (const entry of elements(b, tracks.data, tracks.end)) {
      if (entry.id !== ID.TrackEntry) continue;
      let number = 0, type = 0, codecId = '', priv = new Uint8Array(0), width = 0, height = 0;
      for (const f of elements(b, entry.data, entry.end)) {
        if (f.id === ID.TrackNumber) number = uint(b, f.data, f.end);
        else if (f.id === ID.TrackType) type = uint(b, f.data, f.end);
        else if (f.id === ID.CodecID) codecId = String.fromCharCode(...b.subarray(f.data, f.end));
        else if (f.id === ID.CodecPrivate) priv = b.slice(f.data, f.end);
        else if (f.id === ID.Video) {
          for (const v of elements(b, f.data, f.end)) {
            if (v.id === ID.PixelWidth) width = uint(b, v.data, v.end);
            else if (v.id === ID.PixelHeight) height = uint(b, v.data, v.end);
          }
        }
      }
      const codec = CODECS[codecId.replace(/\0+$/, '')];
      if (type === 1 && codec !== undefined && number > 0) return { number, codec, codecId, priv, width, height };
    }
  }
  return null;
}

interface CueKey { time: number; /** début du Cluster (absolu) */ offset: number; /** CueRelativePosition */ rel: number | null }

function parseCues(b: Uint8Array, track: number, scaleNs: number, segmentData: number): CueKey[] {
  const out: CueKey[] = [];
  for (const cues of elements(b, 0, b.length)) {
    if (cues.id !== ID.Cues) continue;
    for (const point of elements(b, cues.data, cues.end)) {
      if (point.id !== ID.CuePoint) continue;
      let time = -1;
      const positions: { track: number; cluster: number; rel: number | null }[] = [];
      for (const f of elements(b, point.data, point.end)) {
        if (f.id === ID.CueTime) time = uint(b, f.data, f.end);
        else if (f.id === ID.CueTrackPositions) {
          const p = { track: 0, cluster: -1, rel: null as number | null };
          for (const g of elements(b, f.data, f.end)) {
            if (g.id === ID.CueTrack) p.track = uint(b, g.data, g.end);
            else if (g.id === ID.CueClusterPosition) p.cluster = uint(b, g.data, g.end);
            else if (g.id === ID.CueRelativePosition) p.rel = uint(b, g.data, g.end);
          }
          positions.push(p);
        }
      }
      const p = positions.find((x) => x.track === track && x.cluster >= 0);
      if (time < 0 || p === undefined) continue;
      out.push({ time: (time * scaleNs) / 1e9, offset: segmentData + p.cluster, rel: p.rel });
    }
  }
  out.sort((x, y) => x.time - y.time);
  return out;
}

interface Block { track: number; timecode: number; keyframe: boolean | null; data: Uint8Array }

/** Contenu d'un (Simple)Block : piste, décalage de temps, drapeau d'image clé (SimpleBlock) et première trame. */
export function parseBlock(body: Uint8Array, simple: boolean): Block | null {
  const t = readSize(body, 0);
  if (t === null || t.value < 0 || body.length < t.len + 3) return null;
  const p = t.len;
  const timecode = (body[p] << 24 >> 16) | body[p + 1];
  const flags = body[p + 2];
  let pos = p + 3;
  const lacing = (flags >> 1) & 3;
  let end = body.length;
  if (lacing !== 0) {
    const n = body[pos] + 1;
    pos += 1;
    const sizes: number[] = [];
    if (lacing === 1) {
      for (let i = 0; i < n - 1; i += 1) {
        let s = 0;
        while (pos < body.length && body[pos] === 255) { s += 255; pos += 1; }
        s += body[pos++];
        sizes.push(s);
      }
    } else if (lacing === 3) {
      const first = readSize(body, pos);
      if (first === null) return null;
      sizes.push(first.value);
      pos += first.len;
      for (let i = 1; i < n - 1; i += 1) {
        const d = readSize(body, pos);
        if (d === null) return null;
        pos += d.len;
        sizes.push(sizes[i - 1] + d.value - (2 ** (7 * d.len - 1) - 1));
      }
    } else {
      sizes.push(Math.floor((body.length - pos) / n));
    }
    end = pos + (sizes[0] ?? body.length - pos);
  }
  if (pos > end || end > body.length) return null;
  return { track: t.value, timecode, keyframe: simple ? (flags & 0x80) !== 0 : null, data: body.subarray(pos, end) };
}

export async function openMkv(src: ByteSource, signal?: AbortSignal): Promise<VideoIndex | null> {
  const cursor = new Cursor(src);
  const head = await cursor.bytes(0, 64, signal);
  const ebml = readId(head, 0);
  if (ebml === null || ebml.id !== ID.EBML) return null;
  const ebmlSize = readSize(head, ebml.len);
  if (ebmlSize === null || ebmlSize.value < 0) return null;
  let off = ebml.len + ebmlSize.len + ebmlSize.value;
  const segHead = await cursor.bytes(off, 16, signal);
  const seg = readId(segHead, 0);
  const segSize = seg === null ? null : readSize(segHead, seg.len);
  if (seg === null || seg.id !== ID.Segment || segSize === null) return null;
  const segmentData = off + seg.len + segSize.len;
  const fileSize = src.size ?? Number.MAX_SAFE_INTEGER;
  const segmentEnd = segSize.value < 0 ? fileSize : Math.min(fileSize, segmentData + segSize.value);

  const seek = new Map<number, number>();
  let infoBody: Uint8Array | null = null;
  let tracksBody: Uint8Array | null = null;
  let cuesAt: { start: number; size: number } | null = null;
  let firstCluster = -1;

  /** En-tête d'élément à `at` : id, début des données, taille (-1 inconnue). */
  const header = async (at: number): Promise<{ id: number; data: number; size: number } | null> => {
    const h = await cursor.bytes(at, 12, signal);
    const id = readId(h, 0);
    const sz = id === null ? null : readSize(h, id.len);
    return id === null || sz === null ? null : { id: id.id, data: at + id.len + sz.len, size: sz.value };
  };
  const body = async (h: { data: number; size: number }): Promise<Uint8Array | null> => {
    if (h.size < 0 || h.size > MAX_BODY) return null;
    const data = await cursor.bytes(h.data, h.size, signal);
    return data.length === h.size ? data : null;
  };
  /** Élément entier (en-tête compris) : `elements()` attend l'élément lui-même. */
  const whole = async (h: { data: number; size: number }, start: number): Promise<Uint8Array | null> => {
    if (h.size < 0 || h.size > MAX_BODY) return null;
    const data = await cursor.bytes(start, h.data - start + h.size, signal);
    return data.length === h.data - start + h.size ? data : null;
  };
  /** Éléments utiles à la position `at` (SeekHead, Info, Tracks, Cues), pour les trouver via SeekHead. */
  const take = async (h: { id: number; data: number; size: number }, start: number): Promise<void> => {
    if (h.id === ID.SeekHead) {
      const b = await body(h);
      if (b === null) return;
      for (const s of elements(b, 0, b.length)) {
        if (s.id !== ID.Seek) continue;
        let sid = 0, spos = -1;
        for (const f of elements(b, s.data, s.end)) {
          if (f.id === ID.SeekID) sid = uint(b, f.data, f.end);
          else if (f.id === ID.SeekPosition) spos = uint(b, f.data, f.end);
        }
        if (sid !== 0 && spos >= 0 && !seek.has(sid)) seek.set(sid, segmentData + spos);
      }
    } else if (h.id === ID.Info && infoBody === null) infoBody = await whole(h, start);
    else if (h.id === ID.Tracks && tracksBody === null) tracksBody = await whole(h, start);
    else if (h.id === ID.Cues && cuesAt === null && h.size > 0) cuesAt = { start, size: h.size };
  };

  off = segmentData;
  for (let guard = 0; guard < 512 && off < segmentEnd; guard += 1) {
    const h = await header(off);
    if (h === null) break;
    if (h.id === ID.Cluster) { firstCluster = off; break; }
    if (h.size < 0) break;
    await take(h, off);
    off = h.data + h.size;
  }
  // Éléments placés après les premiers Clusters : on les retrouve par le SeekHead.
  for (const [wanted, set] of [[ID.Info, () => infoBody], [ID.Tracks, () => tracksBody], [ID.Cues, () => cuesAt]] as const) {
    const at = seek.get(wanted);
    if (set() !== null || at === undefined) continue;
    const h = await header(at);
    if (h !== null && h.id === wanted) await take(h, at);
  }
  if (tracksBody === null) return null;
  const track = parseTracks(tracksBody);
  if (track === null) return null;
  const description = track.priv;
  const codecString = codecStringFor(track.codec, description);
  if (codecString === null) return null;

  let scaleNs = 1_000_000;
  let durationTicks = 0;
  if (infoBody !== null) {
    const ib: Uint8Array = infoBody;
    for (const info of elements(ib, 0, ib.length)) {
      if (info.id !== ID.Info) continue;
      for (const f of elements(ib, info.data, info.end)) {
        if (f.id === ID.TimecodeScale) scaleNs = uint(ib, f.data, f.end) || scaleNs;
        else if (f.id === ID.Duration) durationTicks = float(ib, f.data, f.end);
      }
    }
  }
  const info: VideoInfo = {
    container: 'mkv', codec: track.codec, codecString, description, width: track.width, height: track.height,
    duration: (durationTicks * scaleNs) / 1e9,
  };

  let cues: CueKey[] = [];
  if (cuesAt !== null) {
    const c: { start: number; size: number } = cuesAt;
    const h = await header(c.start);
    if (h !== null && h.size >= 0 && h.size <= MAX_BODY) {
      const raw = await src.read(c.start, h.data - c.start + h.size, signal);
      cues = parseCues(raw, track.number, scaleNs, segmentData);
    }
  }
  const timescaleMs = scaleNs;

  /** Bloc à `at` (SimpleBlock ou BlockGroup) → trame, instant, indicateur d'image clé. */
  const readBlockAt = async (at: number): Promise<{ data: Uint8Array; keyframe: boolean | null; timecode: number; size: number } | null> => {
    const h = await header(at);
    if (h === null || h.size < 0) return null;
    const raw = await body(h);
    if (raw === null) return null;
    if (h.id === ID.SimpleBlock) {
      const b = parseBlock(raw, true);
      return b === null || b.track !== track.number ? null : { data: b.data, keyframe: b.keyframe, timecode: b.timecode, size: raw.length };
    }
    if (h.id === ID.BlockGroup) {
      let block: Block | null = null;
      let hasRef = false;
      for (const f of elements(raw, 0, raw.length)) {
        if (f.id === ID.Block) block = parseBlock(raw.subarray(f.data, f.end), false);
        else if (f.id === ID.ReferenceBlock) hasRef = true;
      }
      return block === null || block.track !== track.number ? null : { data: block.data, keyframe: !hasRef, timecode: block.timecode, size: raw.length };
    }
    return null;
  };

  /** Premier bloc vidéo clé d'un Cluster (repli sans position relative) : parcourt ses enfants. */
  const firstKeyBlock = async (clusterAt: number): Promise<{ data: Uint8Array; time: number } | null> => {
    const ch = await header(clusterAt);
    if (ch === null || ch.id !== ID.Cluster) return null;
    const end = ch.size < 0 ? segmentEnd : ch.data + ch.size;
    let p = ch.data;
    let clusterTc = 0;
    for (let guard = 0; guard < 256 && p < end; guard += 1) {
      const h = await header(p);
      if (h === null || h.size < 0) return null;
      if (h.id === ID.Timecode) {
        const v = await cursor.bytes(h.data, h.size, signal);
        clusterTc = uint(v, 0, v.length);
      } else if (h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
        const b = await readBlockAt(p);
        if (b !== null && b.keyframe === true) return { data: b.data, time: ((clusterTc + b.timecode) * timescaleMs) / 1e9 };
      } else if (h.id === ID.Cluster) return null;
      p = h.data + h.size;
    }
    return null;
  };

  // --- Sans Cues : dichotomie sur les Clusters ---
  const known: { offset: number; time: number }[] = [];
  /** Premier Cluster commençant dans [from, limit) : fenêtres croissantes ; null s'il n'y en a pas. */
  const clusterNear = async (from: number, limit: number): Promise<{ offset: number; time: number } | null> => {
    for (const win of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
      const to = Math.min(limit, from + win);
      if (to <= from) return null;
      const buf = await src.read(from, to - from + 24, signal);
      for (let i = 0; i + 4 <= Math.min(buf.length, to - from); i += 1) {
        if (buf[i] !== CLUSTER_ID_BYTES[0] || buf[i + 1] !== CLUSTER_ID_BYTES[1] || buf[i + 2] !== CLUSTER_ID_BYTES[2] || buf[i + 3] !== CLUSTER_ID_BYTES[3]) continue;
        const sz = readSize(buf, i + 4);
        if (sz === null) continue;
        let q = i + 4 + sz.len;
        // Le premier enfant d'un Cluster est son Timecode (éventuellement précédé d'un CRC-32 ou d'un Void).
        for (let skip = 0; skip < 2 && q + 2 < buf.length && (buf[q] === 0xbf || buf[q] === 0xec); skip += 1) {
          const s2 = readSize(buf, q + 1);
          if (s2 === null || s2.value < 0) { q = -1; break; }
          q += 1 + s2.len + s2.value;
        }
        if (q < 0 || q + 3 > buf.length || buf[q] !== ID.Timecode) continue;
        const tl = readSize(buf, q + 1);
        if (tl === null || tl.value < 1 || tl.value > 8 || q + 1 + tl.len + tl.value > buf.length) continue;
        return { offset: from + i, time: ((uint(buf, q + 1 + tl.len, q + 1 + tl.len + tl.value)) * scaleNs) / 1e9 };
      }
      if (to >= limit) return null;
    }
    return null;
  };
  const bisect = async (time: number): Promise<number | null> => {
    if (firstCluster < 0) return null;
    const first = known.find((k) => k.offset === firstCluster) ?? (await clusterNear(firstCluster, segmentEnd));
    if (first === null) return null;
    if (!known.includes(first)) known.push(first);
    known.sort((a, b) => a.offset - b.offset);
    let lo = first;
    let hiOffset = segmentEnd;
    for (const k of known) {
      if (k.time <= time && k.offset >= lo.offset) lo = k;
      else if (k.time > time && k.offset < hiOffset) hiOffset = k.offset;
    }
    for (let guard = 0; guard < 64 && hiOffset - lo.offset > 64 * 1024; guard += 1) {
      const mid = lo.offset + Math.floor((hiOffset - lo.offset) / 2);
      const c = await clusterNear(Math.max(mid, lo.offset + 1), hiOffset);
      if (c === null) { hiOffset = mid; continue; }
      if (!known.some((k) => k.offset === c.offset)) known.push(c);
      if (c.time <= time) lo = c; else hiOffset = c.offset;
    }
    return lo.offset;
  };

  return {
    info,
    keyframeCount: cues.length,
    keyframeAt: async (time) => {
      if (cues.length > 0) {
        const k = nearest(cues, time);
        if (k === null) return null;
        // Position du bloc : début des données du cluster + position relative, sinon début du cluster (parcours à la lecture).
        if (k.rel !== null) {
          const ch = await header(k.offset);
          if (ch === null || ch.id !== ID.Cluster) return null;
          return { offset: ch.data + k.rel, size: null, timestamp: k.time };
        }
        return { offset: k.offset, size: null, timestamp: k.time };
      }
      const clusterAt = await bisect(Math.min(Math.max(0, time), Math.max(0, info.duration - 0.001)));
      return clusterAt === null ? null : { offset: clusterAt, size: null, timestamp: known.find((k) => k.offset === clusterAt)?.time ?? time };
    },
    readSample: async (ref: KeyframeRef) => {
      const h = await header(ref.offset);
      if (h === null) return null;
      if (h.id === ID.Cluster) {
        const k = await firstKeyBlock(ref.offset);
        return k === null ? null : k.data;
      }
      const b = await readBlockAt(ref.offset);
      return b === null || b.keyframe === false ? null : b.data;
    },
  };
}
