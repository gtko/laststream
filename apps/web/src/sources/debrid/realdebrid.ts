/* Fournisseur Real-Debrid (https://api.real-debrid.com/rest/1.0), appelé depuis l'appareil par le pont natif (aucun en-tête CORS).
 * Cache : l'endpoint instantAvailability est désactivé chez Real-Debrid depuis 2024 ; le statut « en cache » reste donc INCONNU
 * (checkCache renvoie une Map vide, jamais d'ajout de masse). Résolution : addMagnet → info (liste des fichiers) → selectFiles
 * (le fichier voulu seulement) → info jusqu'à « downloaded » → unrestrict/link. Un torrent qui ne devient pas prêt rapidement
 * (non caché) est supprimé du compte : pas de téléchargement à la demande, donc aucun abus. */

import { pickFile, type FlatFile } from './files';
import { jsonOf, type HttpFn, type HttpResponse } from './http';
import { DebridError, normalizeHash, type AccountState, type DebridProvider, type FileHint, type ProviderStatus, type ResolvedLink } from './types';

const API = 'https://api.real-debrid.com/rest/1.0';
const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 1_200;
const DAY = 24 * 3600_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function classifyRd(status: number, body: unknown, now: number, retryAfter?: string): DebridError {
  const err = isRec(body) && typeof body.error === 'string' ? body.error : 'unknown';
  if (status === 429 || err === 'too_many_requests') {
    const ra = Number(retryAfter);
    return new DebridError('rate_limited', 'transient', { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 });
  }
  if (err === 'bad_token' || status === 401) return new DebridError('bad_token', 'account', { state: 'invalid_key', until: now + 365 * DAY });
  if (/account_locked|account_not_activated|ip_not_allowed|permission_denied|banned/.test(err)) {
    return new DebridError(err, 'account', { state: 'suspended', until: now + 6 * 3600_000 });
  }
  if (/traffic_exhausted|fair_usage|too_many_active|hoster_limit|daily_limit/.test(err)) return new DebridError(err, 'account', { state: 'quota', until: now + 3600_000 });
  if (/premium|not_premium/.test(err)) return new DebridError(err, 'account', { state: 'not_premium', until: now + DAY });
  if (/magnet|torrent|infringing|unavailable|file|link|dead|virus|unknown_resource|bad_link/.test(err)) return new DebridError(err, 'content');
  return new DebridError(err, 'transient');
}

export interface RealDebridOptions {
  apiKey: string;
  http: HttpFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createRealDebrid(o: RealDebridOptions): DebridProvider {
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, form?: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    const res: HttpResponse = await o.http({
      url: `${API}${path}`,
      method,
      headers: { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form?.toString(),
      signal,
    });
    if (res.status === 204 || (res.status >= 200 && res.status < 300 && res.body.length === 0)) return {};
    const parsed = jsonOf(res);
    if (res.status < 200 || res.status >= 300) throw classifyRd(res.status, parsed, now(), res.headers['retry-after']);
    return parsed;
  }

  async function dropTorrent(id: string): Promise<void> {
    try { await call('DELETE', `/torrents/delete/${encodeURIComponent(id)}`); } catch { /* best effort */ }
  }

  async function info(id: string, signal?: AbortSignal): Promise<Rec> {
    const data = await call('GET', `/torrents/info/${encodeURIComponent(id)}`, undefined, signal);
    if (!isRec(data)) throw new DebridError('invalid_response', 'transient');
    return data;
  }

  return {
    id: 'realdebrid',
    label: 'Real-Debrid',

    // Statut inconnu : instantAvailability n'existe plus. Aucun appel.
    checkCache() {
      return Promise.resolve(new Map<string, boolean>());
    },

    async resolve(hash, hint: FileHint, signal): Promise<ResolvedLink> {
      const h = normalizeHash(hash);
      if (h === null) throw new DebridError('invalid_hash', 'content');
      const added = await call('POST', '/torrents/addMagnet', new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${h}` }), signal);
      const id = isRec(added) && typeof added.id === 'string' ? added.id : null;
      if (id === null) throw new DebridError('invalid_response', 'transient');
      try {
        let current: Rec | undefined;
        for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
          current = await info(id, signal);
          if (current.status === 'waiting_files_selection' || current.status === 'downloaded') break;
          if (/error|dead|virus/.test(String(current.status))) throw new DebridError('magnet_failed', 'content');
          if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
          current = undefined;
        }
        if (!current) throw new DebridError('not_ready', 'content');
        const files: FlatFile[] = (Array.isArray(current.files) ? current.files : []).filter(isRec).map((f) => ({
          key: String(f.id), name: String(f.path ?? ''), size: typeof f.bytes === 'number' ? f.bytes : 0,
        }));
        if (current.status === 'waiting_files_selection') {
          const file = pickFile(files, hint);
          await call('POST', `/torrents/selectFiles/${encodeURIComponent(id)}`, new URLSearchParams({ files: file.key }), signal);
          for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
            current = await info(id, signal);
            if (current.status === 'downloaded') break;
            if (/error|dead|virus/.test(String(current.status))) throw new DebridError('magnet_failed', 'content');
            if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
          }
          if (current.status !== 'downloaded') throw new DebridError('not_ready', 'content');
        }
        const links = Array.isArray(current.links) ? current.links.filter((l): l is string => typeof l === 'string') : [];
        if (links.length === 0) throw new DebridError('no_file', 'content');
        const selected = files.filter((f) => isRec(current) && Array.isArray(current.files) && (current.files as Rec[]).some((x) => String(x.id) === f.key && x.selected === 1));
        const chosen = selected.length ? pickFile(selected, hint) : pickFile(files, hint);
        const un = await call('POST', '/unrestrict/link', new URLSearchParams({ link: links[0] }), signal);
        if (!isRec(un) || typeof un.download !== 'string' || !/^https:\/\//i.test(un.download)) throw new DebridError('invalid_response', 'transient');
        // Un lien débloqué reste valable : le torrent n'a plus à rester au compte.
        void dropTorrent(id);
        return {
          url: un.download,
          filename: typeof un.filename === 'string' ? un.filename : chosen.name.split('/').pop() ?? chosen.name,
          size: typeof un.filesize === 'number' ? un.filesize : chosen.size,
        };
      } catch (err) {
        // Pas prêt (non caché) ou en erreur : le torrent ajouté n'est pas laissé au compte.
        if (err instanceof DebridError && (err.kind === 'content' || err.kind === 'transient')) await dropTorrent(id);
        throw err;
      }
    },

    async status(signal): Promise<ProviderStatus> {
      try {
        const data = await call('GET', '/user', undefined, signal);
        if (!isRec(data)) return { state: 'unreachable', detail: 'invalid_response' };
        return data.type === 'premium' || data.premium ? { state: 'ok', premium: true } : { state: 'not_premium', premium: false };
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
