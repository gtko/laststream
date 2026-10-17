import { hostFromUrl } from './hosts.js';
import type { PlayCopy } from './token.js';

/**
 * Codes d'erreur d'un résolveur : portés par la propriété `code` de l'erreur qu'il jette.
 * `no_copy` : la copie n'a pas de source utilisable (torrent privé absent du cache) ; la copie suivante est essayée.
 */
export const RESOLVE_ERROR_CODES = [
  'not_cached',
  'dead_link',
  'host_unavailable',
  'file_not_found',
  'subscription_expired',
  'invalid_key',
  'quota',
  'not_ready',
  'unsupported',
  'no_copy',
  'unknown',
] as const;

export type ResolveErrorCode = (typeof RESOLVE_ERROR_CODES)[number];

export interface ResolvedLink {
  url: string;
  filename?: string;
  size?: number;
}

/** Résolveur injecté. `signal` est annulé quand la tentative dépasse le budget ou que l'appelant abandonne. */
export type ResolveFn = (copy: PlayCopy, signal: AbortSignal) => Promise<ResolvedLink>;

/** Motif d'échec d'une tentative : un code du résolveur, ou une interruption (délai, annulation). */
type AttemptFailure = ResolveErrorCode | 'timeout' | 'aborted';
export type AttemptOutcome = 'ok' | 'host_down' | AttemptFailure;

export interface Attempt {
  index: number;
  outcome: AttemptOutcome;
}

export type FailoverReason = ResolveErrorCode | 'no_copy' | 'timeout' | 'aborted';

export type FailoverResult =
  | { ok: true; link: ResolvedLink; attempts: Attempt[] }
  | { ok: false; reason: FailoverReason; attempts: Attempt[] };

export interface FailoverOptions {
  /** Copies dans l'ordre de priorité ; elles sont essayées une à une. */
  copies: readonly PlayCopy[];
  resolve: ResolveFn;
  /** Budget total en millisecondes (défaut : 12 000). */
  budgetMs?: number;
  /** Horloge en millisecondes (défaut : Date.now). Injectable pour les tests. */
  now?: () => number;
  isHostDown: (host: string) => boolean;
  markHostDown: (host: string) => void;
  /** Annulation de l'appelant : la tentative en cours est interrompue et le résultat est `aborted`. */
  signal?: AbortSignal;
}

type AttemptResult = { kind: 'ok'; link: ResolvedLink } | { kind: 'failed'; reason: AttemptFailure };

const DEFAULT_BUDGET_MS = 12_000;
/** Erreurs globales (clé, abonnement, quota) : aucune autre copie ne réussira, on s'arrête tout de suite. */
const GLOBAL_CODES: ReadonlySet<AttemptFailure> = new Set<AttemptFailure>(['invalid_key', 'subscription_expired', 'quota']);

/** Vrai si la valeur est un code d'erreur de résolveur connu. */
export function isResolveErrorCode(value: string): value is ResolveErrorCode {
  return (RESOLVE_ERROR_CODES as readonly string[]).includes(value);
}

function isGlobalCode(reason: AttemptFailure): reason is 'invalid_key' | 'subscription_expired' | 'quota' {
  return GLOBAL_CODES.has(reason);
}

/**
 * Hôte d'une copie : celui de son URL (hébergeur ou lien direct). Une copie torrent n'a pas d'hôte : elle n'est
 * jamais sautée pour une panne, et une panne de sa résolution ne marque aucun hôte. Undefined si l'URL est invalide.
 */
function hostOf(copy: PlayCopy): string | undefined {
  if (copy.url === undefined) return undefined;
  return hostFromUrl(copy.url);
}

function classifyError(error: unknown): ResolveErrorCode {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
  const { code } = error;
  return typeof code === 'string' && isResolveErrorCode(code) ? code : 'unknown';
}

function isUsableLink(link: ResolvedLink): boolean {
  return typeof link?.url === 'string' && link.url.length > 0;
}

/**
 * Une tentative, bornée par `timeoutMs` (le temps restant du budget). Le résolveur reçoit un signal annulé au délai,
 * ou à l'annulation de l'appelant. La promesse du résolveur n'est jamais attendue au-delà de la borne.
 */
async function attemptOnce(
  copy: PlayCopy,
  timeoutMs: number,
  resolve: ResolveFn,
  external: AbortSignal | undefined,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let finish: (result: AttemptResult) => void = () => undefined;
  const interrupted = new Promise<AttemptResult>((settle) => {
    finish = settle;
  });
  const interrupt = (reason: 'timeout' | 'aborted'): void => {
    controller.abort();
    finish({ kind: 'failed', reason });
  };
  const onExternalAbort = (): void => interrupt('aborted');
  const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
  external?.addEventListener('abort', onExternalAbort, { once: true });

  const call = new Promise<ResolvedLink>((settle) => settle(resolve(copy, controller.signal))).then(
    (link): AttemptResult => (isUsableLink(link) ? { kind: 'ok', link } : { kind: 'failed', reason: 'unknown' }),
    (error: unknown): AttemptResult => ({ kind: 'failed', reason: classifyError(error) }),
  );
  try {
    return await Promise.race([call, interrupted]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Essaie les copies dans l'ordre jusqu'à obtenir un lien. Passe à la suivante sur une erreur propre à la copie
 * (not_cached, dead_link, host_unavailable, file_not_found, not_ready, unsupported, no_copy, unknown) ; s'arrête tout
 * de suite sur une erreur globale (invalid_key, subscription_expired, quota). Saute les copies dont l'hôte d'URL est
 * marqué down. `markHostDown` est appelé sur host_unavailable, uniquement pour l'hôte de l'URL de la copie : une copie
 * torrent ne marque rien. Le budget total est respecté : chaque tentative reçoit le temps restant.
 * Ne lève jamais : le résultat décrit la suite de tentatives.
 */
export async function resolveWithFailover(options: FailoverOptions): Promise<FailoverResult> {
  const { copies, resolve, isHostDown, markHostDown, signal } = options;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + budgetMs;
  const attempts: Attempt[] = [];
  const fail = (reason: FailoverReason): FailoverResult => ({ ok: false, reason, attempts });

  if (copies.length === 0) return fail('no_copy');

  let lastFailure: FailoverReason | undefined;
  for (const [index, copy] of copies.entries()) {
    if (signal?.aborted) return fail('aborted');
    const remaining = deadline - now();
    if (remaining <= 0) return fail('timeout');

    const host = hostOf(copy);
    if (host !== undefined && isHostDown(host)) {
      attempts.push({ index, outcome: 'host_down' });
      continue;
    }

    const result = await attemptOnce(copy, remaining, resolve, signal);
    if (result.kind === 'ok') {
      attempts.push({ index, outcome: 'ok' });
      return { ok: true, link: result.link, attempts };
    }

    const { reason } = result;
    attempts.push({ index, outcome: reason });
    if (reason === 'timeout' || reason === 'aborted' || isGlobalCode(reason)) return fail(reason);
    lastFailure = reason;
    if (reason === 'host_unavailable' && host !== undefined) markHostDown(host);
  }

  // Aucune copie n'a abouti : on rend la dernière erreur propre aux copies, ou host_unavailable si toutes étaient sautées.
  return fail(lastFailure ?? 'host_unavailable');
}
