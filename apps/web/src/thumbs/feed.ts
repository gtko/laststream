/* Pont entre la librairie et ThumbFeed (src/player/thumbfeed.ts) : mêmes tranches de 30 s, mêmes précharge et annulation,
 * mais l'image d'une tranche vient du cache client, sinon d'une image clé lue par plages puis décodée (WebCodecs).
 * `register` obtient un jeton de relais et vérifie que le format et le codec sont gérés ; refus = pas de miniatures (silencieux). */

import { canDecode, decodeKeyframe, type CodecEnv } from './decode';
import { openVideoIndex } from './index';
import { directFetchRange, proxyFetchRange, RangeAuthError, type FetchFn } from './proxy';
import { MemoryThumbStore, thumbKey, type ThumbStore } from './store';
import type { ByteSource, ByteSourceOptions } from './bytes';
import type { VideoIndex } from './types';

export const LOCAL_SLICE_SECONDS = 30;
/** Décodages simultanés : le décodeur matériel est partagé avec la lecture. */
export const LOCAL_MAX_PARALLEL = 2;
/** Délai maximal d'attente d'un moment calme avant de lancer une tranche quand même. */
export const IDLE_TIMEOUT_MS = 2000;
/** Délai du repli setTimeout quand requestIdleCallback n'existe pas. */
export const IDLE_FALLBACK_MS = 100;
/** Re-vérification périodique tant que la lecture tamponne. */
export const BUFFER_RECHECK_MS = 1000;

/** Lance `run` au moment choisi ; renvoie l'annulation (sans effet si `run` a déjà été lancé). */
export type ScheduleFn = (run: () => void) => () => void;

interface IdleHost {
  requestIdleCallback?: (run: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

/** Planification par défaut : au repos du navigateur (requestIdleCallback, délai max IDLE_TIMEOUT_MS), repli setTimeout. */
export const idleSchedule: ScheduleFn = (run) => {
  const host = globalThis as unknown as IdleHost;
  if (typeof host.requestIdleCallback === 'function') {
    const id = host.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => host.cancelIdleCallback?.(id);
  }
  const timer = setTimeout(run, IDLE_FALLBACK_MS);
  return () => clearTimeout(timer);
};

const abortError = (): DOMException => new DOMException('aborted', 'AbortError');

interface TurnOptions {
  isBuffering: () => boolean;
  schedule: ScheduleFn;
  recheckMs: number;
}

/**
 * Attend le créneau d'une tranche : tant que la lecture tamponne, on re-vérifie toutes les `recheckMs` ; puis `schedule` lance la suite.
 * Annulée par `signal` : rejet AbortError, et plus aucun timer ni callback en attente.
 */
function waitTurn(signal: AbortSignal, o: TurnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelIdle: (() => void) | undefined;
    let settled = false;

    const clear = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (cancelIdle !== undefined) { cancelIdle(); cancelIdle = undefined; }
    };
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clear();
      if (ok) resolve();
      else reject(abortError());
    };
    const onAbort = (): void => settle(false);
    const check = (): void => {
      timer = undefined;
      if (settled) return;
      if (o.isBuffering()) { timer = setTimeout(check, o.recheckMs); return; }
      const cancel = o.schedule(() => {
        cancelIdle = undefined;
        if (settled) return;
        if (o.isBuffering()) { timer = setTimeout(check, o.recheckMs); return; }
        settle(true);
      });
      if (settled) cancel();
      else cancelIdle = cancel;
    };

    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

export interface LocalSource {
  /** Lien débridé lu. */
  url: string;
  /** Avec `token` et `base` : lecture par le relais (ancienne voie, abandonnée) ; sans eux : lecture directe depuis l'appareil. */
  token?: string;
  base?: string;
}

export interface LocalFeedOptions {
  /** Demande un jeton de relais pour la source courante (lastAddon). null : source refusée. */
  resolve(signal: AbortSignal): Promise<LocalSource | null>;
  /** Identifiant stable de la source pour le cache (l'adresse de lecture, pas le lien débridé qui change). */
  sourceId: string;
  fetchFn: FetchFn;
  store?: ThumbStore;
  env?: CodecEnv;
  sliceSeconds?: number;
  /** Réglages de lecture (taille du début de fichier gardé, plafond de plage) : tests. */
  source?: ByteSourceOptions;
  /** Lance chaque tranche (lecture + décodage) au repos du navigateur. Défaut : requestIdleCallback, repli setTimeout. */
  schedule?: ScheduleFn;
  /** Vrai tant que la lecture tamponne : aucune tranche ne démarre, re-vérification périodique. Défaut : jamais. */
  isBuffering?: () => boolean;
}

export interface LocalFeed {
  register(signal: AbortSignal): Promise<string | null>;
  imageUrl(key: string, index: number): string;
  fetchFn(url: string, init: { signal: AbortSignal }): Promise<Pick<Response, 'status' | 'blob' | 'json'>>;
  maxParallel: number;
  /** Octets reçus et requêtes faites depuis l'ouverture de la source. */
  stats(): { requests: number; bytes: number; thumbs: number };
}

const reply = (status: number, body?: Blob | Record<string, unknown>): Pick<Response, 'status' | 'blob' | 'json'> => ({
  status,
  blob: () => Promise.resolve(body instanceof Blob ? body : new Blob()),
  json: () => Promise.resolve(body instanceof Blob || body === undefined ? {} : body),
});

export function makeLocalFeed(o: LocalFeedOptions): LocalFeed {
  const slice = o.sliceSeconds ?? LOCAL_SLICE_SECONDS;
  const store = o.store ?? new MemoryThumbStore();
  let opened: { index: VideoIndex; source: ByteSource } | null = null;
  let thumbs = 0;
  let spent = { requests: 0, bytes: 0 };

  const open = async (signal: AbortSignal): Promise<boolean> => {
    if (opened !== null) spent = { requests: spent.requests + opened.source.requests, bytes: spent.bytes + opened.source.bytes };
    opened = null;
    const s = await o.resolve(signal);
    if (s === null) return false;
    const fetchRange = s.token !== undefined && s.base !== undefined ? proxyFetchRange({ url: s.url, token: s.token, base: s.base }, o.fetchFn) : directFetchRange(s.url, o.fetchFn);
    const r = await openVideoIndex(fetchRange, o.source ?? {}, signal);
    if (r === null || !(await canDecode(r.index.info, o.env))) return false;
    opened = r;
    return true;
  };

  return {
    maxParallel: LOCAL_MAX_PARALLEL,
    register: async (signal) => {
      try {
        return (await open(signal)) ? 'local' : null;
      } catch {
        return null;
      }
    },
    imageUrl: (_key, index) => `local:${index}`,
    stats: () => ({
      requests: spent.requests + (opened?.source.requests ?? 0),
      bytes: spent.bytes + (opened?.source.bytes ?? 0),
      thumbs,
    }),
    fetchFn: async (url, { signal }) => {
      const index = Number(url.slice(url.lastIndexOf(':') + 1));
      if (!Number.isInteger(index) || index < 0) return reply(404, { error: 'not_found' });
      const key = thumbKey(o.sourceId, index);
      const cached = await store.get(key).catch(() => undefined);
      if (cached !== undefined) return reply(200, cached);
      if (opened === null) return reply(404, { error: 'unknown_source' });
      // Budget d'arrière-plan : la tranche attend que la lecture ne tamponne plus, puis un moment calme du navigateur.
      try {
        await waitTurn(signal, { isBuffering: o.isBuffering ?? (() => false), schedule: o.schedule ?? idleSchedule, recheckMs: BUFFER_RECHECK_MS });
      } catch {
        return reply(499);
      }
      if (opened === null) return reply(404, { error: 'unknown_source' }); // source refermée pendant l'attente
      const { index: video } = opened;
      try {
        const duration = video.info.duration;
        if (duration > 0 && index * slice > duration) return reply(404, { error: 'not_found' });
        const ref = await video.keyframeAt(Math.min(index * slice, Math.max(0, duration - 1)), signal);
        if (ref === null) return reply(404, { error: 'not_found' });
        const sample = await video.readSample(ref, signal);
        if (sample === null) return reply(500);
        const blob = await decodeKeyframe(sample, video.info, { signal }, o.env);
        if (blob === null) return reply(signal.aborted ? 499 : 500);
        thumbs += 1;
        await store.set(key, blob).catch(() => undefined);
        return reply(200, blob);
      } catch (e) {
        // Jeton expiré ou refusé : ThumbFeed réenregistre la source une fois (réponse « unknown_source »).
        if (e instanceof RangeAuthError) { opened = null; return reply(404, { error: 'unknown_source' }); }
        throw e;
      }
    },
  };
}
