import { runtimeEnv } from '../platform/index.js';

/**
 * Réglages de l'abonnement de soutien (variables d'environnement, lues à la demande). Sans STRIPE_SECRET_KEY ni
 * STRIPE_PRICE_ID, l'abonnement est désactivé : tout compte a accès au service (serveur auto-hébergé).
 */
export interface BillingConfig {
  /** Clé secrète Stripe (sk_test_… ou sk_live_…). Ne jamais journaliser. */
  secretKey: string;
  /** Prix annuel récurrent (price_…). */
  priceId: string;
  /** Secret de signature du webhook (whsec_…) ; absent, le webhook répond 503. */
  webhookSecret: string | undefined;
  /** Coupon de bienvenue des filleuls (50 %, une fois : la première année à moitié prix). Absent : pas de remise. */
  referralCouponId: string | undefined;
  /** Accès libre pour tous jusqu'à cette date (ISO) : période de transition au lancement. */
  freeUntil: string | undefined;
  /** Mois offerts au parrain par filleul qui paie. */
  referralRewardMonths: number;
  /** TVA calculée par Stripe Tax (STRIPE_AUTOMATIC_TAX=1). */
  automaticTax: boolean;
  /** Adresse publique de l'app (retours de Stripe Checkout et du portail). */
  publicUrl: string | undefined;
}

const DEFAULT_REWARD_MONTHS = 6;

function value(name: string): string | undefined {
  const raw = runtimeEnv().get(name)?.trim();
  return raw ? raw : undefined;
}

function isoDate(name: string): string | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Configuration active, ou undefined si l'abonnement est désactivé. */
export function billingConfig(): BillingConfig | undefined {
  const secretKey = value('STRIPE_SECRET_KEY');
  const priceId = value('STRIPE_PRICE_ID');
  if (secretKey === undefined || priceId === undefined) return undefined;
  const months = Number(value('LASTADDON_REFERRAL_REWARD_MONTHS'));
  return {
    secretKey,
    priceId,
    webhookSecret: value('STRIPE_WEBHOOK_SECRET'),
    referralCouponId: value('STRIPE_REFERRAL_COUPON_ID'),
    freeUntil: isoDate('LASTADDON_BILLING_FREE_UNTIL'),
    referralRewardMonths: Number.isInteger(months) && months >= 0 && months <= 24 ? months : DEFAULT_REWARD_MONTHS,
    automaticTax: value('STRIPE_AUTOMATIC_TAX') === '1',
    publicUrl: value('LASTADDON_PUBLIC_URL'),
  };
}
