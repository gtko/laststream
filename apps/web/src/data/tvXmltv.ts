/* TV en direct : guide des programmes XMLTV d'une playlist utilisateur, lu en flux sur l'appareil.
 * Seule la fenêtre maintenant → +24 h des chaînes de la playlist est gardée (stockage local, jamais envoyé au serveur).
 * Logique pure (analyse, correspondance, fenêtre) testée dans tests/tvBox.test.ts. */

import { normText } from './tvRank';

const GUIDE_KEY = 'ls_tv_guide';
const GUIDE_WINDOW_SEC = 24 * 3600;

interface GuideProg { start: number; stop: number; title: string; desc: string }
/** Programmes compacts : [début, fin, titre, description]. */
export type GuideTuple = [number, number, string, string];
export interface GuideData { at: number; progs: Record<string, GuideTuple[]> }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
export const decodeXml = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** « 20260115203000 +0100 » (fuseau facultatif, UTC par défaut) → secondes epoch, ou null. */
export function parseXmltvTime(raw: string): number | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(raw);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (!Number.isFinite(ms)) return null;
  const off = m[7] ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60 : 0;
  return Math.floor(ms / 1000) - off;
}

const attr = (tag: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] ?? m[2] ?? '') : '';
};
const inner = (xml: string, tag: string): string => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]).trim() : '';
};

export interface ParsedGuide {
  /** Identifiant de chaîne XMLTV → noms affichés. */
  names: Map<string, string[]>;
  /** Identifiant de chaîne XMLTV → programmes qui touchent la fenêtre. */
  progs: Map<string, GuideProg[]>;
}

/**
 * Lit un XMLTV par morceaux (jamais le document entier en mémoire) : chaque `<channel>` et `<programme>` complet est traité
 * puis oublié ; seuls les programmes de la fenêtre [from, to[ sont gardés.
 */
export async function parseXmltv(chunks: AsyncIterable<string> | Iterable<string>, from: number, to: number): Promise<ParsedGuide> {
  const names = new Map<string, string[]>();
  const progs = new Map<string, GuideProg[]>();
  let buf = '';
  const drain = (final: boolean): void => {
    for (;;) {
      const c = buf.indexOf('<channel ');
      const p = buf.indexOf('<programme ');
      const at = c >= 0 && (p < 0 || c < p) ? c : p;
      if (at < 0) {
        // Rien d'exploitable : on ne garde que le début d'une éventuelle balise coupée entre deux morceaux.
        const lt = buf.lastIndexOf('<');
        buf = final || lt < 0 ? '' : buf.slice(lt);
        return;
      }
      const isChannel = at === c;
      const close = isChannel ? '</channel>' : '</programme>';
      const end = buf.indexOf(close, at);
      if (end < 0) { buf = buf.slice(at); return; }
      const xml = buf.slice(at, end + close.length);
      buf = buf.slice(end + close.length);
      const open = xml.slice(0, xml.indexOf('>') + 1);
      if (isChannel) {
        const id = attr(open, 'id');
        if (id) {
          const list = [...xml.matchAll(/<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/g)].map((m) => decodeXml(m[1]).trim()).filter(Boolean);
          names.set(id, list);
        }
        continue;
      }
      const ch = attr(open, 'channel');
      const start = parseXmltvTime(attr(open, 'start'));
      const stop = parseXmltvTime(attr(open, 'stop'));
      if (!ch || start == null || stop == null || stop <= from || start >= to) continue;
      const title = inner(xml, 'title');
      if (!title) continue;
      const arr = progs.get(ch) ?? [];
      arr.push({ start, stop, title, desc: inner(xml, 'desc') });
      progs.set(ch, arr);
    }
  };
  for await (const chunk of chunks as AsyncIterable<string>) {
    buf += chunk;
    drain(false);
  }
  drain(true);
  return { names, progs };
}

export interface GuideTarget { id: string; name: string; tvgId?: string }

/** Rattache les programmes aux chaînes de la playlist : identifiant `tvg-id` d'abord, puis nom (normalisé). */
export function matchGuide(targets: readonly GuideTarget[], g: ParsedGuide, descMax = 240): Record<string, GuideTuple[]> {
  const byLowId = new Map<string, string>();
  g.names.forEach((_n, id) => byLowId.set(id.toLowerCase(), id));
  g.progs.forEach((_p, id) => { if (!byLowId.has(id.toLowerCase())) byLowId.set(id.toLowerCase(), id); });
  const byName = new Map<string, string>();
  g.names.forEach((list, id) => list.forEach((n) => { const k = normText(n); if (k && !byName.has(k)) byName.set(k, id); }));
  const out: Record<string, GuideTuple[]> = {};
  targets.forEach((t) => {
    const gid = (t.tvgId ? byLowId.get(t.tvgId.toLowerCase()) : undefined) ?? byName.get(normText(t.name));
    const list = gid ? g.progs.get(gid) : undefined;
    if (!list || !list.length) return;
    out[t.id] = list.slice().sort((a, b) => a.start - b.start).map((p): GuideTuple => [p.start, p.stop, p.title, p.desc.slice(0, descMax)]);
  });
  return out;
}

// ---------- Décompression et lecture en flux ----------

const isGzip = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Texte du document (gzip décompressé en flux) par morceaux d'environ 1 Mo. */
async function* textChunks(bytes: Uint8Array, size = 1 << 20): AsyncGenerator<string> {
  const dec = new TextDecoder();
  if (isGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip_unsupported');
    const src = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = src.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield dec.decode(value, { stream: true });
    }
    return;
  }
  for (let i = 0; i < bytes.length; i += size) yield dec.decode(bytes.subarray(i, i + size), { stream: i + size < bytes.length });
}

/** XMLTV (éventuellement .gz) → programmes de la fenêtre [now, now + 24 h] des chaînes données. */
export async function guideFromBytes(bytes: Uint8Array, targets: readonly GuideTarget[], now = Math.floor(Date.now() / 1000)): Promise<GuideData> {
  const parsed = await parseXmltv(textChunks(bytes), now, now + GUIDE_WINDOW_SEC);
  return { at: now * 1000, progs: matchGuide(targets, parsed) };
}

// ---------- Stockage local ----------

let cache: GuideData | null | undefined;

function loadGuide(): GuideData | null {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(GUIDE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    cache = v && typeof v === 'object' && v.progs ? v as GuideData : null;
  } catch { cache = null; }
  return cache;
}

export function saveGuide(g: GuideData | null): void {
  cache = g;
  try {
    if (!g) { localStorage.removeItem(GUIDE_KEY); return; }
    try { localStorage.setItem(GUIDE_KEY, JSON.stringify(g)); } catch {
      // Quota dépassé : on retente sans les descriptions.
      const slim: GuideData = { at: g.at, progs: Object.fromEntries(Object.entries(g.progs).map(([k, v]) => [k, v.map((t): GuideTuple => [t[0], t[1], t[2], ''])])) };
      localStorage.setItem(GUIDE_KEY, JSON.stringify(slim));
    }
  } catch { /* stockage indisponible : le guide reste en mémoire pour cette session */ }
}

/** Programmes locaux d'une chaîne (id de la playlist) qui touchent [from, to[, au format du guide serveur. */
export function localProgs(chId: string, from: number, to: number): Array<{ channelId: string; start: number; stop: number; title: string; desc: string }> {
  const list = loadGuide()?.progs[chId] ?? [];
  return list.filter((t) => t[1] > from && t[0] < to).map((t) => ({ channelId: chId, start: t[0], stop: t[1], title: t[2], desc: t[3] }));
}

export const hasLocalGuide = (chId: string): boolean => !!loadGuide()?.progs[chId]?.length;
