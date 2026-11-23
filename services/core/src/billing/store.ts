import type { SqlDb, SqlRow } from '../user/sql.js';
import { addMonths, type BillingState, EMPTY_BILLING } from './access.js';

/** Accès SQL de l'abonnement (tables billing, referral_rewards, billing_events). Appelé par UserStore. */

function toState(row: SqlRow | undefined): BillingState {
  if (row === undefined) return EMPTY_BILLING;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    customerId: text(row.customer_id),
    subscriptionId: text(row.subscription_id),
    status: text(row.status),
    paidUntil: text(row.paid_until),
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    compUntil: text(row.comp_until),
    firstPaidAt: text(row.first_paid_at),
  };
}

function ensureRow(db: SqlDb, accountId: string, now: string): void {
  db.prepare('INSERT INTO billing (account_id, updated_at) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING').run(accountId, now);
}

export function billingOf(db: SqlDb, accountId: string): BillingState {
  return toState(db.prepare('SELECT * FROM billing WHERE account_id = ?').get(accountId));
}

/** Compte lié à un client Stripe, s'il existe encore. */
export function accountOfCustomer(db: SqlDb, customerId: string): string | undefined {
  const row = db.prepare('SELECT b.account_id FROM billing b JOIN accounts a ON a.id = b.account_id WHERE b.customer_id = ?').get(customerId);
  return typeof row?.account_id === 'string' ? row.account_id : undefined;
}

export function accountExists(db: SqlDb, accountId: string): boolean {
  return db.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').get(accountId) !== undefined;
}

export function setCustomer(db: SqlDb, accountId: string, customerId: string, now: string): void {
  ensureRow(db, accountId, now);
  db.prepare('UPDATE billing SET customer_id = ?, updated_at = ? WHERE account_id = ?').run(customerId, now, accountId);
}

export interface SubscriptionWrite {
  customerId: string;
  subscriptionId: string;
  status: string;
  paidUntil: string | null;
  cancelAtPeriodEnd: boolean;
}

export function applySubscription(db: SqlDb, accountId: string, sub: SubscriptionWrite, now: string): void {
  ensureRow(db, accountId, now);
  db.prepare(
    `UPDATE billing SET customer_id = ?, subscription_id = ?, status = ?, paid_until = ?, cancel_at_period_end = ?, updated_at = ?
     WHERE account_id = ?`,
  ).run(sub.customerId, sub.subscriptionId, sub.status, sub.paidUntil, sub.cancelAtPeriodEnd ? 1 : 0, now, accountId);
}

/** Prolonge l'accès offert de `months` mois, à partir de la plus tardive de `from` et de l'accès offert actuel. */
export function extendComp(db: SqlDb, accountId: string, months: number, from: string, now: string): string {
  ensureRow(db, accountId, now);
  const current = billingOf(db, accountId).compUntil;
  const base = current !== null && current > from ? current : from;
  const until = addMonths(base, months);
  db.prepare('UPDATE billing SET comp_until = ?, updated_at = ? WHERE account_id = ?').run(until, now, accountId);
  return until;
}

/** Parrain d'un compte (lien de parrainage d'un membre, pas une invitation système), ou null. */
export function inviterOf(db: SqlDb, accountId: string): string | null {
  const row = db
    .prepare('SELECT i.inviter_id FROM invites i JOIN accounts a ON a.id = i.inviter_id WHERE i.used_by = ? AND i.inviter_id IS NOT NULL LIMIT 1')
    .get(accountId);
  return typeof row?.inviter_id === 'string' ? row.inviter_id : null;
}

/**
 * Note le premier paiement non nul d'un compte. Au premier seulement, réserve la récompense de son parrain (une par
 * filleul) et renvoie l'id du parrain à récompenser ; sinon null.
 */
export function recordFirstPayment(db: SqlDb, accountId: string, months: number, now: string): string | null {
  return db.transaction(() => {
    ensureRow(db, accountId, now);
    const done = db.prepare('UPDATE billing SET first_paid_at = ?, updated_at = ? WHERE account_id = ? AND first_paid_at IS NULL').run(now, now, accountId);
    if (Number(done.changes) === 0) return null;
    const inviter = inviterOf(db, accountId);
    if (inviter === null || months <= 0) return null;
    const granted = db
      .prepare('INSERT INTO referral_rewards (invitee_id, inviter_id, months, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(invitee_id) DO NOTHING')
      .run(accountId, inviter, months, now);
    return Number(granted.changes) === 0 ? null : inviter;
  });
}

/** Mois offerts au total à un parrain. */
export function rewardMonthsOf(db: SqlDb, accountId: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(months), 0) AS m FROM referral_rewards WHERE inviter_id = ?').get(accountId);
  return Number(row?.m ?? 0);
}

/** Note un événement de webhook ; false s'il a déjà été traité. */
export function markEvent(db: SqlDb, eventId: string, now: string): boolean {
  return Number(db.prepare('INSERT INTO billing_events (id, received_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(eventId, now).changes) > 0;
}

/** Oublie un événement (traitement échoué : Stripe le renverra). */
export function unmarkEvent(db: SqlDb, eventId: string): void {
  db.prepare('DELETE FROM billing_events WHERE id = ?').run(eventId);
}
