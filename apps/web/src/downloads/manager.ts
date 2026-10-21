/* Gestionnaire des téléchargements hors ligne (ODY-198) : file, concurrence, reprise, re-résolution du lien, quota.
 *
 * Ne parle à aucun serveur Laststream : le réseau passe par `http` injecté, le stockage par `store`, l'index par `index`.
 * Un lien débridé n'existe qu'en mémoire (`links`) : jamais persisté, jamais dans une erreur, jamais dans le journal (`onLog`).
 * Pas d'import de src/data ni du gestionnaire de débrideurs : une `DebridError` est reconnue à son champ `kind`. */
import { transition } from './state';
import { fetchChunks } from './transfer';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONCURRENCY,
  DownloadError,
  MAX_NETWORK_RETRIES,
  MAX_RESOLVES,
  WARN_RATIO,
  downloadId,
  type DownloadErrorCode,
  type DownloadIndex,
  type DownloadItem,
  type DownloadSink,
  type DownloadSource,
  type DownloadStore,
  type EnqueueRequest,
  type HttpFn,
  type LinkResolver,
  type ResolvedFile,
  type SpaceInfo,
  type TransferProgress,
} from './types';

export interface DownloadManagerOptions {
  resolver: LinkResolver;
  http: HttpFn;
  store: DownloadStore;
  index: DownloadIndex;
  now?: () => number;
  concurrency?: number;
  chunkSize?: number;
  /** Re-résolutions de lien autorisées par session après un lien périmé. */
  maxResolves?: number;
  /** Nouvelles tentatives réseau consécutives avant `error` `network`. */
  maxNetworkRetries?: number;
  /** Limite d'espace choisie par l'utilisateur (octets) ; null ou absent : pas de limite. */
  limitBytes?: number | null;
  /** Attente entre deux tentatives (injectable) ; se termine dès que le signal est interrompu. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Journal sans donnée sensible : nom de l'événement et codes ou compteurs seulement. */
  onLog?: (event: string, data?: Record<string, string | number>) => void;
}

export type DownloadListener = (items: readonly DownloadItem[]) => void;

/** Une session : une exécution d'un téléchargement, du démarrage à la fin, à la pause ou à la suppression. */
interface Session {
  controller: AbortController;
  /** Re-résolutions déclenchées par un lien périmé ; remises à zéro dès qu'un morceau réussit. */
  reresolves: number;
  /** La limite d'espace a été atteinte pendant une écriture. */
  quota: boolean;
  /** Une erreur vient du stockage (ouverture, écriture, lecture de taille, finalisation). */
  storeFailed: boolean;
  /** Se résout quand la session est terminée (jamais en rejet). */
  done: Promise<void>;
}

/** Lien débridé en mémoire et l'ETag que ce lien a renvoyé : une nouvelle résolution repart sans validateur. */
interface HeldLink {
  file: ResolvedFile;
  /** ETag renvoyé par ce lien seulement (jamais celui d'un ancien lien, jamais persisté). */
  etag?: string;
}

const MAX_BACKOFF_MS = 60_000;
const DEBRID_KINDS = ['account', 'content', 'transient', 'unsupported'] as const;
type DebridKind = (typeof DEBRID_KINDS)[number];

const sanitizeConcurrency = (n: number): number => (Number.isFinite(n) ? Math.max(1, Math.floor(n)) : DEFAULT_CONCURRENCY);
const sanitizeLimit = (bytes: number | null): number | null => (bytes === null || !Number.isFinite(bytes) ? null : Math.max(0, bytes));

/** Nature d'une `DebridError` (champ `kind`), sans importer le module du débrideur. */
function debridKind(err: unknown): DebridKind | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === 'string' && (DEBRID_KINDS as readonly string[]).includes(kind) ? (kind as DebridKind) : undefined;
}

/** Code d'erreur d'une résolution de lien qui n'est pas transitoire. */
function resolveErrorCode(err: unknown): DownloadErrorCode {
  const kind = debridKind(err);
  if (kind === 'account') return 'account';
  if (kind === 'content' || kind === 'unsupported') return 'content';
  return 'resolve_failed';
}

/** Code d'une erreur du stockage. */
function storeErrorCode(err: unknown): DownloadErrorCode {
  return err instanceof DownloadError && (err.code === 'store_full' || err.code === 'store_failed') ? err.code : 'store_failed';
}

/** Attente réelle : se termine à l'échéance ou dès l'interruption, sans laisser d'écouteur sur le signal. */
const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const copySource = (src: DownloadSource): DownloadSource => ({ ...src, copies: src.copies.map((c) => ({ ...c })) });

export class DownloadManager {
  private readonly resolver: LinkResolver;
  private readonly http: HttpFn;
  private readonly store: DownloadStore;
  private readonly index: DownloadIndex;
  private readonly now: () => number;
  private readonly chunkSize: number;
  private readonly maxResolves: number;
  private readonly maxNetworkRetries: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly onLog: DownloadManagerOptions['onLog'];
  private concurrency: number;
  private limitBytes: number | null;

  private readonly items = new Map<string, DownloadItem>();
  /** Liens débridés en mémoire seulement, chacun avec l'ETag qu'il a renvoyé. */
  private readonly links = new Map<string, HeldLink>();
  private readonly sessions = new Map<string, Session>();
  /** Suppressions en cours : un enqueue du même identifiant attend leur fin avant de créer un nouvel item. */
  private readonly removing = new Map<string, Promise<void>>();
  /** Octets occupés (cache) : relus au démarrage de chaque session, à l'ajout, à `space()` et après une suppression ; tenus à jour à chaque écriture. */
  private used = 0;
  private readonly listeners = new Set<DownloadListener>();
  private notifyQueued = false;
  /** Vrai une fois l'index rechargé : rien ne démarre avant. */
  private ready = false;
  private initialized: Promise<void> | null = null;

  constructor(opts: DownloadManagerOptions) {
    this.resolver = opts.resolver;
    this.http = opts.http;
    this.store = opts.store;
    this.index = opts.index;
    this.now = opts.now ?? (() => Date.now());
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.maxResolves = opts.maxResolves ?? MAX_RESOLVES;
    this.maxNetworkRetries = opts.maxNetworkRetries ?? MAX_NETWORK_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onLog = opts.onLog;
    this.concurrency = sanitizeConcurrency(opts.concurrency ?? DEFAULT_CONCURRENCY);
    this.limitBytes = sanitizeLimit(opts.limitBytes ?? null);
  }

  /** Recharge l'index : un téléchargement `running` repasse `pending`, son avancement est relu dans le magasin, puis l'ordonnanceur part. */
  init(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    let stored: DownloadItem[] = [];
    try {
      stored = await this.index.all();
    } catch {
      this.log('index_failed');
    }
    for (const saved of stored) {
      if (this.items.has(saved.id)) continue;
      let item = saved;
      if (item.state === 'running') item = transition(item, 'pending', {}, this.now());
      const size = await this.storedSize(item.id);
      if (size !== undefined && size !== item.bytesDone) item = { ...item, bytesDone: size };
      this.items.set(item.id, item);
      if (item !== saved) this.persist(item);
    }
    this.ready = true;
    this.notify();
    this.schedule();
  }

  /** Taille déjà écrite pour `id`, lue sans ouvrir de sink ; undefined si le magasin ne répond pas. */
  private async storedSize(id: string): Promise<number | undefined> {
    try {
      return await this.store.size(id);
    } catch {
      return undefined;
    }
  }

  /** Ajoute un téléchargement. Idempotent : un identifiant déjà présent renvoie l'item existant, sans contrôle de quota. */
  async enqueue(req: EnqueueRequest): Promise<DownloadItem> {
    const [item] = await this.enqueueMany([req]);
    return item;
  }

  /** Ajoute plusieurs téléchargements avec un seul contrôle de quota, sur la somme des tailles estimées. */
  async enqueueMany(reqs: readonly EnqueueRequest[]): Promise<DownloadItem[]> {
    // Un identifiant en cours de suppression ne reçoit un nouvel item qu'une fois tous ses nettoyages terminés.
    let pending = this.removalOf(reqs);
    while (pending) {
      await pending;
      pending = this.removalOf(reqs);
    }
    const fresh = new Map<string, EnqueueRequest>();
    for (const req of reqs) {
      const id = downloadId(req.metaId, req.season, req.episode);
      if (!this.items.has(id) && !fresh.has(id)) fresh.set(id, req);
    }
    if (fresh.size > 0 && this.limitBytes !== null) {
      const incoming = [...fresh.values()].reduce((sum, r) => sum + (r.estimatedSize ?? 0), 0);
      const used = await this.refreshUsed();
      if (this.limitBytes !== null && used + incoming > this.limitBytes) throw new DownloadError('quota_exceeded', false);
    }
    const now = this.now();
    const out: DownloadItem[] = [];
    for (const req of reqs) {
      const id = downloadId(req.metaId, req.season, req.episode);
      const existing = this.items.get(id);
      if (existing) { out.push(existing); continue; }
      const item: DownloadItem = {
        id,
        metaId: req.metaId,
        title: req.title,
        ...(req.season !== undefined ? { season: req.season } : {}),
        ...(req.episode !== undefined ? { episode: req.episode } : {}),
        source: copySource(req.source),
        state: 'pending',
        bytesDone: 0,
        ...(req.estimatedSize !== undefined ? { estimatedSize: req.estimatedSize } : {}),
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.put(item);
      out.push(item);
    }
    this.schedule();
    return out;
  }

  /** Suppression en cours pour l'un des identifiants demandés, si elle existe. */
  private removalOf(reqs: readonly EnqueueRequest[]): Promise<void> | undefined {
    for (const r of reqs) {
      const p = this.removing.get(downloadId(r.metaId, r.season, r.episode));
      if (p) return p;
    }
    return undefined;
  }

  /** Met en pause. Un téléchargement en cours est interrompu : son morceau en cours est jeté, la reprise repart de la taille du fichier. */
  pause(id: string): void {
    const cur = this.items.get(id);
    if (!cur || (cur.state !== 'pending' && cur.state !== 'running')) return;
    this.put(transition(cur, 'paused', {}, this.now()));
    this.sessions.get(id)?.controller.abort();
  }

  /** Reprend un téléchargement en pause. */
  resume(id: string): void {
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'paused') return;
    this.put(transition(cur, 'pending', {}, this.now()));
    this.schedule();
  }

  /** Relance un téléchargement en erreur, avec ses tentatives remises à zéro. */
  retry(id: string): void {
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'error') return;
    this.put(transition(cur, 'pending', { attempts: 0 }, this.now()));
    this.schedule();
  }

  /** Supprime un téléchargement quel que soit son état : interrompt la session, attend sa fin, puis efface fichier et index. */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    session?.controller.abort();
    this.items.delete(id);
    this.links.delete(id);
    this.notify();
    const cleanup = (async (): Promise<void> => {
      if (session) await session.done;
      try {
        await this.store.remove(id);
      } catch {
        this.log('store_failed');
      }
      await this.refreshUsed();
      try {
        await this.index.delete(id);
      } catch {
        this.log('index_failed');
      }
    })();
    this.removing.set(id, cleanup);
    await cleanup;
    if (this.removing.get(id) === cleanup) this.removing.delete(id);
  }

  pauseAll(): void {
    for (const item of this.list()) {
      if (item.state === 'pending' || item.state === 'running') this.pause(item.id);
    }
  }

  resumeAll(): void {
    for (const item of this.list()) {
      if (item.state === 'paused') this.resume(item.id);
    }
  }

  /** File complète, triée par date de création. */
  list(): readonly DownloadItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  get(id: string): DownloadItem | undefined {
    return this.items.get(id);
  }

  /** Notifie les abonnés (en microtâche, regroupé) à chaque changement. Renvoie la fonction de désabonnement. */
  subscribe(fn: DownloadListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Espace occupé par les téléchargements, et situation par rapport à la limite choisie. */
  async space(): Promise<SpaceInfo> {
    const used = await this.refreshUsed();
    const limit = this.limitBytes;
    const ratio = limit === null ? null : limit > 0 ? used / limit : 1;
    return { used, limit, ratio, warn: ratio !== null && ratio >= WARN_RATIO, full: ratio !== null && ratio >= 1 };
  }

  setLimit(bytes: number | null): void {
    this.limitBytes = sanitizeLimit(bytes);
  }

  setConcurrency(n: number): void {
    this.concurrency = sanitizeConcurrency(n);
    this.schedule();
  }

  // ---------- Ordonnancement ----------

  /** Lance les `pending` les plus anciens tant que la concurrence le permet. Une session encore vivante, ou une suppression en cours, bloque son identifiant. */
  private schedule(): void {
    if (!this.ready) return;
    for (const item of this.list()) {
      if (item.state !== 'pending') continue;
      if (this.sessions.size >= this.concurrency) return;
      if (this.sessions.has(item.id) || this.removing.has(item.id)) continue;
      this.start(item);
    }
  }

  private start(item: DownloadItem): void {
    const session: Session = { controller: new AbortController(), reresolves: 0, quota: false, storeFailed: false, done: Promise.resolve() };
    this.put(transition(item, 'running', {}, this.now()));
    this.sessions.set(item.id, session);
    session.done = this.run(item.id, session)
      .catch(() => {
        this.log('unexpected');
        this.fail(item.id, session, 'store_failed');
      })
      .finally(() => {
        if (this.sessions.get(item.id) === session) this.sessions.delete(item.id);
        this.schedule();
      });
  }

  /** Boucle d'une session : résolution, ouverture du magasin, transfert ; relance après re-résolution ou attente réseau. Le handle du magasin est fermé à la sortie, quelle qu'elle soit. */
  private async run(id: string, s: Session): Promise<void> {
    const { signal } = s.controller;
    let raw: DownloadSink | null = null;
    try {
      await this.refreshUsed();
      let sink: DownloadSink | null = null;
      for (;;) {
        if (signal.aborted || !this.items.has(id)) return;

        let held = this.links.get(id);
        if (!held) {
          const got = await this.obtainLink(id, s);
          if (!got || signal.aborted) return;
          held = { file: got };
          this.links.set(id, held);
        }
        const link = held;

        if (!raw || !sink) {
          try {
            raw = await this.store.open(id);
          } catch (err) {
            if (!signal.aborted) this.fail(id, s, storeErrorCode(err));
            return;
          }
          if (signal.aborted) return;
          sink = this.guard(raw, s);
        }

        const item = this.items.get(id);
        if (!item) return;
        try {
          const res = await fetchChunks({
            http: this.http,
            sink,
            url: link.file.url,
            chunkSize: this.chunkSize,
            bytesTotal: item.bytesTotal,
            etag: link.etag,
            signal,
            onProgress: (p) => {
              link.etag = p.etag;
              this.progress(id, s, p, link.file);
            },
          });
          if (signal.aborted) return;
          try {
            await raw.finalize();
          } catch (err) {
            if (!signal.aborted) this.fail(id, s, storeErrorCode(err));
            return;
          }
          if (signal.aborted) return;
          this.complete(id, res);
          return;
        } catch (err) {
          if (s.quota) {
            if (!signal.aborted) this.pauseForQuota(id);
            return;
          }
          if (signal.aborted) return;
          if (err instanceof DownloadError) {
            if (err.code === 'link_expired') {
              this.links.delete(id);
              this.log('link_expired', { reresolves: s.reresolves });
              if (s.reresolves >= this.maxResolves) { this.fail(id, s, 'link_expired'); return; }
              s.reresolves += 1;
              continue;
            }
            if (err.code === 'network') {
              if (await this.backoff(id, s)) continue;
              this.fail(id, s, 'network');
              return;
            }
            this.fail(id, s, err.code);
            return;
          }
          this.fail(id, s, s.storeFailed ? 'store_failed' : 'network');
          return;
        }
      }
    } finally {
      await this.closeSink(raw);
    }
  }

  /** Ferme le handle du magasin ; un échec est journalisé sans interrompre le gestionnaire. */
  private async closeSink(raw: DownloadSink | null): Promise<void> {
    if (!raw) return;
    try {
      await raw.close();
    } catch {
      this.log('store_failed');
    }
  }

  /** Obtient un lien par le résolveur, avec attente en cas d'erreur transitoire. Null : la session s'arrête (erreur ou interruption). */
  private async obtainLink(id: string, s: Session): Promise<ResolvedFile | null> {
    const { signal } = s.controller;
    for (;;) {
      const item = this.items.get(id);
      if (!item || signal.aborted) return null;
      try {
        const link = await this.resolver.resolve(item.source, signal);
        return signal.aborted ? null : link;
      } catch (err) {
        if (signal.aborted) return null;
        const transient = debridKind(err) === 'transient' || (err instanceof DownloadError && err.retryable);
        if (transient && (await this.backoff(id, s))) continue;
        this.log('resolve_failed');
        this.fail(id, s, transient ? 'resolve_failed' : resolveErrorCode(err));
        return null;
      }
    }
  }

  /** Attend avant une nouvelle tentative (2 s, 4 s, … plafonné à 60 s). False : tentatives épuisées ou session interrompue. */
  private async backoff(id: string, s: Session): Promise<boolean> {
    const cur = this.items.get(id);
    if (!cur) return false;
    const attempts = cur.attempts + 1;
    if (attempts > this.maxNetworkRetries) return false;
    this.put({ ...cur, attempts, updatedAt: this.now() });
    this.log('retry', { attempts });
    await this.sleep(Math.min(MAX_BACKOFF_MS, 2 ** attempts * 1000), s.controller.signal);
    return !s.controller.signal.aborted;
  }

  /** Sink surveillé : contrôle du quota avant chaque écriture (sur le cache d'espace occupé), erreurs du stockage marquées pour le diagnostic. */
  private guard(raw: DownloadSink, s: Session): DownloadSink {
    const storage = async <T>(op: () => Promise<T>): Promise<T> => {
      try {
        return await op();
      } catch (err) {
        s.storeFailed = true;
        throw err;
      }
    };
    return {
      size: () => storage(() => raw.size()),
      write: async (offset, chunk) => {
        if (this.limitBytes !== null && this.used + chunk.byteLength > this.limitBytes) {
          s.quota = true;
          throw new DownloadError('quota_exceeded', false);
        }
        await storage(() => raw.write(offset, chunk));
        this.used += chunk.byteLength;
      },
      truncate: async (len) => {
        const before = await storage(() => raw.size());
        await storage(() => raw.truncate(len));
        this.used = Math.max(0, this.used - Math.max(0, before - len));
      },
      finalize: () => storage(() => raw.finalize()),
      close: () => raw.close(),
    };
  }

  /** Avancement après un morceau réussi : taille, validateurs tels que renvoyés par ce lien, remise à zéro des tentatives et des re-résolutions. */
  private progress(id: string, s: Session, p: TransferProgress, file: ResolvedFile): void {
    s.reresolves = 0;
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'running' || s.controller.signal.aborted) return;
    this.put({
      ...cur,
      bytesDone: p.bytesDone,
      bytesTotal: p.bytesTotal,
      etag: p.etag,
      lastModified: p.lastModified,
      filename: cur.filename ?? file.filename,
      attempts: 0,
      updatedAt: this.now(),
    });
  }

  private complete(id: string, res: TransferProgress): void {
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'running') return;
    this.links.delete(id);
    this.put(transition(cur, 'done', {
      bytesDone: res.bytesDone,
      bytesTotal: res.bytesTotal,
      etag: res.etag,
      lastModified: res.lastModified,
      attempts: 0,
    }, this.now()));
  }

  private fail(id: string, s: Session, code: DownloadErrorCode): void {
    if (s.controller.signal.aborted) return;
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'running') return;
    this.links.delete(id);
    this.log('failed', { code });
    this.put(transition(cur, 'error', { error: { code } }, this.now()));
  }

  private pauseForQuota(id: string): void {
    const cur = this.items.get(id);
    if (!cur || cur.state !== 'running') return;
    this.log('quota_exceeded');
    this.put(transition(cur, 'paused', { error: { code: 'quota_exceeded' } }, this.now()));
  }

  // ---------- Espace, état et notifications ----------

  /** Relit l'espace occupé dans le magasin et met le cache à jour ; 0 si le magasin ne répond pas (le repli évite de bloquer l'interface). */
  private async refreshUsed(): Promise<number> {
    try {
      this.used = (await this.store.usage()).used;
    } catch {
      this.log('store_failed');
      this.used = 0;
    }
    return this.used;
  }

  private put(item: DownloadItem): void {
    this.items.set(item.id, item);
    this.persist(item);
    this.notify();
  }

  /** Écriture d'index sans attente : un échec est journalisé, jamais propagé. */
  private persist(item: DownloadItem): void {
    try {
      this.index.put(item).catch(() => this.log('index_failed'));
    } catch {
      this.log('index_failed');
    }
  }

  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      const snapshot = this.list();
      for (const fn of [...this.listeners]) {
        try {
          fn(snapshot);
        } catch {
          this.log('listener_failed');
        }
      }
    });
  }

  private log(event: string, data?: Record<string, string | number>): void {
    try {
      this.onLog?.(event, data);
    } catch {
      /* le journal ne doit pas interrompre un téléchargement */
    }
  }
}
