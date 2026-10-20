/* Débridage sur l'appareil, multi-fournisseurs (AllDebrid, TorBox, Real-Debrid).
 *
 * RÈGLE : les débrideurs ne sont contactés QUE depuis l'appareil de l'utilisateur (son IP résidentielle), jamais par le serveur
 * lastAddon : ils suspendent les comptes appelés depuis des IP de datacenter. Le serveur ne livre que des sources « client »
 * (infoHash + fichier attendu, `behaviorHints.lastDebrid = "client"`), sans lien.
 *
 * Clés : saisies dans Réglages > Sources et debrid et gardées UNIQUEMENT dans le stockage local de l'appareil (jamais envoyées
 * au serveur, jamais journalisées). Choix plutôt qu'une route serveur qui renverrait la clé déchiffrée : la clé ne transite
 * plus par Cloudflare, et une fuite du serveur ou de la configuration ne donne plus accès au compte.
 *
 * Logique :
 *  - cache combiné : une source est « en cache » si au moins un fournisseur disponible l'a (statuts gardés en IndexedDB) ;
 *  - résolution : premier fournisseur (dans l'ordre de priorité) qui l'a en cache, sinon le premier disponible ;
 *  - erreur de compte (suspendu, quota, clé invalide) : fournisseur indisponible jusqu'à l'heure indiquée et bascule automatique. */

import { createAllDebrid } from './debrid/alldebrid';
import { createHttp, nativeKind, webBlocked, type NativeKind } from './debrid/http';
import { createRealDebrid } from './debrid/realdebrid';
import { createTorbox } from './debrid/torbox';
import {
  DebridError, PROVIDER_IDS, PROVIDER_LABEL, normalizeHash,
  type ClientCopy, type DebridProvider, type FileHint, type ProviderId, type ProviderStatus, type ResolvedLink,
} from './debrid/types';
import { forgetSharedLink, getSharedLink, publishSharedLink, sourceKeyFor } from './sharedLinks';

export { PROVIDER_LABEL, DebridError };
export type { ClientCopy, ProviderId, ProviderStatus };

const SETTINGS_KEY = 'laststream.debrid.v1';
const STATE_KEY = 'laststream.debrid.state.v1';
/** Sources torrent vérifiées par titre (les N meilleures) : chaque vérification AllDebrid ajoute des magnets au compte. */
export const CHECK_TOP_N = 8;
const POSITIVE_TTL_MS = 6 * 3600_000;
const NEGATIVE_TTL_MS = 30 * 60_000;
const RESOLVE_TTL_MS = 3600_000;
/** Copies d'une même source essayées chez un fournisseur avant de passer au suivant. */
const MAX_COPIES_TRIED = 3;
/** Fournisseurs dont l'API ferme CORS : pont natif obligatoire. */
const NEEDS_NATIVE: Record<ProviderId, boolean> = { alldebrid: false, torbox: true, realdebrid: true };

// ---------- Stockage local ----------

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const safeLocal = (): KeyValueStore => {
  try {
    const s = globalThis.localStorage;
    s.getItem('x');
    return s;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } };
  }
};

export interface DebridSettings {
  keys: Partial<Record<ProviderId, string>>;
  /** Ordre de priorité (tous les fournisseurs, même sans clé). */
  order: ProviderId[];
}

const normalizeOrder = (order: unknown): ProviderId[] => {
  const list = Array.isArray(order) ? order.filter((x): x is ProviderId => PROVIDER_IDS.includes(x as ProviderId)) : [];
  const seen = new Set<ProviderId>();
  const out = list.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return [...out, ...PROVIDER_IDS.filter((id) => !seen.has(id))];
};

function readSettings(store: KeyValueStore): DebridSettings {
  try {
    const raw = JSON.parse(store.getItem(SETTINGS_KEY) ?? 'null') as { keys?: Record<string, unknown>; order?: unknown } | null;
    const keys: DebridSettings['keys'] = {};
    for (const id of PROVIDER_IDS) {
      const k = raw?.keys?.[id];
      if (typeof k === 'string' && k.trim() !== '') keys[id] = k.trim();
    }
    return { keys, order: normalizeOrder(raw?.order) };
  } catch {
    return { keys: {}, order: [...PROVIDER_IDS] };
  }
}

function writeSettings(store: KeyValueStore, s: DebridSettings): void {
  try { store.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}

// ---------- Cache des statuts (IndexedDB, repli mémoire) ----------

export interface StatusEntry { cached: boolean; at: number }

export interface StatusStore {
  get(key: string): Promise<StatusEntry | undefined>;
  set(key: string, entry: StatusEntry): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStatusStore implements StatusStore {
  private readonly map = new Map<string, StatusEntry>();
  get(key: string): Promise<StatusEntry | undefined> { return Promise.resolve(this.map.get(key)); }
  set(key: string, entry: StatusEntry): Promise<void> { this.map.set(key, entry); return Promise.resolve(); }
  clear(): Promise<void> { this.map.clear(); return Promise.resolve(); }
}

const DB_NAME = 'laststream-debrid';
const DB_STORE = 'status';

class IdbStatusStore implements StatusStore {
  private db: Promise<IDBDatabase | null> | null = null;
  private readonly fallback = new MemoryStatusStore();

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    this.db = new Promise((resolve) => {
      try {
        const req = globalThis.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = fn(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  async get(key: string): Promise<StatusEntry | undefined> {
    const v = await this.run('readonly', (s) => s.get(key));
    return (v as StatusEntry | undefined) ?? this.fallback.get(key);
  }

  async set(key: string, entry: StatusEntry): Promise<void> {
    await this.fallback.set(key, entry);
    await this.run('readwrite', (s) => s.put(entry, key));
  }

  async clear(): Promise<void> {
    await this.fallback.clear();
    await this.run('readwrite', (s) => s.clear());
  }
}

// ---------- Disponibilité des fournisseurs ----------

export interface ProviderHealth {
  state: ProviderStatus['state'];
  until?: number;
  detail?: string;
  at: number;
}

export interface CacheVerdict {
  /** Vrai si au moins un fournisseur disponible l'a en cache ; faux si tous le disent absent ; undefined si inconnu. */
  cached: boolean | undefined;
  /** Fournisseurs qui l'ont en cache, dans l'ordre de priorité. */
  by: ProviderId[];
}

export interface DebridManagerOptions {
  store?: KeyValueStore;
  statuses?: StatusStore;
  /** Fabrique des fournisseurs (tests : réponses simulées). */
  makeProvider?: (id: ProviderId, apiKey: string) => DebridProvider;
  now?: () => number;
  /** Appelé quand la lecture bascule d'un fournisseur à un autre (toast « AllDebrid indisponible → TorBox »). */
  onSwitch?: (from: ProviderId, to: ProviderId) => void;
  /** Appelé quand un fournisseur devient indisponible ou le redevient. */
  onHealth?: (id: ProviderId, health: ProviderHealth) => void;
  native?: () => NativeKind;
}

export interface ClientResolved extends ResolvedLink {
  /** Fournisseur qui a débloqué le lien sur cet appareil ; absent quand le lien vient d'un autre appareil du compte (partage serveur). */
  provider?: ProviderId;
  /** Fournisseur(s) sauté(s) pour cause de compte indisponible avant celui-ci. */
  switchedFrom?: ProviderId;
}

export class DebridManager {
  private readonly store: KeyValueStore;
  private readonly statuses: StatusStore;
  private readonly now: () => number;
  private readonly providers = new Map<string, DebridProvider>();
  private health: Partial<Record<ProviderId, ProviderHealth>> = {};
  private readonly resolved = new Map<string, { at: number; value: ClientResolved }>();
  private readonly checks = new Map<string, Promise<void>>();
  private handlers: Pick<DebridManagerOptions, 'onSwitch' | 'onHealth'> = {};

  constructor(private readonly o: DebridManagerOptions = {}) {
    this.store = o.store ?? safeLocal();
    this.statuses = o.statuses ?? new IdbStatusStore();
    this.now = o.now ?? (() => Date.now());
    try { this.health = JSON.parse(this.store.getItem(STATE_KEY) ?? '{}') as typeof this.health; } catch { this.health = {}; }
  }

  /** Écouteurs de l'interface : bascule (toast) et changement d'état d'un fournisseur. */
  setHandlers(h: Pick<DebridManagerOptions, 'onSwitch' | 'onHealth'>): void { this.handlers = h; }

  // ----- Réglages -----

  settings(): DebridSettings { return readSettings(this.store); }

  setKey(id: ProviderId, key: string): void {
    const s = this.settings();
    const trimmed = key.trim();
    if (trimmed) s.keys[id] = trimmed; else delete s.keys[id];
    writeSettings(this.store, s);
    this.providers.delete(id);
    // Nouvelle clé : l'état d'indisponibilité précédent ne vaut plus.
    delete this.health[id];
    this.saveHealth();
  }

  setOrder(order: readonly ProviderId[]): void {
    const s = this.settings();
    s.order = normalizeOrder(order);
    writeSettings(this.store, s);
  }

  hasKey(id: ProviderId): boolean { return !!this.settings().keys[id]; }

  /** Au moins un fournisseur configuré (clé saisie) sur un support qui sait l'appeler. */
  hasAny(): boolean { return this.configured().length > 0; }

  private native(): NativeKind { return (this.o.native ?? nativeKind)(); }

  /** Fournisseurs avec clé, dans l'ordre de priorité, utilisables sur ce support. */
  configured(): ProviderId[] {
    const s = this.settings();
    return s.order.filter((id) => !!s.keys[id] && !webBlocked(NEEDS_NATIVE[id], this.native()));
  }

  /** Fournisseurs configurés et non marqués indisponibles, dans l'ordre de priorité. */
  available(): ProviderId[] {
    const at = this.now();
    return this.configured().filter((id) => {
      const h = this.health[id];
      return !(h && h.state !== 'ok' && h.until !== undefined && h.until > at);
    });
  }

  healthOf(id: ProviderId): ProviderHealth | undefined { return this.health[id]; }

  /** Raison pour laquelle un fournisseur n'est pas utilisé ici (web sans pont, pas de clé…), pour l'affichage. */
  blockedReason(id: ProviderId): 'no_key' | 'web_unsupported' | null {
    if (!this.hasKey(id)) return 'no_key';
    return webBlocked(NEEDS_NATIVE[id], this.native()) ? 'web_unsupported' : null;
  }

  private saveHealth(): void {
    try { this.store.setItem(STATE_KEY, JSON.stringify(this.health)); } catch { /* stockage indisponible */ }
  }

  private mark(id: ProviderId, h: Omit<ProviderHealth, 'at'>): void {
    const entry = { ...h, at: this.now() };
    this.health[id] = entry;
    this.saveHealth();
    (this.handlers.onHealth ?? this.o.onHealth)?.(id, entry);
  }

  private provider(id: ProviderId): DebridProvider {
    const key = this.settings().keys[id];
    if (!key) throw new DebridError('no_key', 'account', { state: 'invalid_key' });
    const cacheKey = id;
    let p = this.providers.get(cacheKey);
    if (!p) {
      p = this.o.makeProvider ? this.o.makeProvider(id, key) : defaultProvider(id, key);
      this.providers.set(cacheKey, p);
    }
    return p;
  }

  /** Vérifie un fournisseur (un appel) et enregistre son état ; à n'appeler que sur demande de l'utilisateur. */
  async refreshStatus(id: ProviderId, signal?: AbortSignal): Promise<ProviderStatus> {
    if (webBlocked(NEEDS_NATIVE[id], this.native())) {
      const st: ProviderStatus = { state: 'unsupported', detail: 'web_unsupported' };
      this.mark(id, st);
      return st;
    }
    const st = await this.provider(id).status(signal);
    if (st.state === 'ok') this.mark(id, { state: 'ok' });
    else this.mark(id, { state: st.state, detail: st.detail, until: st.until ?? (st.state === 'unreachable' ? this.now() + 60_000 : this.now() + 6 * 3600_000) });
    return st;
  }

  private onAccountError(id: ProviderId, err: DebridError): void {
    this.mark(id, { state: err.state ?? 'unreachable', detail: err.code, until: err.until ?? this.now() + 3600_000 });
    this.providers.delete(id);
  }

  // ----- Cache combiné -----

  private key = (id: ProviderId, hash: string): string => `${id}:${hash}`;

  private async known(id: ProviderId, hash: string): Promise<boolean | undefined> {
    const e = await this.statuses.get(this.key(id, hash));
    if (!e) return undefined;
    const ttl = e.cached ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    return this.now() - e.at < ttl ? e.cached : undefined;
  }

  /** Verdict combiné lu dans le cache local, sans aucun appel réseau. */
  async cachedVerdicts(hashes: readonly string[]): Promise<Map<string, CacheVerdict>> {
    const out = new Map<string, CacheVerdict>();
    const ids = this.available();
    for (const raw of hashes) {
      const hash = normalizeHash(raw);
      if (hash === null) continue;
      const by: ProviderId[] = [];
      let anyFalse = false;
      for (const id of ids) {
        const v = await this.known(id, hash);
        if (v === true) by.push(id); else if (v === false) anyFalse = true;
      }
      out.set(hash, { cached: by.length ? true : anyFalse ? false : undefined, by });
    }
    return out;
  }

  /**
   * Vérifie le cache des hashes inconnus chez chaque fournisseur disponible (les statuts connus ne sont pas redemandés), puis renvoie
   * le verdict combiné. Une erreur de compte marque le fournisseur indisponible et passe au suivant. Les hashes au-delà de
   * CHECK_TOP_N ne sont pas vérifiés. Ne lève pas.
   */
  async checkCache(hashes: readonly string[], signal?: AbortSignal): Promise<Map<string, CacheVerdict>> {
    const wanted = [...new Set(hashes.map(normalizeHash).filter((h): h is string => h !== null))].slice(0, CHECK_TOP_N);
    await Promise.all(this.available().map(async (id) => {
      const missing: string[] = [];
      for (const h of wanted) if ((await this.known(id, h)) === undefined) missing.push(h);
      if (missing.length === 0) return;
      const flightKey = `${id}:${missing.join(',')}`;
      const running = this.checks.get(flightKey);
      if (running) { await running; return; }
      const work = (async () => {
        try {
          const found = await this.provider(id).checkCache(missing, signal);
          const at = this.now();
          for (const [h, cached] of found) await this.statuses.set(this.key(id, h), { cached, at });
        } catch (err) {
          if (err instanceof DebridError && err.kind === 'account') this.onAccountError(id, err);
        }
      })();
      this.checks.set(flightKey, work);
      try { await work; } finally { this.checks.delete(flightKey); }
    }));
    return this.cachedVerdicts(wanted);
  }

  // ----- Résolution avec bascule -----

  /**
   * Lien partagé en échec de lecture : le serveur l'oublie pour ce compte, puis l'appareil le débloque lui-même (le partage n'est
   * pas relu) et republie le nouveau lien (`resolve`). Ne lève que comme `resolve`.
   */
  async recoverShared(copies: readonly ClientCopy[], episode: { season?: number; episode?: number } = {}, signal?: AbortSignal): Promise<ClientResolved> {
    await Promise.all(copies.slice(0, MAX_COPIES_TRIED).map((c) => {
      const key = sourceKeyFor(c);
      return key ? forgetSharedLink(key) : undefined;
    }));
    return this.resolve(copies, episode, signal, { skipShared: true });
  }

  /**
   * Lien de lecture pour une source (une ou plusieurs copies : hash + fichier). Ordre : fournisseurs qui l'ont en cache (priorité),
   * puis les autres disponibles. Erreur de compte : fournisseur marqué indisponible, essai du suivant ; `onSwitch` signale la bascule.
   * `skipShared` : débloque sur l'appareil sans lire le lien partagé ni le mémo (cas d'un lien partagé en échec).
   */
  async resolve(
    copies: readonly ClientCopy[],
    episode: { season?: number; episode?: number } = {},
    signal?: AbortSignal,
    options: { skipShared?: boolean } = {},
  ): Promise<ClientResolved> {
    const list = copies.filter((c) => normalizeHash(c.infoHash) !== null).slice(0, MAX_COPIES_TRIED + 2);
    if (list.length === 0) throw new DebridError('invalid_hash', 'content');
    const ids = this.available();
    if (ids.length === 0) throw new DebridError(this.configured().length ? 'all_unavailable' : 'no_provider', 'account');
    const memoKey = JSON.stringify([list.map((c) => [c.infoHash, c.fileIdx, c.filename, c.size]), episode]);
    const memo = this.resolved.get(memoKey);
    if (!options.skipShared && memo && this.now() - memo.at < RESOLVE_TTL_MS && memo.value.provider !== undefined && this.available().includes(memo.value.provider)) return memo.value;

    // Lien déjà débloqué par un autre appareil du compte : aucun débrideur n'est appelé ici.
    const shared = options.skipShared ? null : await sharedFor(list);
    if (shared) return shared;

    const verdicts = await this.cachedVerdicts(list.map((c) => c.infoHash));
    const cachedIn = (id: ProviderId, c: ClientCopy): boolean => verdicts.get(c.infoHash.toLowerCase())?.by.includes(id) === true;
    const withCache = ids.filter((id) => list.some((c) => cachedIn(id, c)));
    const order = [...withCache, ...ids.filter((id) => !withCache.includes(id))];

    let skipped: ProviderId | undefined;
    let lastErr: unknown = new DebridError('all_failed', 'content');
    for (const id of order) {
      const own = [...list.filter((c) => cachedIn(id, c)), ...list.filter((c) => !cachedIn(id, c))].slice(0, MAX_COPIES_TRIED);
      for (const copy of own) {
        try {
          const hint: FileHint = { fileIdx: copy.fileIdx, filename: copy.filename, size: copy.size, season: episode.season, episode: episode.episode };
          const link = await this.provider(id).resolve(copy.infoHash, hint, signal);
          // Partage avec les autres appareils du compte : publication sans attente, un échec n'a aucune conséquence.
          const sharedKey = sourceKeyFor(copy);
          if (sharedKey) void publishSharedLink(sharedKey, link.url);
          // Un fournisseur qui a servi un lien : sa disponibilité est confirmée, et le hash est « en cache » chez lui.
          if (this.health[id]) { delete this.health[id]; this.saveHealth(); }
          const value: ClientResolved = { ...link, provider: id, ...(skipped ? { switchedFrom: skipped } : {}) };
          if (skipped) (this.handlers.onSwitch ?? this.o.onSwitch)?.(skipped, id);
          this.resolved.set(memoKey, { at: this.now(), value });
          return value;
        } catch (err) {
          lastErr = err;
          if (!(err instanceof DebridError)) continue;
          if (err.code === 'aborted') throw err;
          if (err.kind === 'account') {
            this.onAccountError(id, err);
            skipped ??= id;
            break;
          }
          if (err.kind === 'transient' && err.retryAfterMs && err.retryAfterMs > 0) {
            this.mark(id, { state: 'quota', detail: err.code, until: this.now() + err.retryAfterMs });
            skipped ??= id;
            break;
          }
          if (err.kind === 'unsupported') { skipped ??= id; break; }
          // content / transient : copie suivante
        }
      }
    }
    throw lastErr;
  }

  resetCache(): Promise<void> { this.resolved.clear(); return this.statuses.clear(); }
}

/**
 * Lien partagé pour la première copie qui en a un (ordre des copies, 3 copies au plus). Sans clé de partage (pas d'index de
 * fichier), rien n'est demandé. Le nom et la taille viennent des indications de la copie : le partage ne les garde pas. Ne lève pas.
 */
async function sharedFor(list: readonly ClientCopy[]): Promise<ClientResolved | null> {
  const keyed = list.slice(0, MAX_COPIES_TRIED).flatMap((copy) => {
    const key = sourceKeyFor(copy);
    return key ? [{ copy, key }] : [];
  });
  if (keyed.length === 0) return null;
  const found = await Promise.all(keyed.map(({ key }) => getSharedLink(key)));
  const i = found.findIndex((link) => link !== null);
  const link = i >= 0 ? found[i] : null;
  if (!link) return null;
  const copy = keyed[i].copy;
  return { url: link.url, filename: copy.filename ?? '', size: copy.size ?? 0 };
}

function defaultProvider(id: ProviderId, apiKey: string): DebridProvider {
  switch (id) {
    case 'alldebrid': return createAllDebrid({ apiKey, http: createHttp('fetch-first') });
    case 'torbox': return createTorbox({ apiKey, http: createHttp('native-first') });
    default: return createRealDebrid({ apiKey, http: createHttp('native-first') });
  }
}

// ---------- Instance de l'application ----------

let shared: DebridManager | null = null;

export function debrid(): DebridManager {
  shared ??= new DebridManager();
  return shared;
}



