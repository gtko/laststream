/* Aperçu sur la barre avec mpv : les images (WebP, une toutes les 30 s) sont générées par ffmpeg côté lastAddon.
 * Ici : arrondi à la tranche, précharge autour du curseur, annulation des demandes périmées, cache d'URL d'images.
 * Logique pure, dépendances injectées (fetch, création d'URL d'objet), testée. */

const SLICE_SECONDS = 30;
/** Images gardées en mémoire (≈ 3 Ko chacune). */
export const FEED_CACHE = 60;
/** Tranches préchargées de part et d'autre du curseur. */
const PRELOAD_RADIUS = 2;
/** Requêtes en vol au plus (le navigateur n'en traite qu'environ six par hôte). */
export const MAX_PARALLEL = 3;
/** Délai avant de redemander une image que le serveur n'a pas encore finie (réponse 202). */
const PENDING_RETRY_MS = 1200;
const MAX_PENDING_RETRIES = 5;
/** Échecs consécutifs après lesquels on renonce aux aperçus pour la source courante. */
export const MAX_FEED_FAILURES = 5;

/** Tranche de 30 s la plus proche de l'instant survolé, bornée à la durée connue. */
export function sliceIndex(time: number, duration: number): number {
  const last = duration > 0 ? Math.floor(duration / SLICE_SECONDS) : 0;
  const index = Math.round(Math.max(0, time) / SLICE_SECONDS);
  return Math.min(Math.max(0, index), last);
}

/** Tranches à charger : la courante, puis alternativement vers l'avant et vers l'arrière, dans [0, last]. */
export function wantedSlices(index: number, last: number, radius = PRELOAD_RADIUS): number[] {
  const out = [index];
  for (let d = 1; d <= radius; d += 1) {
    if (index + d <= last) out.push(index + d);
    if (index - d >= 0) out.push(index - d);
  }
  return out;
}

/** Capacité annoncée par GET /lt/health : le serveur sait-il générer des miniatures ? (option masquée sinon) */
export function serverHasThumbs(health: unknown): boolean {
  const caps = (health as { capabilities?: { thumbs?: unknown } } | null | undefined)?.capabilities;
  return caps?.thumbs === true;
}

export interface FeedDeps {
  /** Enregistre la source courante auprès du serveur ; renvoie la clé, ou null si elle est refusée. */
  register(signal: AbortSignal): Promise<string | null>;
  /** URL absolue d'une image. */
  imageUrl(key: string, index: number): string;
  fetchFn(url: string, init: { signal: AbortSignal }): Promise<Pick<Response, 'status' | 'blob' | 'json'>>;
  makeUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** Requêtes en vol au plus (défaut MAX_PARALLEL). */
  maxParallel?: number;
  /** Une image vient d'arriver (tranche, URL d'objet). */
  onReady(index: number, url: string): void;
}

export class ThumbFeed {
  private key: string | null = null;
  private registering: Promise<string | null> | null = null;
  private readonly images = new Map<number, string>();
  private readonly loading = new Map<number, AbortController>();
  private readonly missing = new Set<number>();
  private target = -1;
  private last = 0;
  private failures = 0;
  private reregistered = false;
  private registerController: AbortController | null = null;
  dead = false;

  constructor(private readonly deps: FeedDeps) {}

  /** Image prête pour la tranche (URL d'objet), sinon null : l'appelant n'affiche alors rien. */
  imageFor(index: number): string | null {
    const url = this.images.get(index);
    if (url === undefined) return null;
    this.images.delete(index);
    this.images.set(index, url);
    return url;
  }

  get targetIndex(): number { return this.target; }
  get inFlight(): number { return this.loading.size; }

  /**
   * Le pointeur est à `time` : renvoie l'image de la tranche (si prête) et lance le chargement de la tranche et de ses voisines.
   * Les demandes qui sortent de la fenêtre sont annulées.
   */
  request(time: number, duration: number): string | null {
    if (this.dead || !(duration > 0)) return null;
    this.last = Math.floor(duration / SLICE_SECONDS);
    this.target = sliceIndex(time, duration);
    const wanted = new Set(wantedSlices(this.target, this.last));
    for (const [index, ctl] of this.loading) {
      if (!wanted.has(index)) {
        ctl.abort();
        this.loading.delete(index);
      }
    }
    this.pump();
    return this.imageFor(this.target);
  }

  /** Le pointeur a quitté la barre : plus rien n'est attendu. */
  cancel(): void {
    this.target = -1;
    for (const ctl of this.loading.values()) ctl.abort();
    this.loading.clear();
  }

  /** Nouvelle source : on repart de zéro. */
  reset(): void {
    this.cancel();
    this.registerController?.abort();
    this.registerController = null;
    this.registering = null;
    this.key = null;
    for (const url of this.images.values()) this.deps.revokeUrl(url);
    this.images.clear();
    this.missing.clear();
    this.failures = 0;
    this.reregistered = false;
    this.dead = false;
  }

  private pump(): void {
    if (this.dead || this.target < 0) return;
    for (const index of wantedSlices(this.target, this.last)) {
      if (this.loading.size >= (this.deps.maxParallel ?? MAX_PARALLEL)) return;
      if (this.images.has(index) || this.loading.has(index) || this.missing.has(index)) continue;
      void this.load(index);
    }
  }

  private ensureKey(): Promise<string | null> {
    if (this.key !== null) return Promise.resolve(this.key);
    if (this.registering === null) {
      const ctl = new AbortController();
      this.registerController = ctl;
      const pending = this.deps.register(ctl.signal).then(
        (key) => key,
        () => null,
      );
      this.registering = pending;
      void pending.then((key) => {
        if (this.registering !== pending) return;
        this.registering = null;
        this.key = key;
        if (key === null) this.die();
      });
    }
    return this.registering;
  }

  private die(): void {
    this.dead = true;
    this.cancel();
  }

  private store(index: number, url: string): void {
    const old = this.images.get(index);
    if (old !== undefined) this.deps.revokeUrl(old);
    this.images.set(index, url);
    while (this.images.size > FEED_CACHE) {
      const oldest = this.images.keys().next().value as number;
      this.deps.revokeUrl(this.images.get(oldest) as string);
      this.images.delete(oldest);
    }
  }

  private async load(index: number): Promise<void> {
    const ctl = new AbortController();
    this.loading.set(index, ctl);
    const { signal } = ctl;
    try {
      for (let attempt = 0; attempt <= MAX_PENDING_RETRIES; attempt += 1) {
        const key = await this.ensureKey();
        if (signal.aborted || key === null) return;
        const res = await this.deps.fetchFn(this.deps.imageUrl(key, index), { signal });
        if (signal.aborted) return;
        if (res.status === 200) {
          const url = this.deps.makeUrl(await res.blob());
          if (signal.aborted) { this.deps.revokeUrl(url); return; }
          this.failures = 0;
          this.store(index, url);
          this.deps.onReady(index, url);
          return;
        }
        if (res.status === 202) {
          await this.deps.wait(PENDING_RETRY_MS, signal);
          if (signal.aborted) return;
          continue;
        }
        if (res.status === 404) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          if (body?.error === 'unknown_source' && !this.reregistered) {
            // Le serveur a oublié la source (redémarrage, inactivité) : on la réenregistre une fois.
            this.reregistered = true;
            this.key = null;
            this.registering = null;
            continue;
          }
          this.missing.add(index);
          return;
        }
        this.fail();
        return;
      }
    } catch {
      if (!signal.aborted) this.fail();
    } finally {
      if (this.loading.get(index) === ctl) this.loading.delete(index);
      if (!signal.aborted) this.pump();
    }
  }

  private fail(): void {
    this.failures += 1;
    if (this.failures >= MAX_FEED_FAILURES) this.die();
  }
}
