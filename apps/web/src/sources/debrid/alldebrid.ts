/* Fournisseur AllDebrid (API v4 / v4.1), appelé depuis l'appareil. Logique portée de l'ancien client serveur de lastAddon
 * (src/sources/alldebrid.ts) : contrôle « cache » par ajout du magnet (aucun endpoint de disponibilité instantanée), suppression
 * des seuls magnets créés par ce contrôle et non prêts, choix du fichier, déblocage du lien.
 * La clé ne part que dans l'en-tête Authorization ; aucune erreur ne la contient. */

import { pickFile, type FlatFile } from './files';
import { jsonOf, type HttpFn, type HttpResponse } from './http';
import { DebridError, normalizeHash, type AccountState, type DebridProvider, type FileHint, type ProviderStatus, type ResolvedLink } from './types';

const API = 'https://api.alldebrid.com';
const AGENT = 'laststream';
const CHECK_BATCH_SIZE = 20;
const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1_500;
/** Écart minimal entre deux appels : AllDebrid sanctionne les rafales. */
const MIN_GAP_MS = 400;
const STATUS_READY = 4;
const STATUS_ERROR_FROM = 5;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (v: unknown): boolean => v !== undefined && v !== null;
const idOf = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null);
const codeOf = (e: unknown): string => {
  const c = isRec(e) ? e.code : undefined;
  return typeof c === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(c) ? c : 'unknown';
};

const DAY = 24 * 3600_000;

/** Heure de fin indiquée dans un message (« jusqu'au 19/10/2026 03:10 », date ISO), sinon undefined. */
export function untilFromMessage(message: unknown, now: number): number | undefined {
  if (typeof message !== 'string') return undefined;
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(message);
  if (iso) { const t = Date.parse(`${iso[1]}T${iso[2]}:00`); if (Number.isFinite(t) && t > now) return t; }
  const fr = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2})[:h](\d{2}))?/.exec(message);
  if (fr) {
    const t = new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), Number(fr[4] ?? 0), Number(fr[5] ?? 0)).getTime();
    if (Number.isFinite(t) && t > now) return t;
  }
  return undefined;
}

/** Code d'erreur AllDebrid → nature et état de compte. */
export function classifyError(code: string, message: unknown, now: number): DebridError {
  if (/^AUTH_(USER_BANNED|BLOCKED)$|SUSPEND|BANNED/.test(code)) {
    return new DebridError(code, 'account', { state: 'suspended', until: untilFromMessage(message, now) ?? now + 6 * 3600_000 });
  }
  if (/^AUTH_(BAD_APIKEY|MISSING_APIKEY)$/.test(code)) return new DebridError(code, 'account', { state: 'invalid_key', until: now + 365 * DAY });
  if (/LIMIT|QUOTA|NO_SERVER|PREMIUM/.test(code)) return new DebridError(code, 'account', { state: /PREMIUM/.test(code) ? 'not_premium' : 'quota', until: now + 3600_000 });
  if (/^MAGNET_|^LINK_|^MUXER|^REDIRECTOR|^NO_|^FILE|DELAYED|HOST/.test(code)) return new DebridError(code, 'content');
  return new DebridError(code, 'transient');
}

export interface AllDebridOptions {
  apiKey: string;
  http: HttpFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function flatten(nodes: readonly unknown[], out: Array<FlatFile> = []): FlatFile[] {
  for (const node of nodes) {
    if (!isRec(node)) continue;
    if (Array.isArray(node.e)) { flatten(node.e, out); continue; }
    if (typeof node.n === 'string' && typeof node.l === 'string') out.push({ key: node.l, name: node.n, size: typeof node.s === 'number' ? node.s : 0 });
  }
  return out;
}

export function createAllDebrid(o: AllDebridOptions): DebridProvider {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastCall = 0;
  let backoffUntil = 0;

  async function call(method: 'GET' | 'POST', path: string, form?: URLSearchParams, signal?: AbortSignal): Promise<Rec> {
    if (now() < backoffUntil) throw new DebridError('rate_limited', 'transient', { retryAfterMs: backoffUntil - now() });
    const wait = lastCall + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();
    const res: HttpResponse = await o.http({
      url: `${API}${path}${path.includes('?') ? '&' : '?'}agent=${AGENT}`,
      method,
      headers: { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form?.toString(),
      signal,
    });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers['retry-after']);
      const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 600_000) : 30_000;
      backoffUntil = now() + ms;
      throw new DebridError('rate_limited', 'transient', { retryAfterMs: ms });
    }
    const body = jsonOf(res);
    if (isRec(body) && body.status === 'error') {
      const err = isRec(body.error) ? body.error : {};
      throw classifyError(codeOf(err), err.message, now());
    }
    if (res.status < 200 || res.status >= 300 || !isRec(body) || body.status !== 'success' || !isRec(body.data)) throw new DebridError('invalid_response', 'transient');
    return body.data;
  }

  async function listMagnetIds(signal?: AbortSignal): Promise<Set<string>> {
    const data = await call('POST', '/v4.1/magnet/status', new URLSearchParams(), signal);
    if (!Array.isArray(data.magnets)) throw new DebridError('invalid_response', 'transient');
    const ids = new Set<string>();
    for (const m of data.magnets) {
      const id = isRec(m) ? idOf(m.id) : null;
      if (id === null) throw new DebridError('invalid_response', 'transient');
      ids.add(id);
    }
    return ids;
  }

  async function removeMagnet(id: string): Promise<void> {
    try { await call('POST', '/v4/magnet/delete', new URLSearchParams([['id', id]])); } catch { /* best effort */ }
  }

  async function checkBatch(batch: readonly string[], signal?: AbortSignal): Promise<Map<string, boolean>> {
    const found = new Map<string, boolean>();
    // Sans liste de référence des magnets du compte, rien n'est envoyé : un magnet déjà présent ne se distinguerait pas.
    const existing = await listMagnetIds(signal);
    const data = await call('POST', '/v4/magnet/upload', new URLSearchParams(batch.map((h): [string, string] => ['magnets[]', h])), signal);
    const entries = Array.isArray(data.magnets) ? data.magnets : [];
    const removable: string[] = [];
    for (const e of entries) {
      if (!isRec(e) || has(e.error)) continue;
      const hash = typeof e.hash === 'string' ? e.hash.toLowerCase() : '';
      if (!batch.includes(hash) || typeof e.ready !== 'boolean') continue;
      found.set(hash, e.ready);
      const id = idOf(e.id);
      // L'upload renvoie l'id existant si le magnet est déjà au compte : seul un id absent de la liste est à nous.
      if (!e.ready && id !== null && !existing.has(id)) removable.push(id);
    }
    for (const id of removable) await removeMagnet(id);
    return found;
  }

  async function waitReady(id: string, signal?: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      const data = await call('POST', '/v4.1/magnet/status', new URLSearchParams([['id', id]]), signal);
      const list = Array.isArray(data.magnets) ? data.magnets : [data.magnets];
      const entry = list.find(isRec);
      const code = entry && typeof entry.statusCode === 'number' ? entry.statusCode : undefined;
      if (code === STATUS_READY) return;
      if (code !== undefined && code >= STATUS_ERROR_FROM) throw new DebridError('magnet_failed', 'content');
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
    }
    throw new DebridError('not_ready', 'content');
  }

  return {
    id: 'alldebrid',
    label: 'AllDebrid',

    async checkCache(hashes, signal) {
      const result = new Map<string, boolean>();
      const unique = [...new Set(hashes.map(normalizeHash).filter((h): h is string => h !== null))];
      for (let i = 0; i < unique.length; i += CHECK_BATCH_SIZE) {
        try {
          for (const [h, ready] of await checkBatch(unique.slice(i, i + CHECK_BATCH_SIZE), signal)) result.set(h, ready);
        } catch (err) {
          // Une erreur de compte interrompt tout ; le reste (réseau, réponse) laisse les hashes inconnus.
          if (err instanceof DebridError && err.kind === 'account') throw err;
          if (err instanceof DebridError && err.code === 'aborted') throw err;
        }
      }
      return result;
    },

    async resolve(hash, hint: FileHint, signal): Promise<ResolvedLink> {
      const h = normalizeHash(hash);
      if (h === null) throw new DebridError('invalid_hash', 'content');
      const up = await call('POST', '/v4/magnet/upload', new URLSearchParams([['magnets[]', h]]), signal);
      const entry = (Array.isArray(up.magnets) ? up.magnets : []).find(isRec);
      if (!entry) throw new DebridError('invalid_response', 'transient');
      if (has(entry.error)) throw classifyError(codeOf(entry.error), isRec(entry.error) ? entry.error.message : undefined, now());
      const id = idOf(entry.id);
      if (id === null) throw new DebridError('invalid_response', 'transient');
      if (entry.ready !== true) await waitReady(id, signal);
      const filesData = await call('POST', '/v4/magnet/files', new URLSearchParams([['id[]', id]]), signal);
      const fe = (Array.isArray(filesData.magnets) ? filesData.magnets : []).find(isRec);
      if (!fe || !Array.isArray(fe.files)) throw new DebridError('invalid_response', 'transient');
      if (has(fe.error)) throw new DebridError(codeOf(fe.error), 'content');
      const file = pickFile(flatten(fe.files), hint);
      const unlocked = await call('POST', '/v4/link/unlock', new URLSearchParams([['link', file.key]]), signal);
      if (has(unlocked.delayed)) throw new DebridError('not_ready', 'content');
      if (typeof unlocked.link !== 'string' || !/^https?:\/\//i.test(unlocked.link)) throw new DebridError('invalid_response', 'transient');
      return {
        url: unlocked.link,
        filename: typeof unlocked.filename === 'string' ? unlocked.filename : file.name,
        size: typeof unlocked.filesize === 'number' ? unlocked.filesize : file.size,
      };
    },

    async status(signal): Promise<ProviderStatus> {
      try {
        const data = await call('GET', '/v4/user', undefined, signal);
        if (!isRec(data.user)) return { state: 'unreachable', detail: 'invalid_response' };
        const premium = data.user.isPremium === true;
        return premium ? { state: 'ok', premium } : { state: 'not_premium', premium };
      } catch (err) {
        if (err instanceof DebridError) {
          const state: AccountState = err.state ?? (err.kind === 'unsupported' ? 'unsupported' : 'unreachable');
          return { state, detail: err.code, ...(err.until ? { until: err.until } : {}) };
        }
        return { state: 'unreachable' };
      }
    },
  };
}
