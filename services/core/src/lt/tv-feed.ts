import type { FastEntry, M3uEntry } from './tv-catalog.js';

/**
 * Lecture incrémentale des sources TV (M3U, XMLTV, FAST) : chaque analyseur reçoit le texte par morceaux et ne garde
 * que ce qui est demandé. Sert à la fois au serveur Node (texte entier d'un coup) et aux Workers (flux, mémoire bornée).
 */

export interface Programme {
  start: number;
  stop: number;
  title: string;
  desc: string;
  icon: string;
  category: string;
}

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Analyse d'une playlist M3U ligne à ligne. `accept` écarte une entrée avant qu'elle ne soit gardée. */
export class M3uAccumulator {
  readonly entries: M3uEntry[] = [];
  private current: { attrs: Record<string, string>; name: string } | null = null;
  private first = true;

  constructor(private readonly accept?: (entry: M3uEntry) => boolean) {}

  push(raw: string): void {
    let line = raw;
    if (this.first) {
      line = stripBom(line);
      this.first = false;
    }
    line = line.trim();
    if (!line) return;
    if (line.startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_match, key: string, value: string) => {
        attrs[key.toLowerCase()] = value;
        return '';
      });
      this.current = { attrs, name: line.slice(line.lastIndexOf(',') + 1).trim() };
    } else if (line.startsWith('#')) {
      return;
    } else if (this.current !== null) {
      const entry: M3uEntry = { ...this.current, url: line };
      if (this.accept === undefined || this.accept(entry)) this.entries.push(entry);
      this.current = null;
    }
  }
}

/** Décodage des entités XML et des sections CDATA. */
const xmlDecode = (value: string | undefined): string =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

/** Horodatage XMLTV (AAAAMMJJHHMMSS +HHMM) en secondes Unix ; 0 si invalide. */
function xmltvTime(value: string | undefined): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(String(value ?? ''));
  if (!match) return 0;
  const tz = match[7] ? match[7].slice(0, 3) + ':' + match[7].slice(3) : 'Z';
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${tz}`);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

/** Taille maximale d'un bloc <programme> gardé en attente de sa fin (au-delà : ignoré). */
const MAX_PROGRAMME_CHARS = 64 * 1024;
const OPEN = '<programme';
const CLOSE = '</programme>';

/**
 * Ajoute au magasin les programmes d'un XMLTV de la fenêtre [lo, hi], reçu par morceaux. `wanted` (facultatif) limite
 * aux chaînes demandées : un programme d'une autre chaîne n'est même pas analysé. Une source antérieure fait foi pour
 * une chaîne (une instance par source).
 */
export class XmltvIngest {
  count = 0;
  private buf = '';
  private readonly seenHere = new Set<string>();

  constructor(
    private readonly store: Map<string, Programme[]>,
    private readonly lo: number,
    private readonly hi: number,
    private readonly wanted?: ReadonlySet<string>,
  ) {}

  push(chunk: string): void {
    let text = this.buf + chunk;
    let at = 0;
    for (;;) {
      const open = text.indexOf(OPEN, at);
      if (open === -1) {
        // Garde la fin au cas où « <programme » serait coupé entre deux morceaux.
        this.buf = text.slice(Math.max(at, text.length - OPEN.length));
        return;
      }
      const close = text.indexOf(CLOSE, open);
      if (close === -1) {
        const pending = text.slice(open);
        this.buf = pending.length > MAX_PROGRAMME_CHARS ? '' : pending;
        return;
      }
      this.block(text.slice(open, close));
      at = close + CLOSE.length;
      if (at > 1 << 20) {
        text = text.slice(at);
        at = 0;
      }
    }
  }

  private block(block: string): void {
    const gt = block.indexOf('>');
    if (gt === -1) return;
    const attrs: Record<string, string> = {};
    block.slice(OPEN.length, gt).replace(/([\w:-]+)="([^"]*)"/g, (_m, key: string, value: string) => {
      attrs[key] = value;
      return '';
    });
    if (!attrs.channel) return;
    const channel = xmlDecode(attrs.channel);
    if (this.wanted !== undefined && !this.wanted.has(channel)) return;
    const start = xmltvTime(attrs.start);
    const stop = xmltvTime(attrs.stop);
    if (!start || !stop || stop < this.lo || start > this.hi) return;
    if (this.store.has(channel) && !this.seenHere.has(channel)) return;
    const body = block.slice(gt + 1);
    const pick = (tag: string): string => {
      const found = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(body);
      return found ? xmlDecode(found[1]) : '';
    };
    const icon = /<icon\b[^>]*src="([^"]*)"/.exec(body);
    this.seenHere.add(channel);
    const list = this.store.get(channel) ?? [];
    list.push({
      start,
      stop,
      title: pick('title'),
      desc: pick('desc').slice(0, 600),
      icon: icon ? xmlDecode(icon[1]) : '',
      category: pick('category'),
    });
    this.store.set(channel, list);
    this.count++;
  }
}

/** Chaînes FAST (format i.mjh.nz, région française). `slug` contient {id} pour l'URL de lecture. */
export function fastEntry(id: string, info: Record<string, unknown>, source: 'pluto' | 'samsung', prefix: string, slug: string): FastEntry {
  return {
    key: prefix + ':' + id,
    epgId: id,
    name: typeof info.name === 'string' && info.name !== '' ? info.name : id,
    logo: typeof info.logo === 'string' ? info.logo : '',
    group: typeof info.group === 'string' && info.group !== '' ? info.group : 'FAST',
    source,
    url: slug.replace('{id}', id),
    country: 'FR',
    languages: ['fra'],
  };
}
