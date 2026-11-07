/* TV en direct : « Ma box TV » (Freebox) et playlists M3U de l'utilisateur (box, abonnement IPTV de son choix).
 *
 * Tout se passe côté APPAREIL : la box n'est joignable que depuis le réseau local, jamais depuis le serveur, et les URL de
 * playlist contiennent souvent des identifiants. Les playlists et leur guide sont gardés dans le stockage local de l'appareil,
 * jamais envoyés au serveur ni journalisés, et masqués à l'affichage (`maskUrl`).
 *  - Windows : commande IPC `native-box-playlist` de la coque (GET borné, hôtes du réseau local autorisés, 20 Mo) ;
 *  - Android : CapacitorHttp (hors WebView, donc ni CORS ni contenu mixte) ;
 *  - web : fetch direct, presque toujours bloqué (contenu mixte, CORS) → message « disponible dans les apps ».
 * Logique pure (analyse M3U, regroupement des qualités, fusion avec le catalogue, états) testée dans tests/tvBox.test.ts. */

import { connectShell, isShellEnvironment } from '../player/shell';
import { browserFetchHttp, capacitorHttp, capacitorNative, shellHttp, type HttpFn } from '../sources/debrid/http';
import { isLanHost } from './lan';
import { nationalEntry, normText } from './tvRank';

export const FREEBOX_PLAYLIST_URL = 'http://mafreebox.freebox.fr/freeboxtv/playlist.m3u';
/** Commande IPC de la coque (même signal de réponse que `native-http`). */
const BOX_COMMAND = 'native-box-playlist';
const MAX_PLAYLIST_BYTES = 20 * 1024 * 1024;
const REFRESH_EVERY_MS = 24 * 3600 * 1000;

export type QualityKey = 'hd' | 'auto' | 'standard' | 'low';
export const QUALITY_LABELS: Record<QualityKey, string> = { hd: 'HD', auto: 'Auto', standard: 'Standard', low: 'Bas débit' };
export const QUALITY_KEYS = Object.keys(QUALITY_LABELS) as QualityKey[];
/** Ordre de repli quand la qualité demandée manque. */
const FALLBACK: QualityKey[] = ['hd', 'auto', 'standard', 'low'];

export interface BoxQuality { key: QualityKey; url: string }

export interface BoxChannel {
  id: string;
  /** Playlist d'origine. */
  list: string;
  name: string;
  /** Numéro de chaîne (Freebox : préfixe « 2 - », sinon `tvg-chno` ; 0 : inconnu). */
  num: number;
  logo: string;
  /** `group-title` (catégorie). */
  group: string;
  tvgId: string;
  /** Flux hébergé sur le réseau local (box Freebox ou adresse privée) : injoignable hors de chez soi. */
  local: boolean;
  qualities: BoxQuality[];
}

// ---------- Analyse M3U ----------

const STREAM_URL = /^(rtsp|rtp|udp|http|https):\/\//i;

function qualityOf(label: string, url: string): QualityKey {
  const l = normText(label);
  if (l === 'hd' || l === 'uhd' || l === '4k' || l === 'fhd') return 'hd';
  if (l === 'standard' || l === 'sd') return 'standard';
  if (l === 'basdebit' || l === 'ld' || l === 'low') return 'low';
  if (l === 'auto') return 'auto';
  const flavour = /[?&]flavour=([a-z]+)/i.exec(url)?.[1]?.toLowerCase();
  if (flavour === 'hd') return 'hd';
  if (flavour === 'sd') return 'standard';
  if (flavour === 'ld') return 'low';
  return 'auto';
}

/** Attributs `clé="valeur"` d'une ligne #EXTINF. */
function attrsOf(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of head.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Sépare « attributs » et « titre » au premier `,` situé hors des guillemets. */
function splitExtinf(line: string): { head: string; title: string } {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return { head: line.slice(0, i), title: line.slice(i + 1).trim() };
  }
  return { head: line, title: '' };
}

const QUALITY_SUFFIX = /\s*\(\s*(auto|hd|uhd|4k|fhd|standard|sd|ld|bas d[ée]bit)\s*\)\s*$/i;

/** « 2 - France 2 (HD) » → numéro, nom nettoyé et libellé de qualité. */
export function parseTitle(raw: string): { num: number; name: string; label: string } {
  let title = raw.replace(/\s+/g, ' ').trim();
  let label = '';
  const q = QUALITY_SUFFIX.exec(title);
  if (q) { label = q[1]; title = title.slice(0, q.index).trim(); }
  let num = 0;
  const n = /^(\d{1,4})\s*[-–.:]\s*(.+)$/.exec(title);
  if (n) { num = Number(n[1]); title = n[2].trim(); }
  // « France 2 HD » et « France 2 » sont la même chaîne.
  const name = title.replace(/\s+(HD|UHD|4K)$/i, '').trim();
  return { num, name, label };
}

function isLocalStream(url: string): boolean {
  try { return isLanHost(new URL(url).hostname); } catch { return false; }
}

export interface ParseOptions {
  /** Identifiant de la playlist (préfixe des identifiants de chaîne). */
  list?: string;
  /** Playlist Freebox : ses flux ne sont lisibles que sur le réseau de la box. */
  freebox?: boolean;
}

/**
 * Analyse une playlist M3U (attributs tvg-id, tvg-name, tvg-logo, group-title, tvg-chno ; `catchup` ignoré) et regroupe les
 * variantes d'une même chaîne (même numéro et même nom normalisé) en une chaîne avec ses qualités.
 * Triée par numéro (les chaînes sans numéro à la suite, dans l'ordre de la playlist).
 */
export function parseM3u(text: string, opts: ParseOptions = {}): BoxChannel[] {
  const list = opts.list ?? 'box';
  const groups = new Map<string, BoxChannel>();
  let pending: { num: number; name: string; label: string; logo: string; group: string; tvgId: string } | null = null;
  for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const { head, title } = splitExtinf(line);
      const a = attrsOf(head);
      const t = parseTitle(title || a['tvg-name'] || '');
      const chno = Number(a['tvg-chno']);
      pending = t.name ? {
        name: t.name, label: t.label, num: t.num || (Number.isInteger(chno) && chno > 0 && chno < 10000 ? chno : 0),
        logo: /^https?:\/\//i.test(a['tvg-logo'] ?? '') ? a['tvg-logo'] : '', group: (a['group-title'] ?? '').trim(), tvgId: (a['tvg-id'] ?? '').trim(),
      } : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending || !STREAM_URL.test(line)) { pending = null; continue; }
    const key = `${pending.num}|${normText(pending.name)}`;
    let ch = groups.get(key);
    if (!ch) {
      ch = {
        id: `${list}:${pending.num || 'x'}-${normText(pending.name)}`, list, name: pending.name, num: pending.num, logo: pending.logo, group: pending.group,
        tvgId: pending.tvgId, local: !!opts.freebox || isLocalStream(line), qualities: [],
      };
      groups.set(key, ch);
    }
    const qk = qualityOf(pending.label, line);
    if (!ch.logo && pending.logo) ch.logo = pending.logo;
    if (!ch.tvgId && pending.tvgId) ch.tvgId = pending.tvgId;
    if (!ch.group && pending.group) ch.group = pending.group;
    if (!ch.qualities.some((x) => x.key === qk)) ch.qualities.push({ key: qk, url: line });
    pending = null;
  }
  const all = Array.from(groups.values());
  const order = new Map(all.map((c, i) => [c, i]));
  return all.sort((a, b) => (a.num || 1e9) - (b.num || 1e9) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Flux d'une chaîne pour la qualité voulue, sinon le meilleur disponible (HD, auto, standard, bas débit). */
export function pickQuality(ch: Pick<BoxChannel, 'qualities'>, pref: QualityKey = 'hd'): BoxQuality | null {
  const order = [pref, ...FALLBACK.filter((k) => k !== pref)];
  for (const k of order) {
    const hit = ch.qualities.find((q) => q.key === k);
    if (hit) return hit;
  }
  return ch.qualities[0] ?? null;
}

// ---------- Playlists enregistrées ----------

type BoxKind = 'freebox' | 'url' | 'file';

export interface BoxList {
  id: string;
  name: string;
  kind: BoxKind;
  /** Adresse de la playlist (contient parfois des identifiants : jamais affichée telle quelle, voir `maskUrl`). */
  url: string;
  /** Guide XMLTV facultatif (.xml ou .xml.gz). */
  guideUrl: string;
  enabled: boolean;
  at: number;
  channels: BoxChannel[];
  /** Définition partagée avec le compte (tous profils et appareils) ; les chaînes restent propres à l'appareil. */
  synced?: boolean;
}

export const FREEBOX_LIST_ID = 'box';

/** Définition d'une playlist telle qu'échangée avec le compte (sans les chaînes : l'appareil les télécharge lui-même). */
export interface BoxListWire { id: string; name: string; kind: 'url' | 'freebox'; url: string; guideUrl: string; enabled: boolean }

/** Playlists à synchroniser avec le compte : celles marquées `synced` (jamais les fichiers importés ni la Freebox détectée ici). */
export function toWire(lists: readonly BoxList[]): BoxListWire[] {
  return lists.filter((l) => l.synced && l.kind !== 'file' && l.url)
    .map((l) => ({ id: l.id, name: l.name, kind: l.kind === 'freebox' ? 'freebox' : 'url', url: l.url, guideUrl: l.guideUrl, enabled: l.enabled }));
}

/**
 * Le compte fait foi pour les playlists synchronisées ; les listes propres à l'appareil (fichier, Freebox détectée ici) restent.
 * Les chaînes déjà téléchargées sont reprises quand l'adresse n'a pas changé (sinon `at` = 0 : à actualiser au lancement).
 */
export function mergeRemote(local: readonly BoxList[], remote: readonly BoxListWire[]): BoxList[] {
  const byId = new Map(local.map((l) => [l.id, l]));
  const synced: BoxList[] = remote.filter((r) => r && typeof r.id === 'string' && typeof r.url === 'string').map((r) => {
    const old = byId.get(r.id);
    const same = old && old.url === r.url;
    return {
      id: r.id, name: String(r.name || 'Playlist'), kind: r.kind === 'freebox' ? 'freebox' : 'url', url: r.url, guideUrl: String(r.guideUrl || ''),
      enabled: r.enabled !== false, at: same ? old.at : 0, channels: same ? old.channels : [], synced: true,
    };
  });
  const ids = new Set(synced.map((l) => l.id));
  return synced.concat(local.filter((l) => !l.synced && !ids.has(l.id)));
}

/** Adresse sans secret pour l'affichage : « http://hote/…/get.php?username=***&password=*** ». */
export function maskUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return '…'; }
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  // Un chemin à plusieurs niveaux peut contenir un identifiant (/live/<user>/<mot de passe>/…) : on n'en garde que la fin.
  const path = segs.length > 1 ? `/…/${last}` : last ? `/${last}` : '';
  const keys = Array.from(new Set(Array.from(u.searchParams.keys())));
  return `${u.protocol}//${u.host}${path}${keys.length ? `?${keys.map((k) => `${k}=***`).join('&')}` : ''}`;
}

/** Une playlist doit-elle être actualisée au lancement (actives, avec adresse, plus d'un jour) ? */
export function refreshDue(l: Pick<BoxList, 'enabled' | 'kind' | 'url' | 'at'>, now = Date.now()): boolean {
  return l.enabled && l.kind !== 'file' && !!l.url && now - l.at >= REFRESH_EVERY_MS;
}

/** Chaînes des playlists actives (la première playlist l'emporte sur les doublons d'identifiant). */
export function activeChannels(lists: readonly BoxList[]): BoxChannel[] {
  const seen = new Set<string>();
  const out: BoxChannel[] = [];
  lists.forEach((l) => { if (l.enabled) l.channels.forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } }); });
  return out;
}

export const newListId = (): string => `pl${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

const BOX_KEY = 'ls_tv_boxes';
const BOX_QUALITY_KEY = 'ls_tv_box_quality';

export function loadLists(): BoxList[] {
  try {
    const raw = localStorage.getItem(BOX_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((l) => l && typeof l.id === 'string' && Array.isArray(l.channels)) as BoxList[] : [];
  } catch { return []; }
}
export function saveLists(lists: readonly BoxList[]): void {
  try {
    if (!lists.length) localStorage.removeItem(BOX_KEY);
    else localStorage.setItem(BOX_KEY, JSON.stringify(lists));
  } catch { /* stockage indisponible */ }
}
export function getBoxQuality(): QualityKey {
  try {
    const v = localStorage.getItem(BOX_QUALITY_KEY) as QualityKey | null;
    return v && QUALITY_KEYS.includes(v) ? v : 'hd';
  } catch { return 'hd'; }
}
export function setBoxQuality(q: QualityKey): void {
  try { localStorage.setItem(BOX_QUALITY_KEY, q); } catch { /* ignoré */ }
}

// ---------- Fusion avec le catalogue ----------

interface Named { name?: string; epgId?: string; id?: string }

/** Clé de rapprochement : entrée de la TNT officielle si la chaîne en est une (« France 2 », « France2.fr »), sinon nom normalisé. */
function matchKey(c: Named): string {
  const e = nationalEntry(c, 'FR');
  if (e) return `n${e.num}`;
  const k = normText(c.name);
  return k ? `k${k}` : '';
}

export interface BoxRef {
  id: string;
  list: string;
  num: number;
  name: string;
  local: boolean;
  qualities: BoxQuality[];
  /** Flux retenu pour la qualité choisie. */
  url: string;
  quality: QualityKey;
}

const refOf = (b: BoxChannel, quality: QualityKey): BoxRef | null => {
  const q = pickQuality(b, quality);
  return q ? { id: b.id, list: b.list, num: b.num, name: b.name, local: b.local, qualities: b.qualities, url: q.url, quality: q.key } : null;
};

export interface MergeableChannel { id: string; name: string; epgId?: string; box?: BoxRef | null; [k: string]: unknown }

/**
 * Pose `box` sur les chaînes du catalogue qui correspondent à une chaîne de la box (la version box devient une source
 * préférée de la même chaîne). Renvoie les identifiants des chaînes rapprochées ; le catalogue est modifié sur place.
 * Seules les chaînes à numéro (Freebox) ou à nom exact sont rapprochées ; les playlists sans rapport restent séparées.
 */
export function mergeBox(catalog: MergeableChannel[], box: readonly BoxChannel[], quality: QualityKey = 'hd'): Set<string> {
  const byKey = new Map<string, BoxChannel>();
  box.forEach((b) => { const k = matchKey(b); if (k && !byKey.has(k)) byKey.set(k, b); });
  const matched = new Set<string>();
  catalog.forEach((c) => {
    const b = byKey.get(matchKey(c));
    if (!b) return;
    const ref = refOf(b, quality);
    if (!ref) return;
    c.box = ref;
    matched.add(b.id);
  });
  return matched;
}

/** Catégorie d'une chaîne de playlist dans la liste TV : « Box · Sport » (préfixée pour ne jamais se confondre avec une catégorie du catalogue). */
export const boxCat = (group: string): string => (group ? `Box · ${group}` : 'Ma box');

/** Chaînes de la box absentes du catalogue chargé, sous la forme d'une chaîne de la liste TV (badge « Box »). */
export function boxOnlyChannels(box: readonly BoxChannel[], matched: ReadonlySet<string>, quality: QualityKey = 'hd'): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  box.forEach((b) => {
    if (matched.has(b.id)) return;
    const ref = refOf(b, quality);
    if (!ref) return;
    const e = nationalEntry(b, 'FR');
    out.push({
      id: b.id, name: b.name, logo: b.logo, group: b.group || 'Ma box', cat: boxCat(b.group), source: 'box', fast: false, url: ref.url, sig: null,
      epgId: e ? `fr:${e.epg}` : '', tvgId: b.tvgId, flaky: false, lowRel: false, alternatives: [], num: b.num || null, box: ref, boxOnly: true,
    });
  });
  return out;
}

/** Catégories (group-title) des chaînes de la box, par ordre alphabétique. */
export function boxGroups(box: readonly BoxChannel[]): string[] {
  return Array.from(new Set(box.map((b) => b.group).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 40);
}

// ---------- États : web, hors du réseau local ----------

export type BoxReach = boolean | null;

export interface BoxAccess { ok: boolean; note: string }

export const NOTE_WEB = 'Disponible dans l’app sur le réseau de ta box';
export const NOTE_WEB_STREAM = 'Disponible dans l’app : ce flux n’est pas lisible dans un navigateur';
export const NOTE_AWAY = 'Disponible à la maison';

/**
 * Une chaîne uniquement présente dans une playlist est-elle lisible ici ?
 * `app` : application Windows ou Android (mpv / libVLC lisent tout) ; navigateur : seulement les flux https ;
 * `reach` : la playlist locale a répondu récemment (null : pas encore testé, on tente quand même).
 */
export function boxAccess(app: boolean, reach: BoxReach, ref: Pick<BoxRef, 'url' | 'local'>): BoxAccess {
  if (!app) {
    if (/^https:\/\//i.test(ref.url) && !ref.local) return { ok: true, note: '' };
    return { ok: false, note: ref.local ? NOTE_WEB : NOTE_WEB_STREAM };
  }
  if (reach === false && ref.local) return { ok: false, note: NOTE_AWAY };
  return { ok: true, note: '' };
}

// ---------- Lecture depuis l'appareil ----------

export type BoxErrorCode = 'web_unavailable' | 'unreachable' | 'not_m3u' | 'too_large' | 'empty' | 'invalid_url';

export class BoxError extends Error {
  constructor(readonly code: BoxErrorCode) { super(code); this.name = 'BoxError'; }
}

export const BOX_MESSAGES: Record<BoxErrorCode, string> = {
  web_unavailable: 'Disponible dans les apps Windows et Android : un navigateur ne peut pas joindre ta box.',
  unreachable: 'Adresse injoignable : vérifie la connexion (et le réseau de ta box pour une Freebox).',
  not_m3u: 'Cette adresse ne renvoie pas une playlist M3U.',
  too_large: 'Fichier trop volumineux (20 Mo maximum).',
  empty: 'Aucune chaîne trouvée dans cette playlist.',
  invalid_url: 'Adresse invalide : saisis une URL http(s).',
};

export interface BoxTransport {
  /** Pont de l'application (coque Windows ou CapacitorHttp) ; null sur le web. */
  native: HttpFn | null;
  fetchHttp: HttpFn;
}

function defaultTransport(): BoxTransport {
  const native = isShellEnvironment() ? shellHttp(() => connectShell(), BOX_COMMAND) : capacitorNative() ? capacitorHttp() : null;
  return { native, fetchHttp: browserFetchHttp() };
}

export const isHttpUrl = (raw: string): boolean => {
  try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; }
};

const M3U_HEAD = /^\s*#EXTM3U/;
const headText = (b: Uint8Array): string => new TextDecoder().decode(b.subarray(0, 64)).replace(/^﻿/, '');

/** Octets du document à `url` (playlist M3U ou guide XMLTV), lus depuis l'appareil. */
export async function fetchBytes(url: string, tr: BoxTransport = defaultTransport()): Promise<Uint8Array> {
  if (!isHttpUrl(url)) throw new BoxError('invalid_url');
  const hop = tr.native ?? tr.fetchHttp;
  let res;
  try {
    res = await hop({ url, method: 'GET', headers: { Accept: 'audio/x-mpegurl, text/plain, application/xml, */*' }, timeoutMs: 20_000 });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'not_playlist' || code === 'not_m3u') throw new BoxError('not_m3u');
    if (code === 'too_large') throw new BoxError('too_large');
    throw new BoxError(tr.native ? 'unreachable' : 'web_unavailable');
  }
  if (res.status < 200 || res.status >= 300) throw new BoxError(tr.native ? 'unreachable' : 'web_unavailable');
  if (res.body.byteLength > MAX_PLAYLIST_BYTES) throw new BoxError('too_large');
  return res.body;
}

/** Analyse le texte d'une playlist ; erreurs `not_m3u`, `too_large` ou `empty`. */
export function channelsFromText(text: string, opts: ParseOptions = {}): BoxChannel[] {
  if (text.length > MAX_PLAYLIST_BYTES) throw new BoxError('too_large');
  if (!M3U_HEAD.test(text.replace(/^﻿/, ''))) throw new BoxError('not_m3u');
  const list = parseM3u(text, opts);
  if (!list.length) throw new BoxError('empty');
  return list;
}

/** Playlist lue à `url` puis analysée. */
export async function fetchBoxChannels(url: string, opts: ParseOptions = {}, tr?: BoxTransport): Promise<BoxChannel[]> {
  const bytes = await fetchBytes(url, tr);
  if (!M3U_HEAD.test(headText(bytes))) throw new BoxError('not_m3u');
  return channelsFromText(new TextDecoder().decode(bytes), opts);
}

/** Joignabilité de chaque playlist locale (mémoire de session) : fixée par `refreshList`, lue par l'interface. */
const reach = new Map<string, BoxReach>();
export const getBoxReach = (listId: string): BoxReach => reach.get(listId) ?? null;
export const setBoxReach = (listId: string, v: BoxReach): void => { reach.set(listId, v); };

/**
 * Relit une playlist depuis son adresse (joignabilité + mise à jour des chaînes). Un fichier importé n'a pas d'adresse :
 * on le suppose joignable. Renvoie la playlist mise à jour, ou la même si la lecture a échoué (la joignabilité est alors fausse
 * seulement pour une erreur de transport).
 */
export async function refreshList(l: BoxList, tr?: BoxTransport): Promise<BoxList> {
  if (l.kind === 'file' || !l.url) { setBoxReach(l.id, true); return l; }
  try {
    const channels = await fetchBoxChannels(l.url, { list: l.id, freebox: l.kind === 'freebox' }, tr);
    setBoxReach(l.id, true);
    return { ...l, channels, at: Date.now() };
  } catch (err) {
    // Playlist illisible ≠ box absente : seule une erreur de transport grise les chaînes.
    const content = err instanceof BoxError && (err.code === 'not_m3u' || err.code === 'empty' || err.code === 'too_large');
    setBoxReach(l.id, content);
    return l;
  }
}
