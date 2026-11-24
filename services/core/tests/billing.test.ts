import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessReason, EMPTY_BILLING, isAccessExempt } from '../src/billing/access.js';
import { encodeForm, hmacHex, verifyStripeSignature } from '../src/billing/stripe.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, inviteAndRegister, type Member } from './social-harness.js';
import { PASSWORD, request } from './user-harness.js';

/** Abonnement de soutien : contrôle d'accès, Stripe Checkout, webhook, parrainage (moitié prix du filleul, 6 mois au parrain). */

const WHSEC = 'whsec_test_secret';
const YEAR = 365 * 24 * 3600;

interface FakeSub {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
}

interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
}

/** Faux Stripe : enregistre les appels, sert prix, sessions et abonnements. */
function fakeStripe() {
  const calls: Call[] = [];
  const subs = new Map<string, FakeSub>();
  const state = { failDelete: false };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ method, path: url.pathname, form });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/prices/price_test') return json({ unit_amount: 2400, currency: 'eur', recurring: { interval: 'year' } });
    if (url.pathname === '/v1/checkout/sessions') return json({ url: 'https://checkout.stripe.com/c/pay/test' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ url: 'https://billing.stripe.com/p/session/test' });
    const sub = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
    if (sub !== null) {
      const found = subs.get(sub[1] ?? '');
      if (found === undefined) return json({ error: { code: 'resource_missing' } }, 404);
      if (method === 'DELETE' && state.failDelete) return json({ error: { type: 'api_error' } }, 500);
      if (method === 'DELETE') found.status = 'canceled';
      if (method === 'POST' && form.has('cancel_at_period_end')) found.cancel_at_period_end = form.get('cancel_at_period_end') === 'true';
      if (method === 'POST' && form.has('trial_end')) {
        found.trial_end = Number(form.get('trial_end'));
        found.current_period_end = found.trial_end;
        found.status = 'trialing';
      }
      return json(found);
    }
    return json({ error: { code: 'unexpected' } }, 500);
  }) as typeof fetch;
  return { calls, subs, state, fetchImpl };
}

let app: RunningApp;
let stripe: ReturnType<typeof fakeStripe>;
let owner: Member;
let bob: Member;
let carol: Member;

function enableBilling(extra: Record<string, string> = {}) {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('STRIPE_PRICE_ID', 'price_test');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WHSEC);
  vi.stubEnv('STRIPE_REFERRAL_COUPON_ID', 'coupon_half');
  vi.stubEnv('LASTADDON_PUBLIC_URL', 'https://app.example');
  vi.stubEnv('LASTADDON_BILLING_FREE_UNTIL', '');
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
}

async function sendEvent(event: { id: string; type: string; data: { object: Record<string, unknown> } }, secret = WHSEC) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(secret, `${t}.${raw}`);
  return request<{ received?: boolean; duplicate?: boolean; error?: string }>(app, 'POST', '/billing/stripe/webhook', {
    raw,
    headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' },
  });
}

async function accountId(member: Member): Promise<string> {
  return (await request<{ account: { id: string } }>(app, 'GET', '/user/me', { token: member.token })).body.account.id;
}

/** Abonnement actif pour `member` : session Checkout terminée puis facture payée. */
async function subscribe(member: Member, n: number, amountPaid = 2400) {
  const id = await accountId(member);
  stripe.subs.set(`sub_${n}`, {
    id: `sub_${n}`,
    customer: `cus_${n}`,
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + YEAR,
    trial_end: null,
    cancel_at_period_end: false,
    metadata: { account_id: id },
  });
  await sendEvent({ id: `evt_co_${n}`, type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: `cus_${n}`, subscription: `sub_${n}` } } });
  await sendEvent({ id: `evt_inv_${n}`, type: 'invoice.paid', data: { object: { customer: `cus_${n}`, subscription: `sub_${n}`, amount_paid: amountPaid } } });
}

beforeEach(async () => {
  stripe = fakeStripe();
  app = await startApp({ fetch: stripe.fetchImpl });
  owner = await bootstrapOwner(app, 'alice');
  bob = await inviteAndRegister(app, owner, 'bob');
  carol = await inviteAndRegister(app, bob, 'carol');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

describe('règles d accès (unitaires)', () => {
  const config = { secretKey: 'sk', priceId: 'p', webhookSecret: undefined, referralCouponId: undefined, freeUntil: undefined, referralRewardMonths: 6, automaticTax: false, publicUrl: undefined };
  const now = Date.parse('2027-01-01T00:00:00Z');

  it('serveur sans Stripe : accès libre ; propriétaire : toujours', () => {
    expect(accessReason(undefined, false, EMPTY_BILLING, now)).toBe('disabled');
    expect(accessReason(config, true, EMPTY_BILLING, now)).toBe('owner');
    expect(accessReason(config, false, EMPTY_BILLING, now)).toBeNull();
  });

  it('abonnement en cours (avec 3 jours de grâce), accès offert, période de transition', () => {
    expect(accessReason(config, false, { ...EMPTY_BILLING, status: 'active', paidUntil: '2026-12-30T00:00:00.000Z' }, now)).toBe('paid');
    expect(accessReason(config, false, { ...EMPTY_BILLING, status: 'active', paidUntil: '2026-12-20T00:00:00.000Z' }, now)).toBeNull();
    expect(accessReason(config, false, { ...EMPTY_BILLING, status: 'canceled', paidUntil: '2027-06-01T00:00:00.000Z' }, now)).toBeNull();
    expect(accessReason(config, false, { ...EMPTY_BILLING, compUntil: '2027-02-01T00:00:00.000Z' }, now)).toBe('comp');
    expect(accessReason({ ...config, freeUntil: '2027-03-01T00:00:00.000Z' }, false, EMPTY_BILLING, now)).toBe('free');
  });

  it('routes exemptées : compte, connexion, abonnement, administration', () => {
    expect(isAccessExempt('GET', '/user/me')).toBe(true);
    expect(isAccessExempt('GET', '/user/billing')).toBe(true);
    expect(isAccessExempt('POST', '/user/billing/checkout')).toBe(true);
    expect(isAccessExempt('DELETE', '/user/account')).toBe(true);
    expect(isAccessExempt('GET', '/user/profiles')).toBe(false);
    expect(isAccessExempt('GET', '/user/account/config')).toBe(false);
  });

  it('signature des webhooks et encodage des formulaires', async () => {
    const raw = '{"id":"evt"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(WHSEC, `${t}.${raw}`);
    expect(await verifyStripeSignature(`t=${t},v1=${sig}`, raw, WHSEC)).toBe(true);
    expect(await verifyStripeSignature(`t=${t},v1=${sig}`, raw, 'whsec_autre')).toBe(false);
    expect(await verifyStripeSignature(`t=${t - 600},v1=${await hmacHex(WHSEC, `${t - 600}.${raw}`)}`, raw, WHSEC)).toBe(false);
    expect(decodeURIComponent(encodeForm({ a: [{ b: 1 }], c: { d: 'x' }, e: undefined }))).toBe('a[0][b]=1&c[d]=x');
  });
});

describe('contrôle d accès', () => {
  it('sans configuration Stripe, rien ne change (auto-hébergement)', async () => {
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(200);
    const billing = await request<{ enabled: boolean; access: boolean }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(billing.body).toMatchObject({ enabled: false, access: true });
    const me = await request<{ subscription: unknown }>(app, 'GET', '/user/me', { token: bob.token });
    expect(me.body.subscription).toEqual({ enabled: false, required: false });
  });

  it('abonnement activé : 402 sans accès, mais compte, /me et abonnement restent ouverts ; le propriétaire passe', async () => {
    enableBilling();
    const blocked = await request<{ error: string }>(app, 'GET', '/user/profiles', { token: bob.token });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe('subscription_required');
    const me = await request<{ subscription: unknown }>(app, 'GET', '/user/me', { token: bob.token });
    expect(me.status).toBe(200);
    expect(me.body.subscription).toEqual({ enabled: true, required: true });
    const billing = await request<{ access: boolean; price: unknown }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(billing.body).toMatchObject({ enabled: true, access: false, price: { amount: 2400, currency: 'eur', interval: 'year' } });
    expect((await request(app, 'GET', '/user/profiles', { token: owner.token })).status).toBe(200);
  });

  it('période de transition (LASTADDON_BILLING_FREE_UNTIL) : accès pour tous jusqu à la date', async () => {
    enableBilling({ LASTADDON_BILLING_FREE_UNTIL: new Date(Date.now() + 30 * 86400_000).toISOString() });
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(200);
  });
});

describe('paiement', () => {
  it('Checkout : prix annuel, compte lié, retour vers l app ; filleul : coupon moitié prix', async () => {
    enableBilling();
    const res = await request<{ url: string }>(app, 'POST', '/user/billing/checkout', { token: carol.token });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/c/pay/test');
    const call = stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
    expect(call?.form.get('mode')).toBe('subscription');
    expect(call?.form.get('line_items[0][price]')).toBe('price_test');
    expect(call?.form.get('client_reference_id')).toBe(await accountId(carol));
    expect(call?.form.get('discounts[0][coupon]')).toBe('coupon_half');
    expect(call?.form.get('success_url')).toBe('https://app.example/?billing=success');
    expect(call?.form.has('subscription_data[trial_end]')).toBe(false);
  });

  it('accès déjà acquis (transition) : le premier prélèvement attend sa fin', async () => {
    const until = new Date(Date.now() + 60 * 86400_000).toISOString();
    enableBilling({ LASTADDON_BILLING_FREE_UNTIL: until });
    await request(app, 'POST', '/user/billing/checkout', { token: bob.token });
    const call = stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
    expect(Number(call?.form.get('subscription_data[trial_end]'))).toBe(Math.floor(Date.parse(until) / 1000));
  });

  it('webhook : signature refusée, puis abonnement enregistré et accès ouvert ; un événement rejoué est ignoré', async () => {
    enableBilling();
    const bad = await sendEvent({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } }, 'whsec_faux');
    expect(bad.status).toBe(400);
    await subscribe(bob, 1);
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(200);
    const billing = await request<{ subscribed: boolean; reason: string }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(billing.body).toMatchObject({ subscribed: true, reason: 'paid' });
    const again = await sendEvent({ id: 'evt_co_1', type: 'checkout.session.completed', data: { object: {} } });
    expect(again.body).toMatchObject({ duplicate: true });
    expect((await request(app, 'POST', '/user/billing/checkout', { token: bob.token })).status).toBe(409);
    const portal = await request<{ url: string }>(app, 'POST', '/user/billing/portal', { token: bob.token });
    expect(portal.body.url).toBe('https://billing.stripe.com/p/session/test');
  });

  it('résiliation (subscription.deleted) : l accès se ferme', async () => {
    enableBilling();
    await subscribe(bob, 1);
    const sub = stripe.subs.get('sub_1');
    if (sub !== undefined) sub.status = 'canceled';
    await sendEvent({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(402);
  });
});

describe('parrainage', () => {
  it('parrain abonné : le premier paiement du filleul repousse son échéance de 6 mois (une seule fois)', async () => {
    enableBilling();
    await subscribe(bob, 1);
    const before = stripe.subs.get('sub_1')?.current_period_end ?? 0;
    await subscribe(carol, 2, 1200);
    const after = stripe.subs.get('sub_1')?.current_period_end ?? 0;
    const days = (after - before) / 86400;
    expect(days).toBeGreaterThan(180);
    expect(days).toBeLessThan(185);
    const update = stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1');
    expect(update?.form.get('proration_behavior')).toBe('none');
    // Deuxième facture du filleul : pas de nouvelle récompense.
    await sendEvent({ id: 'evt_inv_2b', type: 'invoice.paid', data: { object: { customer: 'cus_2', subscription: 'sub_2', amount_paid: 2400 } } });
    expect(stripe.calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1')).toHaveLength(1);
    const billing = await request<{ referral: { earnedMonths: number } }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(billing.body.referral.earnedMonths).toBe(6);
  });

  it('parrain non abonné : 6 mois d accès offert ; la remise ne vaut que pour le filleul', async () => {
    enableBilling();
    await subscribe(carol, 2, 1200);
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(200);
    const billing = await request<{ reason: string; compUntil: string; referral: { discount: boolean } }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(billing.body.reason).toBe('comp');
    expect(Date.parse(billing.body.compUntil) - Date.now()).toBeGreaterThan(180 * 86400_000);
    // Le compte de bob a été invité par le propriétaire : remise de filleul aussi.
    expect(billing.body.referral.discount).toBe(true);
  });

  it('facture à 0 € (essai) : pas de récompense', async () => {
    enableBilling();
    await subscribe(carol, 2, 0);
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(402);
  });
});

describe('résiliation depuis l app', () => {
  it('résilier puis reprendre : fin de période, accès gardé, état relu chez Stripe', async () => {
    enableBilling();
    await subscribe(bob, 1);
    const cancel = await request<{ cancelAtPeriodEnd: boolean; paidUntil: string }>(app, 'POST', '/user/billing/cancel', { token: bob.token, body: {} });
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelAtPeriodEnd).toBe(true);
    expect(stripe.calls.some((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1' && c.form.get('cancel_at_period_end') === 'true')).toBe(true);
    const after = await request<{ cancelAtPeriodEnd: boolean; access: boolean }>(app, 'GET', '/user/billing', { token: bob.token });
    expect(after.body).toMatchObject({ cancelAtPeriodEnd: true, access: true });
    expect((await request(app, 'GET', '/user/profiles', { token: bob.token })).status).toBe(200);
    const resume = await request<{ cancelAtPeriodEnd: boolean }>(app, 'POST', '/user/billing/resume', { token: bob.token, body: {} });
    expect(resume.body.cancelAtPeriodEnd).toBe(false);
    expect((await request<{ cancelAtPeriodEnd: boolean }>(app, 'GET', '/user/billing', { token: bob.token })).body.cancelAtPeriodEnd).toBe(false);
  });

  it('sans abonnement : 409 ; serveur auto-hébergé : 404', async () => {
    expect((await request(app, 'POST', '/user/billing/cancel', { token: bob.token, body: {} })).status).toBe(404);
    enableBilling();
    const res = await request<{ error: string }>(app, 'POST', '/user/billing/cancel', { token: owner.token, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_subscribed');
  });

  it('supprimer son compte arrête l abonnement chez Stripe', async () => {
    enableBilling();
    await subscribe(bob, 1);
    const res = await request(app, 'DELETE', '/user/account', { token: bob.token, body: { password: PASSWORD } });
    expect(res.status).toBe(204);
    expect(stripe.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/sub_1')).toBe(true);
    expect(stripe.subs.get('sub_1')?.status).toBe('canceled');
  });

  it('suppression du compte refusée si Stripe ne répond pas (aucun abonnement orphelin)', async () => {
    enableBilling();
    await subscribe(bob, 1);
    stripe.state.failDelete = true;
    const res = await request(app, 'DELETE', '/user/account', { token: bob.token, body: { password: PASSWORD } });
    expect(res.status).toBe(502);
    expect((await request(app, 'GET', '/user/me', { token: bob.token })).status).toBe(200);
  });
});

describe('migration 36', () => {
  it('ne touche pas aux quotas de billets (règle propre au service en ligne, réglée dans /admin)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { wrapSqlite } = await import('../src/platform/node/user-db.js');
    const { MIGRATIONS, migrate } = await import('../src/user/migrations.js');
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db, MIGRATIONS.filter((m) => m.version < 36));
    db.prepare('INSERT INTO accounts (id, username, password_hash, is_owner, created_at, invite_quota) VALUES (?, ?, ?, 0, ?, ?)').run('a', 'a', 'x', '2026-01-01', 4);
    migrate(db);
    expect(Number(db.prepare('SELECT invite_quota AS q FROM accounts WHERE id = ?').get('a')?.q)).toBe(4);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'invite_default_quota'").get()).toBeUndefined();
  });
});
