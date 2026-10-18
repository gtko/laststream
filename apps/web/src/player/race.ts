/* Course entre candidats pour la préparation d'une lecture (lien, sonde, session HLS) : délai doux, délai dur, plafond total.
 * Logique pure (minuteries injectées par setTimeout), testée avec des fausses horloges. */

export const SOFT_MS = 6_000;
export const HARD_MS = 12_000;
export const TOTAL_MS = 25_000;
export const MAX_FAILURES = 3;
export const MAX_ATTEMPTS = 5;
export const MAX_PARALLEL = 2;

export type FailureReason = 'timeout' | 'error' | 'lost';

export interface Failure<C> {
  candidate: C;
  reason: FailureReason;
  message: string;
}

export interface RaceWin<C, T> {
  candidate: C;
  value: T;
  /** Candidats abandonnés parce qu'un autre a été prêt avant eux (lents, à éviter la prochaine fois). */
  lost: Failure<C>[];
  /** Échecs avant la victoire. */
  failures: Failure<C>[];
}

export class RaceFailure<C> extends Error {
  constructor(public readonly kind: 'exhausted' | 'total-timeout' | 'cancelled', public readonly failures: Failure<C>[]) {
    super(kind);
  }
}

export interface RaceConfig<C, T> {
  first: C;
  /** Prochain candidat à essayer (null : plus aucun). `tried` : tous ceux déjà lancés. */
  next(tried: readonly C[]): C | null;
  run(candidate: C, signal: AbortSignal): Promise<T>;
  softMs?: number;
  hardMs?: number;
  totalMs?: number;
  maxFailures?: number;
  maxAttempts?: number;
  maxParallel?: number;
  /** `slow` : le délai doux est passé, on essaie autre chose. `attempt` / `max` : « essai d'une autre source (2/5) ». */
  onProgress?(p: { attempt: number; max: number; slow: boolean; candidate: C }): void;
}

interface Run<C> {
  candidate: C;
  ctl: AbortController;
  timers: Array<ReturnType<typeof setTimeout>>;
}

export function raceCandidates<C, T>(cfg: RaceConfig<C, T>): { promise: Promise<RaceWin<C, T>>; cancel(): void } {
  const softMs = cfg.softMs ?? SOFT_MS;
  const hardMs = cfg.hardMs ?? HARD_MS;
  const maxFailures = cfg.maxFailures ?? MAX_FAILURES;
  const maxAttempts = cfg.maxAttempts ?? MAX_ATTEMPTS;
  const maxParallel = cfg.maxParallel ?? MAX_PARALLEL;
  const tried: C[] = [];
  const running = new Set<Run<C>>();
  const failures: Failure<C>[] = [];
  let done = false;
  let slow = false;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: (w: RaceWin<C, T>) => void;
  let reject!: (e: RaceFailure<C>) => void;
  const promise = new Promise<RaceWin<C, T>>((res, rej) => { resolve = res; reject = rej; });

  const stopRun = (r: Run<C>): void => { r.timers.forEach(clearTimeout); r.ctl.abort(); running.delete(r); };
  const finish = (): void => { done = true; if (totalTimer) clearTimeout(totalTimer); };

  const fail = (r: Run<C>, reason: FailureReason, message: string): void => {
    if (done || !running.has(r)) return;
    stopRun(r);
    failures.push({ candidate: r.candidate, reason, message });
    if (failures.length >= maxFailures) {
      finish();
      running.forEach(stopRun);
      reject(new RaceFailure('exhausted', failures));
      return;
    }
    if (running.size === 0) startNext(true);
  };

  const start = (candidate: C): void => {
    tried.push(candidate);
    const run: Run<C> = { candidate, ctl: new AbortController(), timers: [] };
    running.add(run);
    cfg.onProgress?.({ attempt: tried.length, max: maxAttempts, slow, candidate });
    run.timers.push(setTimeout(() => { if (!done && running.has(run)) startNext(false); }, softMs));
    run.timers.push(setTimeout(() => fail(run, 'timeout', 'trop long (' + Math.round(hardMs / 1000) + ' s)'), hardMs));
    cfg.run(candidate, run.ctl.signal).then(
      (value) => {
        if (done || !running.has(run)) return;
        finish();
        running.delete(run);
        run.timers.forEach(clearTimeout);
        const lost: Failure<C>[] = [];
        running.forEach((other) => { lost.push({ candidate: other.candidate, reason: 'lost', message: 'abandonnée : une autre source était prête avant' }); stopRun(other); });
        resolve({ candidate, value, lost, failures });
      },
      (err: unknown) => fail(run, 'error', err instanceof Error ? err.message : String(err)),
    );
  };

  /** `required` : plus rien ne tourne, il faut absolument un candidat ; sinon (délai doux) on en ajoute un en parallèle. */
  function startNext(required: boolean): void {
    if (done) return;
    if (!required) {
      if (running.size >= maxParallel || tried.length >= maxAttempts) return;
      slow = true;
    }
    const n = tried.length < maxAttempts ? cfg.next(tried) : null;
    if (n !== null) { start(n); return; }
    if (required) {
      finish();
      reject(new RaceFailure('exhausted', failures));
    }
  }

  totalTimer = setTimeout(() => {
    if (done) return;
    finish();
    running.forEach((r) => { failures.push({ candidate: r.candidate, reason: 'timeout', message: 'toujours en préparation après ' + Math.round((cfg.totalMs ?? TOTAL_MS) / 1000) + ' s' }); stopRun(r); });
    reject(new RaceFailure('total-timeout', failures));
  }, cfg.totalMs ?? TOTAL_MS);

  start(cfg.first);
  return {
    promise,
    cancel() {
      if (done) return;
      finish();
      running.forEach(stopRun);
      reject(new RaceFailure('cancelled', failures));
    },
  };
}
