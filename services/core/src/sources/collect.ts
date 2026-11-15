import type { Config } from '../config/schema.js';
import type { ContentRef, RawStream } from '../types.js';
import { SourceError, type HttpOptions } from './http.js';
import { createHash } from 'node:crypto';
import { fetchUpstream } from './upstream.js';
import { deviceFetchEntry, type DeviceFetchEntry } from './device-fetch.js';

/** Budget dur de la collecte (ms) : au-delà, la source n'est plus attendue. */
export const COLLECT_BUDGET_MS = 25_000;
/** Échéance douce de la collecte (ms) : au-delà, la réponse part avec les sources arrivées, les autres en attente. */
export const COLLECT_SOFT_MS = 4_000;

/** Erreur isolée d'une source : son nom et un message sûr (sans URL ni clé). */
export interface SourceErrorEntry {
  source: string;
  error: string;
}

export interface CollectResult {
  streams: RawStream[];
  errors: SourceErrorEntry[];
  /** Indexeurs sans première réponse à l'échéance douce : leurs résultats arriveront plus tard. Vide : réponse complète. */
  pending?: string[];
  /** Addons amont bloqués pour l'IP du serveur : l'appareil les interroge lui-même (voir device-fetch.ts). */
  deviceFetch?: DeviceFetchEntry[];
  /** Se résout quand les recherches encore actives (retardataires, compléments) sont terminées. Présent seulement alors. */
  settled?: Promise<void>;
}

/** Options de collecte : fetch injectable, budget dur et échéance douce (ms). */
export interface CollectOptions extends HttpOptions {
  budgetMs?: number;
  /** Échéance douce (ms) : réponse partielle, addons lents en arrière-plan. Absent : on attend tout. */
  softMs?: number;
  /** Reprendre les recherches échouées récemment au lieu de les relancer (recalcul en arrière-plan). */
  reuseFailed?: boolean;
}

/** Résultat d'une source : ses flux et, si elle a une échéance douce, les indexeurs encore en cours. */
interface SourceOutcome {
  streams: RawStream[];
  pending: string[];
  settled?: Promise<void>;
}

type SourceConfig = Config['sources'][number];

/** Marge entre le budget interne d'une source et la limite externe de la collecte, en millisecondes. */
const SOURCE_MARGIN_MS = 500;

/** Recherche d'un addon amont, en cours ou terminée : partagée entre les appels (dédoublonnage, cache de 5 minutes). */
interface UpstreamTask {
  settled: boolean;
  expiresAt: number;
  streams?: RawStream[];
  error?: unknown;
  done: Promise<void>;
}

/** Échéance douce minimale d'un addon amont : ils répondent souvent en 3 à 10 s. */
const UPSTREAM_SOFT_MS = 6_000;
const UPSTREAM_TASK_TTL_MS = 5 * 60 * 1_000;
const UPSTREAM_FAILED_TTL_MS = 60 * 1_000;
/** Réponse vide d'un addon : gardée 60 s seulement (il peut répondre vide avant la sortie d'un épisode). */
const UPSTREAM_EMPTY_TTL_MS = 60 * 1_000;
const upstreamTasks = new Map<string, UpstreamTask>();

/** Vide les recherches d'addons gardées en mémoire (tests). */
export function clearUpstreamTasks(): void {
  upstreamTasks.clear();
}

/**
 * Addon amont avec échéance douce : au-delà de `softMs`, l'addon (souvent lent : 3 à 10 s) continue en arrière-plan,
 * il est listé en attente et son résultat est repris par le recalcul. Son échec ne retire rien aux autres sources.
 */
async function searchUpstreamSoft(
  source: Extract<SourceConfig, { type: 'upstream' }>,
  ref: ContentRef,
  opts: CollectOptions,
): Promise<SourceOutcome> {
  const key = createHash('sha256').update(`${source.url}\0${ref.type}\0${ref.id}`).digest('hex');
  const now = Date.now();
  let task = upstreamTasks.get(key);
  if (task === undefined || (task.settled && (task.expiresAt <= now || (task.error !== undefined && opts.reuseFailed !== true)))) {
    for (const [k, t] of upstreamTasks) if (t.settled && t.expiresAt <= now) upstreamTasks.delete(k);
    const fresh: UpstreamTask = { settled: false, expiresAt: 0, done: Promise.resolve() };
    fresh.done = fetchUpstream(source, ref, { ...opts, timeoutMs: opts.timeoutMs ?? opts.budgetMs ?? COLLECT_BUDGET_MS }).then(
      (streams) => {
        fresh.streams = streams;
        fresh.expiresAt = Date.now() + (streams.length === 0 ? UPSTREAM_EMPTY_TTL_MS : UPSTREAM_TASK_TTL_MS);
        fresh.settled = true;
      },
      (error: unknown) => {
        fresh.error = error;
        fresh.expiresAt = Date.now() + UPSTREAM_FAILED_TTL_MS;
        fresh.settled = true;
      },
    );
    upstreamTasks.set(key, fresh);
    task = fresh;
  }
  const current = task;
  if (opts.softMs === undefined) await current.done;
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(opts.softMs ?? 0, UPSTREAM_SOFT_MS));
    });
    try {
      await Promise.race([current.done, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!current.settled) return { streams: [], pending: [source.name], settled: current.done };
  if (current.error !== undefined) throw current.error;
  return { streams: current.streams ?? [], pending: [] };
}

/** Clé d'un flux pour repérer la même copie rendue par deux identifiants d'un même addon. */
const streamKey = (stream: RawStream): string | undefined =>
  stream.infoHash !== undefined ? `${stream.infoHash.toLowerCase()}:${stream.fileIdx ?? ''}` : stream.url;

/**
 * Addon amont interrogé avec l'identifiant IMDb puis, pour un anime, avec ses identifiants MAL et Kitsu (`ref.altIds`),
 * en parallèle. Les flux trouvés seulement par un identifiant d'anime portent `altEpisode` (numéro dans la fiche).
 * Un addon qui ne connaît pas ces identifiants répond vide ou en erreur : seul l'échec de la recherche IMDb compte.
 */
async function searchWithAltIds(
  source: Extract<SourceConfig, { type: 'upstream' }>,
  ref: ContentRef,
  opts: CollectOptions,
): Promise<SourceOutcome> {
  const main = searchUpstreamSoft(source, ref, opts);
  const alts = (ref.altIds ?? []).map((id) => {
    const { altIds: _altIds, ...plain } = ref;
    return searchUpstreamSoft(source, { ...plain, id }, opts).then(
      (outcome) => ({ id, outcome }),
      () => undefined,
    );
  });
  const [outcome, ...extra] = await Promise.all([main, ...alts]);
  const seen = new Set(outcome.streams.map(streamKey).filter((key) => key !== undefined));
  const streams = [...outcome.streams];
  const pending = new Set(outcome.pending);
  const background = outcome.settled === undefined ? [] : [outcome.settled];
  for (const alt of extra) {
    if (alt === undefined) continue;
    const altEpisode = Number(alt.id.split(':')[2]);
    for (const stream of alt.outcome.streams) {
      const key = streamKey(stream);
      if (key !== undefined && seen.has(key)) continue;
      if (key !== undefined) seen.add(key);
      streams.push({ ...stream, altEpisode });
    }
    for (const name of alt.outcome.pending) pending.add(name);
    if (alt.outcome.settled !== undefined) background.push(alt.outcome.settled.catch(() => undefined));
  }
  const merged: SourceOutcome = { streams, pending: [...pending] };
  if (background.length > 0) merged.settled = Promise.all(background).then(() => undefined);
  return merged;
}

/**
 * Fusionne les copies d'un même infoHash venues de plusieurs indexeurs (flux portant `indexers`).
 * Garde la première occurrence, à sa place ; `indexers` reçoit l'union des noms, dans l'ordre d'arrivée.
 * Les flux sans indexers ou sans infoHash ne sont pas touchés.
 */
export function mergeIndexerCopies(streams: RawStream[]): RawStream[] {
  const firstByHash = new Map<string, RawStream>();
  const merged: RawStream[] = [];
  for (const stream of streams) {
    const hash = stream.indexers !== undefined && stream.infoHash !== undefined ? stream.infoHash.toLowerCase() : undefined;
    if (hash === undefined || stream.indexers === undefined) {
      merged.push(stream);
      continue;
    }
    const first = firstByHash.get(hash);
    if (first === undefined) {
      const copy: RawStream = { ...stream, indexers: [...new Set(stream.indexers)] };
      firstByHash.set(hash, copy);
      merged.push(copy);
      continue;
    }
    first.indexers = [...new Set([...(first.indexers ?? []), ...stream.indexers])];
    // La copie fusionnée garde la meilleure priorité de source parmi ses occurrences.
    if (stream.sourcePriority !== undefined) {
      first.sourcePriority = Math.min(first.sourcePriority ?? Number.MAX_SAFE_INTEGER, stream.sourcePriority);
    }
  }
  return merged;
}

/**
 * Résultat d'une source au plus tard après `budgetMs` : au-delà, erreur sûre « délai dépassé » (sans URL). Sans budget,
 * le résultat est renvoyé tel quel. La source n'est pas annulée : son résultat tardif est ignoré.
 */
function bounded(work: Promise<SourceOutcome>, name: string, budgetMs: number | undefined): Promise<SourceOutcome> {
  if (budgetMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SourceError(`Source "${name}" : délai dépassé (${budgetMs} ms)`, true)), budgetMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Interroge en parallèle les addons amont activés de la configuration (les désactivés sont ignorés, et les autres types
 * de sources, anciens indexeurs, ne sont jamais interrogés).
 * Une source en échec n'empêche pas les autres : son erreur est listée dans `errors`.
 * Les streams sont renvoyés dans l'ordre des sources de la configuration, copies d'indexeurs fusionnées par infoHash.
 */
export async function collectStreams(config: Config, ref: ContentRef, opts: CollectOptions = {}): Promise<CollectResult> {
  // Sources désactivées ignorées. L'index d'une source dans la configuration (son ordre = sa priorité) est conservé.
  const active = config.sources.flatMap((source, priority) =>
    source.type === 'upstream' && source.enabled !== false ? [{ source, priority }] : [],
  );
  // Chaque source borne sa propre recherche un peu avant le budget de la collecte : elle rend ses résultats partiels
  // à temps, au lieu d'être coupée par la limite externe (qui ne garde rien de la source).
  const inner: CollectOptions =
    opts.budgetMs === undefined ? opts : { ...opts, budgetMs: Math.max(0, opts.budgetMs - SOURCE_MARGIN_MS) };
  const runs = active.map(({ source }) => bounded(searchWithAltIds(source, ref, inner), source.name, opts.budgetMs));
  const settled = await Promise.allSettled(runs);

  const streams: RawStream[] = [];
  const errors: SourceErrorEntry[] = [];
  const pending: string[] = [];
  const background: Promise<void>[] = [];
  const deviceFetch: DeviceFetchEntry[] = [];
  settled.forEach((result, index) => {
    const entry = active[index];
    const source = entry?.source.name ?? 'inconnue';
    if (result.status === 'fulfilled') {
      const priority = entry?.priority;
      streams.push(
        ...result.value.streams.map((stream) => ({
          ...stream,
          ...(priority === undefined ? {} : { sourcePriority: priority }),
        })),
      );
      pending.push(...result.value.pending);
      if (result.value.settled !== undefined) background.push(result.value.settled);
      return;
    }
    const error =
      result.reason instanceof SourceError ? result.reason.message : `Source "${source}" : erreur inattendue`;
    errors.push({ source, error });
    if (entry !== undefined && result.reason instanceof SourceError && result.reason.blocked) {
      const device = deviceFetchEntry(entry.source, ref);
      if (device !== undefined) deviceFetch.push(device);
    }
  });
  const collected: CollectResult = { streams: mergeIndexerCopies(streams), errors };
  if (pending.length > 0) collected.pending = pending;
  if (deviceFetch.length > 0) collected.deviceFetch = deviceFetch;
  if (background.length > 0) collected.settled = Promise.all(background).then(() => undefined);
  return collected;
}
