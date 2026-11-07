/* Fournisseur TorBox (https://api.torbox.app/v1/api), appelé depuis l'appareil par le pont natif (CORS réservé à torbox.app).
 * Cache : POST torrents/checkcached (lecture seule, aucun ajout au compte). Résolution : torrents/createtorrent (magnet),
 * torrents/mylist?id (fichiers), torrents/requestdl (lien HTTPS). Jeton : en-tête Authorization (et paramètre `token` de requestdl,
 * exigé par l'API) ; jamais journalisé. */

import { pickFile, type FlatFile } from './files';
import { jsonOf, type HttpFn, type HttpResponse } from './http';
import { DebridError, normalizeHash, type AccountState, type DebridProvider, type FileHint, type ProviderStatus, type ResolvedLink } from './types';

const API = 'https://api.torbox.app/v1/api';
const CHECK_BATCH = 50;
const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 1_500;
const DAY = 24 * 3600_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Réponse en erreur (HTTP ou `success:false`) → erreur typée. */
function classifyTorbox(status: number, body: unknown, now: number, retryAfter?: string): DebridError {
  const code = isRec(body) && typeof body.error === 'string' ? body.error : isRec(body) && typeof body.detail === 'string' ? 'detail' : 'unknown';
  const text = JSON.stringify(isRec(body) ? { e: body.error, d: body.detail } : '').toUpperCase();
  if (status === 429) {
    const ra = Number(retryAfter);
    return new DebridError('rate_limited', 'transient', { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 });
  }
  if (status === 401 || status === 403 || /BAD_TOKEN|AUTH_ERROR|NOT AUTHENTICATED|INVALID TOKEN/.test(text)) {
    return new DebridError(code === 'unknown' ? 'bad_token' : code, 'account', { state: 'invalid_key', until: now + 365 * DAY });
  }
  if (/BAN|SUSPEND|DISABLED/.test(text)) return new DebridError(code, 'account', { state: 'suspended', until: now + 6 * 3600_000 });
  if (/MONTHLY_LIMIT|ACTIVE_LIMIT|COOLDOWN_LIMIT|PLAN_RESTRICTED|DOWNLOAD_SERVER|QUOTA|LIMIT/.test(text)) {
    return new DebridError(code, 'account', { state: /PLAN_RESTRICTED/.test(text) ? 'not_premium' : 'quota', until: now + 3600_000 });
  }
  if (/NO_FILES|TORRENT|MAGNET|INVALID|NOT_FOUND|ITEM_NOT_FOUND|ERROR_PROCESSING/.test(text)) return new DebridError(code, 'content');
  return new DebridError(code, 'transient');
}

export interface TorboxOptions {
  apiKey: string;
  http: HttpFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createTorbox(o: TorboxOptions): DebridProvider {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const auth = { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json' };

  async function call(method: 'GET' | 'POST', path: string, opts: { json?: unknown; form?: URLSearchParams; signal?: AbortSignal } = {}): Promise<unknown> {
    const headers: Record<string, string> = { ...auth };
    let body: string | undefined;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    else if (opts.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = opts.form.toString(); }
    const res: HttpResponse = await o.http({ url: `${API}${path}`, method, headers, body, signal: opts.signal });
    const parsed = jsonOf(res);
    if (res.status < 200 || res.status >= 300 || (isRec(parsed) && parsed.success === false)) throw classifyTorbox(res.status, parsed, now(), res.headers['retry-after']);
    if (!isRec(parsed)) throw new DebridError('invalid_response', 'transient');
    return parsed.data;
  }

  return {
    id: 'torbox',
    label: 'TorBox',

    async checkCache(hashes, signal) {
      const result = new Map<string, boolean>();
      const unique = [...new Set(hashes.map(normalizeHash).filter((h): h is string => h !== null))];
      for (let i = 0; i < unique.length; i += CHECK_BATCH) {
        const batch = unique.slice(i, i + CHECK_BATCH);
        try {
          const data = await call('POST', '/torrents/checkcached?format=object&list_files=false', { json: { hashes: batch }, signal });
          const cached = new Set(isRec(data) ? Object.keys(data).map((k) => k.toLowerCase()) : []);
          for (const h of batch) result.set(h, cached.has(h));
        } catch (err) {
          if (err instanceof DebridError && (err.kind === 'account' || err.code === 'aborted')) throw err;
        }
      }
      return result;
    },

    async resolve(hash, hint: FileHint, signal): Promise<ResolvedLink> {
      const h = normalizeHash(hash);
      if (h === null) throw new DebridError('invalid_hash', 'content');
      const created = await call('POST', '/torrents/createtorrent', {
        form: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${h}`, seed: '3', allow_zip: 'false', as_queued: 'false' }),
        signal,
      });
      const id = isRec(created) ? created.torrent_id ?? created.queued_id : undefined;
      if (typeof id !== 'number' && typeof id !== 'string') throw new DebridError('invalid_response', 'transient');
      let info: Rec | undefined;
      for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
        const data = await call('GET', `/torrents/mylist?id=${encodeURIComponent(String(id))}&bypass_cache=true`, { signal });
        info = isRec(data) ? data : Array.isArray(data) ? data.find(isRec) : undefined;
        if (info && (info.download_finished === true || info.download_present === true)) break;
        if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
        info = undefined;
      }
      if (!info) throw new DebridError('not_ready', 'content');
      const files: FlatFile[] = (Array.isArray(info.files) ? info.files : []).filter(isRec).map((f) => ({
        key: String(f.id), name: String(f.name ?? f.short_name ?? ''), size: typeof f.size === 'number' ? f.size : 0,
      }));
      const file = pickFile(files, hint);
      const url = await call('GET', `/torrents/requestdl?token=${encodeURIComponent(o.apiKey)}&torrent_id=${encodeURIComponent(String(id))}&file_id=${encodeURIComponent(file.key)}&zip_link=false`, { signal });
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new DebridError('invalid_response', 'transient');
      return { url, filename: file.name.split('/').pop() ?? file.name, size: file.size };
    },

    async status(signal): Promise<ProviderStatus> {
      try {
        const data = await call('GET', '/user/me', { signal });
        const plan = isRec(data) ? data.plan : undefined;
        if (plan === 0) return { state: 'not_premium', premium: false };
        return { state: 'ok', premium: true };
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
