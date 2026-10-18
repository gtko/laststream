/* Addons amont : la clé du débrideur est dans l'addon, qui débride lui-même (mode recommandé). Ce module lit l'adresse
 * (Torrentio, configuration base64 JSON) pour savoir si l'addon porte une clé, et classe les flux renvoyés (lien lisible
 * = l'addon débride ; infoHash seul = torrents bruts, inutilisables sans débrideur). Fonctions pures, sans réseau :
 * aucune clé n'est renvoyée en clair (maskKey). */

/** Options Torrentio (segments `nom=valeur` séparés par `|`) qui branchent un débrideur. */
export const DEBRID_OPTIONS: string[] = ['realdebrid', 'alldebrid', 'premiumize', 'debridlink', 'torbox', 'offcloud', 'putio'];

/** Hébergeurs de liens débrideur (un flux qui pointe vers eux passe par un débrideur). */
const DEBRID_HOSTS: string[] = ['debrid.it', 'real-debrid.com', 'torbox.app', 'alldebrid.com', 'premiumize.me', 'debrid-link.com', 'debrid-link.fr', 'offcloud.com', 'put.io'];

/** Champs de configuration JSON qui portent une clé d'API. */
const KEY_FIELD = /^(debrid_?api_?key|api_?key)$/i;

/** Lien de résolution de l'addon lui-même : /resolve/…, /playback/…, /r/…. */
const RESOLVE_PATH = /\/(resolve|playback|r)\//i;

/** `self` : l'addon débride lui-même (mode recommandé) ; `torrents` : il ne renvoie que des torrents bruts ; `unknown` : rien de lisible. */
export type Verdict = 'self' | 'torrents' | 'unknown';

export interface UrlFix {
  /** Adresse du manifest réécrite, sans clé. */
  url: string;
  /** Aperçu avant, clés masquées. */
  before: string;
  /** Aperçu après, sans clé. */
  after: string;
}

export interface UrlAnalysis {
  /** Format reconnu : Torrentio, configuration base64 JSON, ou aucun (configuration opaque chez l'addon). */
  format: 'torrentio' | 'json' | 'none';
  /** Une clé (ou un service débrideur déclaré) est présente dans l'adresse. */
  usesDebrid: boolean;
  /** Clés trouvées, masquées (`abcd…wxyz`). */
  masked: string[];
  /** Service débrideur déclaré, si connu. */
  service: string;
  /** Réécriture sans clé quand le format est évident ; sinon null. */
  fix: UrlFix | null;
}

interface Found {
  field: string;
  value: string;
}

interface DecodedConfig {
  obj: Record<string, unknown>;
  urlSafe: boolean;
  padded: boolean;
}

const NONE: UrlAnalysis = { format: 'none', usesDebrid: false, masked: [], service: '', fix: null };

/** Clé masquée pour l'affichage : `abcd…wxyz`. Une valeur courte ne montre rien. */
export function maskKey(value: string): string {
  const v = String(value);
  return v.length >= 10 ? v.slice(0, 4) + '…' + v.slice(-4) : '…';
}

/** Remplace chaque valeur sensible (brute ou encodée) par sa version masquée. */
function maskIn(text: string, values: string[]): string {
  return values.reduce((t, v) => {
    if (!v) return t;
    const forms = Array.from(new Set([v, encodeURIComponent(v)]));
    return forms.reduce((acc, f) => acc.split(f).join(maskKey(v)), t);
  }, text);
}

function decodeText(raw: string): string {
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

const optionName = (o: string): string => o.split('=')[0].trim().toLowerCase();
const optionValue = (o: string): string => o.slice(o.indexOf('=') + 1).trim();

/** Segment Torrentio : options débrideur et autres options. Null si aucune option débrideur. */
function torrentioSegment(seg: string): { debrid: string[]; rest: string[] } | null {
  const opts = decodeText(seg).split('|');
  const debrid = opts.filter((o) => DEBRID_OPTIONS.includes(optionName(o)));
  if (!debrid.length) return null;
  return { debrid, rest: opts.filter((o) => !DEBRID_OPTIONS.includes(optionName(o))) };
}

/** Segment base64 (ou base64url) d'une configuration JSON. Null si le segment n'est pas un objet JSON. */
function decodeConfig(seg: string): DecodedConfig | null {
  if (seg.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(seg)) return null;
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    if (!text.trim().startsWith('{')) return null;
    const obj: unknown = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return { obj: obj as Record<string, unknown>, urlSafe: /[-_]/.test(seg), padded: /=$/.test(seg) };
  } catch (_) {
    return null;
  }
}

function encodeConfig(obj: Record<string, unknown>, urlSafe: boolean, padded: boolean): string {
  let bin = '';
  new TextEncoder().encode(JSON.stringify(obj)).forEach((b) => { bin += String.fromCharCode(b); });
  let out = btoa(bin);
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_');
  return padded ? out : out.replace(/=+$/, '');
}

/** Champ de clé de débrideur. Une clé d'API générique ne compte que si la configuration déclare un debridService. */
function isKeyField(field: string, debridCtx: boolean): boolean {
  if (field === 'debridService') return false;
  return /debrid/i.test(field) || DEBRID_OPTIONS.includes(field.toLowerCase()) || (debridCtx && KEY_FIELD.test(field));
}

/** Toutes les valeurs de clé (texte non vide) de la configuration, à trois niveaux d'imbrication au plus. */
function collectKeys(obj: Record<string, unknown>, debridCtx: boolean, depth = 0): Found[] {
  const out: Found[] = [];
  Object.entries(obj).forEach(([field, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (depth < 3) out.push(...collectKeys(value as Record<string, unknown>, debridCtx, depth + 1));
    } else if (typeof value === 'string' && value.trim() && isKeyField(field, debridCtx)) {
      out.push({ field, value: value.trim() });
    }
  });
  return out;
}

/** Copie de la configuration sans les champs de clé. */
function stripKeys(obj: Record<string, unknown>, debridCtx: boolean, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  Object.entries(obj).forEach(([field, value]) => {
    if (typeof value === 'string' && value.trim() && isKeyField(field, debridCtx)) return;
    out[field] = value && typeof value === 'object' && !Array.isArray(value) && depth < 3
      ? stripKeys(value as Record<string, unknown>, debridCtx, depth + 1)
      : value;
  });
  return out;
}

/** Copie de la configuration avec les clés masquées (pour l'aperçu). */
function maskObj(obj: Record<string, unknown>, debridCtx: boolean, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  Object.entries(obj).forEach(([field, value]) => {
    if (typeof value === 'string' && value.trim() && isKeyField(field, debridCtx)) out[field] = maskKey(value.trim());
    else out[field] = value && typeof value === 'object' && !Array.isArray(value) && depth < 3
      ? maskObj(value as Record<string, unknown>, debridCtx, depth + 1)
      : value;
  });
  return out;
}

/** Adresse avec un autre chemin (les segments gardent leur ordre). */
function withPath(url: URL, parts: string[]): string {
  const next = new URL(url.toString());
  next.pathname = parts.join('/');
  return next.toString();
}

/** Lit l'adresse d'un manifest : format reconnu, clés présentes (masquées) et réécriture sans clé si elle est évidente. */
export function analyzeAddonUrl(manifest: string): UrlAnalysis {
  let url: URL;
  try { url = new URL(manifest); } catch (_) { return NONE; }
  const parts = url.pathname.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const tor = torrentioSegment(parts[i]);
    if (tor) {
      const keyed = tor.debrid.filter((o) => optionValue(o) !== '');
      if (!keyed.length) continue;
      const values = keyed.map(optionValue);
      const next = parts.slice();
      if (tor.rest.length) next[i] = tor.rest.join('|');
      else next.splice(i, 1);
      const after = withPath(url, next);
      return {
        format: 'torrentio',
        usesDebrid: true,
        masked: values.map(maskKey),
        service: optionName(keyed[0]),
        fix: { url: after, before: maskIn(url.toString(), values), after: maskIn(after, values) },
      };
    }
    const cfg = decodeConfig(parts[i]);
    if (cfg) {
      // Schéma évident : le champ debridService existe. Il passe alors à « torrent » et les clés sont retirées.
      const clear = typeof cfg.obj.debridService === 'string';
      const service = clear ? (cfg.obj.debridService as string).trim().toLowerCase() : '';
      const found = collectKeys(cfg.obj, clear);
      if (!found.length && !DEBRID_OPTIONS.includes(service)) continue;
      const clean = stripKeys(cfg.obj, clear);
      if (clear) clean.debridService = 'torrent';
      const next = parts.slice();
      next[i] = encodeConfig(clean, cfg.urlSafe, cfg.padded);
      return {
        format: 'json',
        usesDebrid: true,
        masked: found.map((f) => maskKey(f.value)),
        service,
        fix: clear
          ? { url: withPath(url, next), before: JSON.stringify(maskObj(cfg.obj, clear)), after: JSON.stringify(clean) }
          : null,
      };
    }
  }
  return NONE;
}

/** Vrai si l'adresse pointe vers un débrideur : hébergeur débrideur, ou lien de résolution de l'addon lui-même. */
export function isDebridUrl(raw: string, addonOrigin: string): boolean {
  let u: URL;
  try { u = new URL(raw, addonOrigin); } catch (_) { return false; }
  const host = u.hostname.toLowerCase();
  if (DEBRID_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true;
  return u.origin === addonOrigin && RESOLVE_PATH.test(u.pathname);
}

/** Classe la réponse de l'addon : un lien lisible (débrideur de l'addon ou lien direct) l'emporte ; sinon un infoHash = torrents bruts. */
const RE_HTTP = /^https?:\/\//i;

export function classifyStreams(streams: unknown, addonOrigin: string): Verdict {
  if (!Array.isArray(streams) || !streams.length) return 'unknown';
  let torrents = false;
  for (const item of streams) {
    if (!item || typeof item !== 'object') continue;
    const st = item as Record<string, unknown>;
    if (typeof st.url === 'string' && (isDebridUrl(st.url, addonOrigin) || RE_HTTP.test(st.url))) return 'self';
    if (typeof st.infoHash === 'string' && st.infoHash.trim() !== '') torrents = true;
  }
  return torrents ? 'torrents' : 'unknown';
}
