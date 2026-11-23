import type { BillingConfig } from './config.js';

/** État d'abonnement d'un compte, tel que stocké (table billing). */
export interface BillingState {
  customerId: string | null;
  subscriptionId: string | null;
  /** Statut Stripe de l'abonnement (active, trialing, past_due, canceled, …), ou null. */
  status: string | null;
  /** Fin de la période payée (ou de l'essai), ISO. */
  paidUntil: string | null;
  cancelAtPeriodEnd: boolean;
  /** Accès offert jusqu'à (parrainage, geste), ISO. */
  compUntil: string | null;
  firstPaidAt: string | null;
}

export const EMPTY_BILLING: BillingState = {
  customerId: null,
  subscriptionId: null,
  status: null,
  paidUntil: null,
  cancelAtPeriodEnd: false,
  compUntil: null,
  firstPaidAt: null,
};

/** Statuts Stripe qui ouvrent l'accès jusqu'à la fin de la période. past_due : Stripe retente le paiement. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);
/** Délai de grâce après la fin de période (paiement de renouvellement en cours de relance). */
const GRACE_MS = 3 * 24 * 3600 * 1000;

const after = (iso: string | null | undefined, nowMs: number, slackMs = 0): boolean =>
  iso != null && Date.parse(iso) + slackMs > nowMs;

/** Raison de l'accès : owner, free (période de transition), comp (offert), paid (abonnement), ou null (pas d'accès). */
export type AccessReason = 'disabled' | 'owner' | 'free' | 'comp' | 'paid' | null;

export function accessReason(config: BillingConfig | undefined, isOwner: boolean, state: BillingState, nowMs: number): AccessReason {
  if (config === undefined) return 'disabled';
  if (isOwner) return 'owner';
  if (state.status !== null && LIVE_STATUSES.has(state.status) && after(state.paidUntil, nowMs, GRACE_MS)) return 'paid';
  if (after(state.compUntil, nowMs)) return 'comp';
  if (after(config.freeUntil, nowMs)) return 'free';
  return null;
}

/** Date jusqu'à laquelle l'accès est ouvert sans action (la plus lointaine des échéances), ou null. */
export function accessUntil(config: BillingConfig | undefined, state: BillingState): string | null {
  const dates = [state.status !== null && LIVE_STATUSES.has(state.status) ? state.paidUntil : null, state.compUntil, config?.freeUntil ?? null]
    .filter((d): d is string => d !== null)
    .sort();
  return dates.at(-1) ?? null;
}

/**
 * Routes /user utilisables sans abonnement : connexion, compte, et l'abonnement lui-même (sinon impossible de payer).
 * Chemins complets (montage /user compris), méthode comprise.
 */
const EXEMPT: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/user\/me\/?$/ },
  { method: 'POST', path: /^\/user\/(refresh|logout|logout-all|password)\/?$/ },
  { method: 'DELETE', path: /^\/user\/account\/?$/ },
  { method: '*', path: /^\/user\/billing(\/.*)?$/ },
  { method: '*', path: /^\/admin(\/.*)?$/ },
];

export function isAccessExempt(method: string, path: string): boolean {
  return EXEMPT.some((rule) => (rule.method === '*' || rule.method === method) && rule.path.test(path));
}

/** Ajoute `months` mois calendaires à une date ISO. */
export function addMonths(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}
