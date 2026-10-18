import { type EnvLike, runtimeEnv } from '../../platform/index.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type IssuedUrls, issuedUrls } from '../../play/issued.js';
import { userDbPath } from '../../platform/node/user-db.js';
import { runProcess, type RunResult } from '../detect/proc.js';
import { ByteBudget, openSource, type SourceProxy } from '../detect/proxy.js';
import { defaultLocalPolicy, type LocalUrlPolicy } from '../detect/media-url.js';
import { DEFAULT_CACHE_BYTES, ThumbCache } from './cache.js';
import { resolveThumbSource } from './source.js';
import { ffmpegArgs, generationOrder, sliceCount, sliceTime, SLICE_SECONDS } from './slices.js';

export type Runner = (command: string, args: readonly string[], options: { timeoutMs: number; maxStdout: number }) => Promise<RunResult>;

export interface ThumbOptions {
  /** Chemin de ffmpeg. Absent : LASTADDON_FFMPEG. `null` : fonctionnalité désactivée. */
  ffmpeg?: string | null;
  /** Dossier du cache. Absent : <LASTADDON_DATA_DIR>/thumbs. */
  cacheDir?: string;
  maxCacheBytes?: number;
  /** Registre des URL émises. Absent : celui du processus. */
  issued?: IssuedUrls;
  /** Origines locales supplémentaires (tests) ; la règle par défaut (serveur de streaming local) reste en vigueur. */
  allowLocal?: LocalUrlPolicy;
  /** Processus ffmpeg simultanés au total (1 à 2). */
  concurrency?: number;
  /** Délai par image (ms). */
  timeoutMs?: number;
  /** Inactivité après laquelle une source est abandonnée (ms). */
  idleMs?: number;
  now?: () => number;
  run?: Runner;
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_IDLE_MS = 2 * 60e3;
export const MAX_SOURCES = 8;
/** Octets maximaux lus en amont pour une source (toutes images confondues). */
const SOURCE_BYTE_BUDGET = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 2;
const WANTED_MAX = 8;
const WANTED_MAX_AGE_MS = 20e3;
const MAX_DURATION = 24 * 3600;

interface Source {
  key: string;
  target: URL;
  duration: number | undefined;
  count: number;
  center: number;
  wanted: { index: number; at: number }[];
  done: Set<number>;
  attempts: Map<number, number>;
  failed: Set<number>;
  inflight: Set<number>;
  lastAccess: number;
  proxy: Promise<SourceProxy> | undefined;
  budget: ByteBudget;
}

export type FrameResult =
  | { status: 'ok'; data: Buffer }
  | { status: 'unknown' }
  | { status: 'missing' }
  | { status: 'pending' };

export interface Registration {
  key: string;
  interval: number;
  count: number;
}

/** Fichier WebP : « RIFF » .... « WEBP ». */
export function isWebp(data: Buffer): boolean {
  return data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP';
}

export function ffmpegFromEnv(env: EnvLike = runtimeEnv().all()): string | null {
  const path = env.LASTADDON_FFMPEG?.trim();
  return path !== undefined && path !== '' && existsSync(path) ? path : null;
}

/**
 * Miniatures de la barre de progression : une image WebP toutes les 30 s, générée par ffmpeg en arrière-plan (1 à 2
 * processus au total), mise en cache sur disque. ffmpeg ne lit jamais une URL distante directement : il lit un relais
 * local (redirections et adresses contrôlées, octets comptés) alimenté par une source préalablement autorisée.
 */
export class ThumbService {
  readonly ffmpeg: string | null;
  private readonly cache: ThumbCache;
  private readonly issued: IssuedUrls;
  private readonly extraLocal: LocalUrlPolicy | undefined;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly run: Runner;
  private readonly sources = new Map<string, Source>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private running = 0;
  private closed = false;
  private readonly sweeper: NodeJS.Timeout;

  constructor(options: ThumbOptions = {}) {
    this.ffmpeg = options.ffmpeg === undefined ? ffmpegFromEnv() : options.ffmpeg;
    this.cache = new ThumbCache(options.cacheDir ?? join(dirname(userDbPath()), 'thumbs'), options.maxCacheBytes ?? DEFAULT_CACHE_BYTES);
    this.issued = options.issued ?? issuedUrls;
    this.extraLocal = options.allowLocal;
    this.concurrency = Math.min(2, Math.max(1, options.concurrency ?? 2));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.run = options.run ?? runProcess;
    this.sweeper = setInterval(() => void this.sweep(), 15e3);
    this.sweeper.unref();
  }

  get enabled(): boolean {
    return this.ffmpeg !== null;
  }

  /** Enregistre une source (si autorisée) et renvoie sa clé ; null si elle est refusée. */
  async register(rawUrl: unknown, rawDuration?: unknown, start?: unknown): Promise<Registration | null> {
    if (this.ffmpeg === null || this.closed) return null;
    const resolved = resolveThumbSource(rawUrl, this.issued, this.extraLocal);
    if (resolved === null) return null;
    const duration =
      typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 && rawDuration <= MAX_DURATION ? rawDuration : undefined;
    const key = createHash('sha256').update(resolved.submitted).digest('hex').slice(0, 40);
    let source = this.sources.get(key);
    if (source === undefined) {
      while (this.sources.size >= MAX_SOURCES) await this.drop(this.oldest());
      source = {
        key,
        target: resolved.target,
        duration,
        count: sliceCount(duration),
        center: 0,
        wanted: [],
        done: new Set(await this.cache.indexes(key)),
        attempts: new Map(),
        failed: new Set(),
        inflight: new Set(),
        lastAccess: this.now(),
        proxy: undefined,
        budget: new ByteBudget(SOURCE_BYTE_BUDGET),
      };
      this.sources.set(key, source);
    } else {
      // Le lien de lecture a pu changer (nouvelle résolution) : on lit toujours la cible la plus récente.
      source.target = resolved.target;
      if (duration !== undefined && source.duration === undefined) {
        source.duration = duration;
        source.count = sliceCount(duration);
      }
    }
    source.lastAccess = this.now();
    if (typeof start === 'number' && Number.isFinite(start) && start >= 0) source.center = Math.min(Math.round(start / SLICE_SECONDS), source.count - 1);
    this.pump();
    return { key, interval: SLICE_SECONDS, count: source.count };
  }

  /**
   * Image d'une tranche. Prête : renvoyée. Sinon elle passe en tête de file et on l'attend au plus `waitMs`.
   * `unknown` : source inconnue (redémarrage, inactivité) ; `missing` : n'existera pas ; `pending` : pas encore prête.
   */
  async frame(key: string, index: number, waitMs = 0): Promise<FrameResult> {
    const source = this.sources.get(key);
    if (source === undefined || this.ffmpeg === null) return { status: 'unknown' };
    source.lastAccess = this.now();
    if (!Number.isInteger(index) || index < 0 || index >= source.count || source.failed.has(index)) return { status: 'missing' };
    const cached = source.done.has(index) ? await this.cache.get(key, index) : undefined;
    if (cached !== undefined) return { status: 'ok', data: cached };
    source.done.delete(index);
    source.center = index;
    this.want(source, index);
    this.pump();
    if (waitMs > 0 && !source.failed.has(index)) {
      await new Promise<void>((resolve) => {
        const slot = `${key}:${index}`;
        const timer = setTimeout(resolve, waitMs);
        const list = this.waiters.get(slot) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.waiters.set(slot, list);
      });
      if (source.failed.has(index) || index >= source.count) return { status: 'missing' };
      const ready = source.done.has(index) ? await this.cache.get(key, index) : undefined;
      if (ready !== undefined) return { status: 'ok', data: ready };
    }
    return { status: 'pending' };
  }

  private want(source: Source, index: number): void {
    const at = this.now();
    source.wanted = source.wanted.filter((w) => w.index !== index && at - w.at < WANTED_MAX_AGE_MS);
    source.wanted.unshift({ index, at });
    source.wanted.length = Math.min(source.wanted.length, WANTED_MAX);
  }

  /** Prochaine tranche à produire pour une source : demandes explicites, puis ordre autour du centre. */
  private nextIndex(source: Source): number | undefined {
    const free = (i: number): boolean => i < source.count && !source.done.has(i) && !source.failed.has(i) && !source.inflight.has(i);
    const at = this.now();
    for (const w of source.wanted) if (at - w.at < WANTED_MAX_AGE_MS && free(w.index)) return w.index;
    return generationOrder(source.center, source.count).find(free);
  }

  private active(): Source[] {
    const at = this.now();
    return [...this.sources.values()]
      .filter((s) => at - s.lastAccess < this.idleMs && !s.budget.exceeded)
      .sort((a, b) => b.lastAccess - a.lastAccess);
  }

  private pump(): void {
    if (this.closed || this.ffmpeg === null) return;
    while (this.running < this.concurrency) {
      let started = false;
      for (const source of this.active()) {
        const index = this.nextIndex(source);
        if (index === undefined) continue;
        source.inflight.add(index);
        this.running += 1;
        void this.generate(source, index).finally(() => {
          this.running -= 1;
          this.pump();
        });
        started = true;
        break;
      }
      if (!started) return;
    }
  }

  private notify(source: Source, index: number): void {
    this.notifySlot(`${source.key}:${index}`);
  }

  private notifySlot(slot: string): void {
    const list = this.waiters.get(slot);
    this.waiters.delete(slot);
    for (const wake of list ?? []) wake();
  }

  private async generate(source: Source, index: number): Promise<void> {
    let outcome: 'ok' | 'end' | 'fail' = 'fail';
    try {
      source.proxy ??= openSource(source.target, source.budget, (u) => defaultLocalPolicy(u) || (this.extraLocal?.(u) ?? false));
      const proxy = await source.proxy;
      const result = await this.run(this.ffmpeg as string, ffmpegArgs(proxy.url, sliceTime(index, source.duration)), {
        timeoutMs: this.timeoutMs,
        maxStdout: MAX_IMAGE_BYTES,
      });
      if (result.killed || result.code !== 0) outcome = 'fail';
      else if (result.stdout.length === 0) outcome = 'end';
      else if (isWebp(result.stdout)) {
        await this.cache.put(source.key, index, result.stdout);
        source.done.add(index);
        outcome = 'ok';
      }
    } catch {
      outcome = 'fail';
    }
    source.inflight.delete(index);
    if (outcome === 'end') {
      // Au-delà de la fin du média : cette tranche et les suivantes n'existent pas.
      source.count = Math.min(source.count, index);
      for (const slot of [...this.waiters.keys()]) if (slot.startsWith(`${source.key}:`)) this.notifySlot(slot);
    } else if (outcome === 'fail') {
      const tries = (source.attempts.get(index) ?? 0) + 1;
      source.attempts.set(index, tries);
      if (tries >= MAX_ATTEMPTS) source.failed.add(index);
    }
    this.notify(source, index);
    if (!this.hasWork(source)) await this.releaseProxy(source);
  }

  private hasWork(source: Source): boolean {
    return source.inflight.size > 0 || this.nextIndex(source) !== undefined;
  }

  private async releaseProxy(source: Source): Promise<void> {
    const proxy = source.proxy;
    source.proxy = undefined;
    if (proxy !== undefined) await (await proxy.catch(() => undefined))?.close();
  }

  private oldest(): Source {
    return [...this.sources.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0] as Source;
  }

  private async drop(source: Source): Promise<void> {
    this.sources.delete(source.key);
    await this.releaseProxy(source);
  }

  /** Abandonne les sources que plus personne ne demande (inactivité). */
  async sweep(): Promise<void> {
    const at = this.now();
    for (const source of [...this.sources.values()]) {
      if (at - source.lastAccess >= this.idleMs && source.inflight.size === 0) await this.drop(source);
    }
  }

  /** Nombre de sources suivies (tests, diagnostic). */
  get sourceCount(): number {
    return this.sources.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const source of [...this.sources.values()]) await this.drop(source);
    for (const list of this.waiters.values()) for (const wake of list) wake();
    this.waiters.clear();
  }
}
