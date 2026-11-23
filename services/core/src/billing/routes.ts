import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { sendJson } from '../http/respond.js';
import { isRecord } from '../sources/http.js';
import type { UserBackend, UserRepo } from '../user/repo.js';
import { assertNotLocked, nowIso, type Session, sessionOf } from '../user/session.js';
import { UserApiError } from '../user/validation.js';
import { accessReason, accessUntil, addMonths, type BillingState, EMPTY_BILLING } from './access.js';
import { type BillingConfig, billingConfig } from './config.js';
import { createStripeClient, periodEnd, StripeError, type StripeClient, type StripeSubscription, verifyStripeSignature } from './stripe.js';

/** Statuts d'un abonnement encore en cours (paiement à venir ou en relance). */
const RUNNING: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);
/** Stripe refuse un essai qui finit dans moins de 48 h. */
const MIN_TRIAL_MS = 48 * 3600 * 1000;
/** Prix affiché, relu chez Stripe au plus une fois par heure. */
const PRICE_TTL_MS = 3600 * 1000;

interface PriceView {
  amount: number;
  currency: string;
  interval: string;
}

let priceCache: { id: string; at: number; value: PriceView | null } | undefined;

async function priceOf(stripe: StripeClient, priceId: string): Promise<PriceView | null> {
  if (priceCache !== undefined && priceCache.id === priceId && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.value;
  let value: PriceView | null = null;
  try {
    const price = await stripe.get<{ unit_amount?: number; currency?: string; recurring?: { interval?: string } }>(`/prices/${encodeURIComponent(priceId)}`);
    if (typeof price.unit_amount === 'number' && typeof price.currency === 'string') {
      value = { amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? 'year' };
    }
  } catch {
    value = null;
  }
  priceCache = { id: priceId, at: Date.now(), value };
  return value;
}

const iso = (seconds: number | undefined | null): string | null => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

function isRunning(state: BillingState): boolean {
  return state.subscriptionId !== null && state.status !== null && RUNNING.has(state.status);
}

function baseUrl(c: Ctx, config: BillingConfig): string {
  return (config.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, '');
}

function stripeOf(deps: AppDeps, config: BillingConfig): StripeClient {
  return createStripeClient(config.secretKey, deps.fetch ?? fetch);
}

function stripeFailure(err: unknown): never {
  if (err instanceof StripeError) {
    console.error('[billing] appel Stripe refusé', err.status, err.code);
    throw new UserApiError(502, 'billing_unavailable');
  }
  throw err;
}

/** Relit un abonnement chez Stripe (source de vérité) et l'enregistre sur son compte. Renvoie le compte, ou undefined. */
async function syncSubscription(stripe: StripeClient, users: UserRepo, subscriptionId: string, hintAccountId?: string): Promise<string | undefined> {
  const sub = await stripe.get<StripeSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const fromMeta = sub.metadata?.account_id ?? hintAccountId;
  let accountId = fromMeta !== undefined && (await users.billingAccountExists(fromMeta)) ? fromMeta : undefined;
  accountId ??= await users.accountOfBillingCustomer(sub.customer);
  if (accountId === undefined) return undefined;
  await users.applyBillingSubscription(
    accountId,
    {
      customerId: sub.customer,
      subscriptionId: sub.id,
      status: sub.status,
      paidUntil: iso(periodEnd(sub)),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    },
    nowIso(),
  );
  return accountId;
}

/**
 * Récompense du parrain (premier paiement de son filleul) : abonné en cours, sa prochaine échéance Stripe est repoussée
 * de `months` mois ; sinon (ou si Stripe refuse), son accès offert est prolongé d'autant.
 */
async function rewardInviter(stripe: StripeClient, users: UserRepo, config: BillingConfig, inviterId: string, inviteeId: string): Promise<void> {
  const months = config.referralRewardMonths;
  const now = nowIso();
  const state = await users.billingOf(inviterId);
  if (isRunning(state) && state.subscriptionId !== null) {
    const from = later(state.paidUntil, now) ?? now;
    const until = addMonths(from, months);
    try {
      await stripe.post(
        `/subscriptions/${encodeURIComponent(state.subscriptionId)}`,
        { trial_end: Math.floor(Date.parse(until) / 1000), proration_behavior: 'none' },
        `referral-reward-${inviteeId}`,
      );
      await syncSubscription(stripe, users, state.subscriptionId, inviterId);
      return;
    } catch (err) {
      console.error('[billing] report d échéance du parrain refusé, accès offert à la place', err instanceof StripeError ? err.code : 'inconnu');
    }
  }
  const from = later(later(state.paidUntil, config.freeUntil ?? null), now) ?? now;
  await users.extendBillingComp(inviterId, months, from, now);
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** Identifiant d'un champ Stripe qui peut être une chaîne ou un objet développé. */
const idOf = (v: unknown): string | undefined => str(v) ?? (isRecord(v) ? str(v.id) : undefined);

async function handleEvent(event: StripeEvent, stripe: StripeClient, users: UserRepo, config: BillingConfig): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const accountId = str(obj.client_reference_id);
      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.subscription);
      if (accountId === undefined || !(await users.billingAccountExists(accountId))) return;
      if (customerId !== undefined) await users.setBillingCustomer(accountId, customerId, nowIso());
      if (subscriptionId !== undefined) await syncSubscription(stripe, users, subscriptionId, accountId);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const subscriptionId = idOf(obj.id);
      if (subscriptionId !== undefined) await syncSubscription(stripe, users, subscriptionId);
      return;
    }
    case 'invoice.paid': {
      // API récentes : l'abonnement d'une facture est sous parent.subscription_details.
      const parent = isRecord(obj.parent) && isRecord(obj.parent.subscription_details) ? obj.parent.subscription_details.subscription : undefined;
      const subscriptionId = idOf(obj.subscription) ?? idOf(parent);
      const customerId = idOf(obj.customer);
      let accountId = subscriptionId === undefined ? undefined : await syncSubscription(stripe, users, subscriptionId);
      if (accountId === undefined && customerId !== undefined) accountId = await users.accountOfBillingCustomer(customerId);
      if (accountId === undefined) return;
      const paid = typeof obj.amount_paid === 'number' ? obj.amount_paid : 0;
      if (paid <= 0) return;
      const inviterId = await users.recordBillingFirstPayment(accountId, config.referralRewardMonths, nowIso());
      if (inviterId !== null) await rewardInviter(stripe, users, config, inviterId, accountId);
      return;
    }
    default:
      return;
  }
}

/** Accès du compte de la session à l'abonnement de soutien, pour /user/me : `required` vrai si l'app doit proposer l'abonnement. */
export function sessionSubscription(session: Session): { enabled: boolean; required: boolean } {
  const config = billingConfig();
  if (config === undefined) return { enabled: false, required: false };
  const reason = accessReason(config, session.account.isOwner, { ...EMPTY_BILLING, ...session.access }, Date.now());
  return { enabled: true, required: reason === null };
}

/** Routes /user/billing (montées dans le routeur /user : limites et erreurs communes). */
export function registerBillingUserRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const db = (): UserRepo => backend.users();

  /** État de l'abonnement du compte. Répond aussi sur un serveur sans abonnement (enabled: false). */
  router.get('/billing', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    const config = billingConfig();
    if (config === undefined) return sendJson(c, { enabled: false, access: true, reason: 'disabled' });
    const state = await users.billingOf(session.account.id);
    const reason = accessReason(config, session.account.isOwner, state, Date.now());
    const inviter = state.firstPaidAt === null ? await users.billingInviterOf(session.account.id) : null;
    return sendJson(c, {
      enabled: true,
      access: reason !== null,
      reason,
      accessUntil: reason === 'owner' ? null : accessUntil(config, state),
      subscribed: isRunning(state),
      status: state.status,
      paidUntil: state.paidUntil,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      compUntil: state.compUntil,
      freeUntil: config.freeUntil ?? null,
      canManage: session.lockedProfileId === null,
      hasCustomer: state.customerId !== null,
      price: await priceOf(stripeOf(deps, config), config.priceId),
      referral: {
        discount: inviter !== null && config.referralCouponId !== undefined,
        rewardMonths: config.referralRewardMonths,
        earnedMonths: await users.billingRewardMonths(session.account.id),
      },
    });
  });

  /** Ouvre une session Stripe Checkout (abonnement annuel) et renvoie son adresse. */
  router.post('/billing/checkout', async (c) => {
    const config = billingConfig();
    if (config === undefined) throw new UserApiError(404, 'billing_disabled');
    const users = db();
    const session = await sessionOf(users, c);
    assertNotLocked(session);
    const accountId = session.account.id;
    const state = await users.billingOf(accountId);
    if (isRunning(state) && !state.cancelAtPeriodEnd) throw new UserApiError(409, 'already_subscribed');
    if (isRunning(state)) throw new UserApiError(409, 'manage_in_portal');
    const now = Date.now();
    // Accès déjà acquis (offert, transition) : le premier prélèvement attend la fin de cet accès.
    const covered = later(state.compUntil, config.freeUntil ?? null);
    const trialEnd = covered !== null && Date.parse(covered) - now > MIN_TRIAL_MS ? Math.floor(Date.parse(covered) / 1000) : undefined;
    const discount = state.firstPaidAt === null && config.referralCouponId !== undefined && (await users.billingInviterOf(accountId)) !== null;
    const base = baseUrl(c, config);
    const stripe = stripeOf(deps, config);
    try {
      const checkout = await stripe.post<{ url?: string }>('/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: config.priceId, quantity: 1 }],
        client_reference_id: accountId,
        customer: state.customerId ?? undefined,
        customer_update: state.customerId !== null && config.automaticTax ? { address: 'auto', name: 'auto' } : undefined,
        metadata: { account_id: accountId },
        subscription_data: { metadata: { account_id: accountId }, trial_end: trialEnd },
        discounts: discount ? [{ coupon: config.referralCouponId }] : undefined,
        allow_promotion_codes: discount ? undefined : true,
        automatic_tax: config.automaticTax ? { enabled: true } : undefined,
        billing_address_collection: config.automaticTax ? 'required' : undefined,
        locale: 'auto',
        success_url: `${base}/?billing=success`,
        cancel_url: `${base}/?billing=cancel`,
      });
      if (checkout.url === undefined) throw new StripeError(502, 'no_url');
      return sendJson(c, { url: checkout.url });
    } catch (err) {
      return stripeFailure(err);
    }
  });

  /** Ouvre le portail client Stripe (carte, factures, résiliation). */
  router.post('/billing/portal', async (c) => {
    const config = billingConfig();
    if (config === undefined) throw new UserApiError(404, 'billing_disabled');
    const users = db();
    const session = await sessionOf(users, c);
    assertNotLocked(session);
    const state = await users.billingOf(session.account.id);
    if (state.customerId === null) throw new UserApiError(404, 'no_customer');
    try {
      const portal = await stripeOf(deps, config).post<{ url?: string }>('/billing_portal/sessions', {
        customer: state.customerId,
        return_url: `${baseUrl(c, config)}/?billing=portal`,
      });
      if (portal.url === undefined) throw new StripeError(502, 'no_url');
      return sendJson(c, { url: portal.url });
    } catch (err) {
      return stripeFailure(err);
    }
  });
}

/** Chemin du webhook Stripe (à déclarer dans le tableau de bord Stripe). */
const STRIPE_WEBHOOK_PATH = '/billing/stripe/webhook';

/** Webhook Stripe : signature vérifiée, événement traité une seule fois ; une erreur rend 500 pour que Stripe renvoie. */
export function registerBillingWebhook(app: App, deps: AppDeps, backend: UserBackend): void {
  app.post(STRIPE_WEBHOOK_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const config = billingConfig();
    if (config?.webhookSecret === undefined) return sendJson(c, { error: 'billing_disabled' }, 503);
    const raw = c.get('rawBody');
    if (raw === undefined || !(await verifyStripeSignature(c.req.header('stripe-signature'), raw, config.webhookSecret))) {
      return sendJson(c, { error: 'invalid_signature' }, 400);
    }
    const event = c.get('body') as StripeEvent | undefined;
    if (!isRecord(event) || typeof event.id !== 'string' || typeof event.type !== 'string' || !isRecord(event.data) || !isRecord(event.data.object)) {
      return sendJson(c, { error: 'invalid_event' }, 400);
    }
    const users = backend.users();
    if (!(await users.markBillingEvent(event.id, nowIso()))) return sendJson(c, { received: true, duplicate: true });
    try {
      await handleEvent(event, stripeOf(deps, config), users, config);
    } catch (err) {
      await users.unmarkBillingEvent(event.id).catch(() => undefined);
      console.error('[billing] événement non traité', event.type, err instanceof StripeError ? err.code : err instanceof Error ? err.name : 'inconnu');
      return sendJson(c, { error: 'retry' }, 500);
    }
    return sendJson(c, { received: true });
  });
}
