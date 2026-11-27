/* Abonnement de soutien (service en ligne) : écran « Activer ton accès » quand le compte n'a plus accès (402), et carte
 * « Abonnement de soutien » des réglages. Le paiement passe par Stripe Checkout ; la résiliation et la reprise se font
 * dans la carte ; carte bancaire et factures dans le portail client Stripe. Un serveur auto-hébergé n'a pas d'abonnement
 * (GET /user/billing répond enabled: false) : rien de tout cela ne s'affiche. */
import { isAndroidApp } from '../data/config';
import { billing as readBilling, billingCancel, billingCheckout, billingPortal, billingResume, UserApiError } from '../data/userApi';
import { connectShell, isShellEnvironment, openExternal } from '../player/shell';
import { brand } from './fragments.js';
import { card, rowHTML } from './settings-ui.js';
import { esc } from './util.js';
import { t as tr, intlLocale } from '../i18n';

const SOURCE_URL = 'https://github.com/gtko/laststream';
const SPIN = '<svg class="auth-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9"/></svg>';

/** Montant Stripe (centimes) en texte : « 24 € ». */
function money(amount, currency) {
  try {
    return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: (currency || 'eur').toUpperCase(), maximumFractionDigits: amount % 100 === 0 ? 0 : 2 }).format(amount / 100);
  } catch {
    return (amount / 100) + ' ' + (currency || '').toUpperCase();
  }
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const per = (interval) => (interval === 'month' ? 'mois' : 'an');
/** Prix annuel affiché (24 € par défaut si Stripe ne répond pas). */
const priceOf = (b) => b && b.price ? b.price : { amount: 2400, currency: 'eur', interval: 'year' };

/** Ouvre une page Stripe : même onglet dans un navigateur (retour automatique), navigateur du système dans les apps. */
function openStripe(url) {
  if (isAndroidApp()) { window.open(url, '_system'); return 'outside'; }
  // App Tauri : une nouvelle fenêtre s'ouvre dans le navigateur du système.
  if ('__TAURI_INTERNALS__' in window) { window.open(url, '_blank', 'noopener'); return 'outside'; }
  if (isShellEnvironment()) {
    connectShell().then((t) => { if (t) openExternal(t, url); else window.open(url, '_blank', 'noopener'); }, () => window.open(url, '_blank', 'noopener'));
    return 'outside';
  }
  location.assign(url);
  return 'same';
}

function errorText(err) {
  if (err instanceof UserApiError) {
    if (err.code === 'already_subscribed') return tr('Ton abonnement est déjà actif.');
    if (err.code === 'manage_in_portal') return tr('Ton abonnement est résilié mais encore en cours : réactive-le depuis les réglages (« Reprendre mon abonnement »).');
    if (err.code === 'amount_too_low') return tr('Le tarif « J’adore » commence au prix de base.');
    if (err.code === 'amount_too_high' || err.code === 'invalid_amount') return tr('Ce montant n’est pas accepté : choisis un nombre entier d’euros.');
    if (err.code === 'not_subscribed') return tr('Aucun abonnement en cours sur ce compte.');
    if (err.code === 'billing_unavailable' || err.code === 'network') return tr('Le paiement est momentanément indisponible. Réessaie dans un instant.');
    if (err.code === 'profile_locked') return tr('Seul le titulaire du compte peut gérer l’abonnement.');
  }
  return tr('Une erreur est survenue. Réessaie dans un instant.');
}

/** Écran d'attente pendant la lecture de l'état de l'abonnement. */
export function subscribeLoadingHTML() {
  return '<div class="auth-card auth-panel"><div class="auth-brand">' + brand() + '</div><p class="auth-lead">' + tr('{SPIN} Un instant…', { SPIN }) + '</p></div>';
}

/** Lignes communes : ce que couvre l'abonnement, pas d'extensions fournies, code libre. */
function factsHTML() {
  return '<ul class="sub-facts">' +
    '<li>' + tr('Profils, bibliothèque et progression synchronisés sur tous tes écrans, pour tout ton foyer.') + '</li>' +
    '<li>' + tr('Laststream ne fournit ni n’installe aucune extension Stremio : tu ajoutes toi-même les sources que tu utilises.') + '</li>' +
    '<li>' + tr('Le code est public : tu peux aussi') + ' <a href="' + SOURCE_URL + '" target="_blank" rel="noopener">' + tr('installer Laststream sur ton propre serveur') + '</a>' + tr(', gratuitement.') + '</li>' +
    '</ul>';
}

// ---------- Choix du tarif : « Soutenir » (prix de base) ou « Soutenir, J'adore » (prix libre, au moins le prix de base) ----------

/** Choix en cours, partagé entre l'écran d'activation et la carte des réglages. */
const tier = { kind: 'standard', euros: '' };
const QUICK_EUROS = [36, 50, 100];

const minEuros = (p) => Math.ceil(p.amount / 100);
/** Montant annuel choisi en centimes, undefined pour le tarif de base, ou null si la saisie n'est pas valable. */
function chosenCents(p, max) {
  if (tier.kind !== 'jadore') return undefined;
  const euros = Number(tier.euros.replace(',', '.').trim());
  if (!Number.isInteger(euros) || euros < minEuros(p) || euros * 100 > (max || 99999999)) return null;
  return euros * 100 === p.amount ? undefined : euros * 100;
}

/** Texte du bouton de paiement selon le tarif choisi. */
function ctaText(p, prefix, max) {
  const cents = chosenCents(p, max);
  if (cents === null) return tr('{prefix} · choisis ton montant', { prefix });
  return tr('{prefix} · {money} par {interval}', { prefix, money: money(cents === undefined ? p.amount : cents, p.currency), interval: per(p.interval) });
}

/** Les deux tarifs, sous forme de choix ; `half` : remise filleul (tarif de base seulement). */
function tiersHTML(p, half) {
  if (!tier.euros) tier.euros = String(Math.max(50, minEuros(p)));
  const opt = (kind, title, price, sub) =>
    '<button type="button" class="sub-tier' + (tier.kind === kind ? ' is-on' : '') + '" role="radio" aria-checked="' + (tier.kind === kind) + '" data-tier="' + kind + '">' +
      '<span class="sub-tier-k">' + title + '</span><span class="sub-tier-p">' + esc(price) + '</span><span class="sub-tier-s">' + esc(sub) + '</span></button>';
  const base = money(p.amount, p.currency);
  const monthly = p.interval === 'year' ? tr('soit {money} par mois', { money: money(Math.round(p.amount / 12), p.currency) }) : tr('par {interval}', { interval: per(p.interval) });
  const chips = QUICK_EUROS.filter((e) => e > minEuros(p)).map((e) => '<button type="button" class="sub-chip" data-tier-pick="' + e + '">' + esc(money(e * 100, p.currency)) + '</button>').join('');
  return '<div class="sub-tiers" role="radiogroup" aria-label="' + tr('Tarif') + '">' +
      opt('standard', tr('Soutenir'), tr('{base} par {interval}', { base, interval: per(p.interval) }), half ? tr('moitié prix la 1re année avec ton billet') : monthly) +
      opt('jadore', tr('Soutenir, J’adore'), tr('Ton prix, dès {base}', { base }), tr('pour aller plus loin, sans plafond')) +
    '</div>' +
    '<div class="sub-jadore"' + (tier.kind === 'jadore' ? '' : ' hidden') + '>' +
      '<label class="sub-jadore-l" for="sub-amount">' + tr('Ton montant par {interval}', { interval: per(p.interval) }) + '</label>' +
      '<div class="sub-jadore-row"><div class="auth-input sub-amount-input"><input id="sub-amount" type="text" inputmode="numeric" autocomplete="off" value="' + esc(tier.euros) + '" data-tier-amount aria-describedby="sub-amount-hint"><span class="sub-cur">€</span></div>' + chips + '</div>' +
      '<p class="sub-jadore-hint" id="sub-amount-hint">' + tr('{base} minimum, en euros entiers. Le même montant est prélevé chaque {v}, résiliable quand tu veux.', { base: esc(base), v: (p.interval === 'month' ? 'mois' : tr('année')) }) +
        (half ? ' ' + tr('La remise du billet de parrainage vaut pour le tarif de base.') : '') + '</p>' +
    '</div>';
}

/** Met à jour le choix et le bouton sans redessiner (la saisie garde le focus). */
function syncTier(hostEl, p, max) {
  hostEl.querySelectorAll('[data-tier]').forEach((b) => {
    const on = b.getAttribute('data-tier') === tier.kind;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  const box = hostEl.querySelector('.sub-jadore');
  if (box) box.hidden = tier.kind !== 'jadore';
  const cta = hostEl.querySelector('[data-tier-cta]');
  if (cta && !cta.hasAttribute('data-busy')) {
    cta.textContent = ctaText(p, cta.getAttribute('data-tier-cta') || '', max);
    cta.toggleAttribute('disabled', chosenCents(p, max) === null);
  }
  const input = hostEl.querySelector('[data-tier-amount]');
  if (input) input.setAttribute('aria-invalid', String(tier.kind === 'jadore' && chosenCents(p, max) === null));
}

/** Écran bloquant « Activer ton accès » (compte sans abonnement en cours sur le service en ligne). */
function subscribeHTML(b, state) {
  const p = priceOf(b);
  const half = b && b.referral && b.referral.discount;
  const canManage = !b || b.canManage !== false;
  const expired = b && (b.status === 'canceled' || b.status === 'unpaid' || b.status === 'past_due' || b.status === 'incomplete_expired');
  const lead = expired
    ? tr('Ton abonnement de soutien est arrivé à échéance. Renouvelle-le pour retrouver tes profils et ta bibliothèque.')
    : tr('Laststream en ligne est financé par celles et ceux qui l’utilisent. L’abonnement de soutien garde les serveurs allumés.');
  const offer = half
    ? '<p class="sub-offer">' + tr('<strong>Invité par un ami :</strong> ta première année est à moitié prix, {money} au lieu de {amount}.', { money: esc(money(Math.round(p.amount / 2), p.currency)), amount: esc(money(p.amount, p.currency)) }) + '</p>'
    : '';
  const msg = state.msg ? '<p class="auth-msg' + (state.info ? ' is-info' : '') + '" role="status">' + esc(state.msg) + '</p>' : '';
  const max = b && b.maxAmount;
  const invalid = chosenCents(p, max) === null;
  const actions = canManage
    ? tiersHTML(p, half) +
      '<button type="button" class="btn btn-primary auth-btn" data-sub-checkout data-tier-cta="Activer mon accès"' + (state.busy ? ' data-busy' : '') + (state.busy || invalid ? ' disabled' : '') + '>' +
        (state.busy === 'checkout' ? SPIN + tr('Ouverture du paiement…') : esc(ctaText(p, tr('Activer mon accès'), max))) + '</button>' +
      (b && b.hasCustomer ? '<button type="button" class="btn auth-btn auth-btn-alt" data-sub-portal' + (state.busy ? ' disabled' : '') + '>' + tr('Gérer mon abonnement') + '</button>' : '') +
      '<button type="button" class="auth-link" data-sub-check' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'check' ? tr('Vérification…') : tr('J’ai payé, vérifier')) + '</button>'
    : '<p class="auth-note">' + tr('Seul le titulaire du compte peut activer l’abonnement. Il couvre tout le foyer : demande-lui de le renouveler.') + '</p>' +
      '<button type="button" class="auth-link" data-sub-check>' + tr('Vérifier à nouveau') + '</button>';
  return '<div class="auth-card auth-panel sub-panel" data-tier-host><div class="auth-brand">' + brand() + '</div>' +
    '<div class="auth-head"><h1 class="auth-title">' + tr('Activer ton accès') + '</h1><p class="auth-lead">' + esc(lead) + '</p></div>' +
    offer + factsHTML() + msg + '<div class="sub-actions">' + actions + '</div>' +
    '<button type="button" class="btn btn-ghost" data-auth-signout>' + tr('Se déconnecter') + '</button></div>';
}

let current = null;
let state = { busy: '', msg: '', info: false };
let host = null;
let focusBound = false;

function paint() {
  // eslint-disable-next-line laststream/no-html-sink -- gabarit local, textes dynamiques échappés par esc (prix, messages)
  if (host) host.innerHTML = subscribeHTML(current, state);
}

/** Relit l'état ; accès retrouvé : rechargement (l'app démarre normalement). */
async function check(quiet) {
  try {
    current = await readBilling();
  } catch (err) {
    if (!quiet) { state = { busy: '', msg: errorText(err), info: false }; paint(); }
    return false;
  }
  if (current.access) { location.reload(); return true; }
  return false;
}

/** Retour de Stripe Checkout (?billing=success) : le webhook peut arriver quelques secondes après ; on relit plusieurs fois. */
async function pollAfterPayment() {
  state = { busy: 'check', msg: tr('Paiement reçu, activation de ton accès…'), info: true };
  paint();
  for (let i = 0; i < 8; i++) {
    if (await check(true)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  state = { busy: '', msg: tr('Le paiement est en cours de confirmation. Réessaie « J’ai payé, vérifier » dans une minute.'), info: true };
  paint();
}

/** Affiche l'écran d'abonnement dans `root` (conteneur #auth). */
export async function mountSubscribe(root) {
  host = root;
  state = { busy: '', msg: '', info: false };
  const params = new URLSearchParams(location.search);
  const back = params.get('billing');
  if (back) {
    params.delete('billing');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  try {
    current = await readBilling();
  } catch {
    current = null;
  }
  if (current && current.access) { location.reload(); return; }
  if (back === 'cancel') state = { busy: '', msg: tr('Paiement annulé : rien n’a été prélevé.'), info: true };
  paint();
  if (back === 'success') void pollAfterPayment();
  // Paiement fait dans le navigateur du système : au retour dans l'app, on vérifie.
  if (!focusBound) {
    focusBound = true;
    window.addEventListener('focus', () => { if (host && !host.hidden && host.querySelector('.sub-panel')) void check(true); });
  }
}

async function startCheckout() {
  state = { busy: 'checkout', msg: '', info: false };
  paint();
  try {
    const cents = chosenCents(priceOf(current), current && current.maxAmount);
    if (cents === null) throw new UserApiError(400, 'invalid_amount');
    const { url } = await billingCheckout(cents);
    if (openStripe(url) === 'outside') state = { busy: '', msg: tr('Termine le paiement dans ton navigateur, puis reviens ici.'), info: true };
  } catch (err) {
    state = { busy: '', msg: errorText(err), info: false };
  }
  paint();
}

async function openPortal(after) {
  try {
    const { url } = await billingPortal();
    openStripe(url);
  } catch (err) {
    after(errorText(err));
  }
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const tierBtn = t.closest('[data-tier], [data-tier-pick]');
  const tierHost = tierBtn && tierBtn.closest('[data-tier-host]');
  if (tierBtn && tierHost) {
    const pick = tierBtn.getAttribute('data-tier-pick');
    if (pick) { tier.kind = 'jadore'; tier.euros = pick; const input = tierHost.querySelector('[data-tier-amount]'); if (input) input.value = pick; }
    else tier.kind = tierBtn.getAttribute('data-tier') === 'jadore' ? 'jadore' : 'standard';
    const b = tierHost.classList.contains('sub-panel') ? current : cardBilling;
    syncTier(tierHost, priceOf(b), b && b.maxAmount);
    if (tier.kind === 'jadore' && !pick) { const input = tierHost.querySelector('[data-tier-amount]'); if (input) input.focus(); }
    return;
  }
  if (t.closest('.sub-panel')) {
    if (t.closest('[data-sub-checkout]')) { void startCheckout(); return; }
    if (t.closest('[data-sub-portal]')) { void openPortal((msg) => { state = { busy: '', msg, info: false }; paint(); }); return; }
    if (t.closest('[data-sub-check]')) {
      state = { busy: 'check', msg: '', info: false };
      paint();
      void check(false).then((ok) => { if (!ok && state.busy) { state = { busy: '', msg: tr('Pas encore d’abonnement actif sur ce compte.'), info: true }; paint(); } });
    }
    return;
  }
  if (t.closest('[data-bill-checkout]')) {
    const cents = chosenCents(priceOf(cardBilling), cardBilling && cardBilling.maxAmount);
    if (cents === null) { setCardMsg(errorText(new UserApiError(400, 'invalid_amount'))); return; }
    void billingCheckout(cents).then(({ url }) => openStripe(url), (err) => setCardMsg(errorText(err)));
    return;
  }
  if (t.closest('[data-bill-portal]')) { void openPortal(setCardMsg); return; }
  if (t.closest('[data-bill-cancel]')) { cardConfirm = true; void refreshBillingCard(); return; }
  if (t.closest('[data-bill-keep]')) { cardConfirm = false; void refreshBillingCard(); return; }
  if (t.closest('[data-bill-cancel-yes]')) { void changeCancel(true); return; }
  if (t.closest('[data-bill-resume]')) void changeCancel(false);
});

document.addEventListener('input', (e) => {
  const input = e.target instanceof HTMLInputElement && e.target.hasAttribute('data-tier-amount') ? e.target : null;
  const tierHost = input && input.closest('[data-tier-host]');
  if (!input || !tierHost) return;
  tier.kind = 'jadore';
  tier.euros = input.value;
  const b = tierHost.classList.contains('sub-panel') ? current : cardBilling;
  syncTier(tierHost, priceOf(b), b && b.maxAmount);
});

// ---------- Réglages : carte « Abonnement de soutien » ----------

/** Dernier état lu pour la carte (prix, plafond du tarif « J'adore »). */
let cardBilling = null;

/** Vrai pendant la confirmation de la résiliation (deuxième clic). */
let cardConfirm = false;
let cardBusy = false;

/** Résilie (fin de période) ou reprend l'abonnement, puis relit la carte. */
async function changeCancel(cancel) {
  if (cardBusy) return;
  cardBusy = true;
  setCardMsg(cancel ? tr('Résiliation…') : tr('Reprise de l’abonnement…'));
  try {
    const r = await (cancel ? billingCancel() : billingResume());
    cardConfirm = false;
    await refreshBillingCard();
    setCardMsg(cancel
      ? tr('C’est résilié : plus aucun prélèvement. Ton accès reste ouvert jusqu’au {paidUntil}.', { paidUntil: day(r.paidUntil) })
      : tr('Ton abonnement reprend : il sera renouvelé le {paidUntil}.', { paidUntil: day(r.paidUntil) }));
  } catch (err) {
    setCardMsg(errorText(err));
  } finally {
    cardBusy = false;
  }
}

function setCardMsg(msg) {
  const m = document.querySelector('[data-bill-msg]');
  if (m) m.textContent = msg;
}

/** Phrase d'état de l'abonnement (réglages). */
function statusText(b) {
  if (b.reason === 'owner') return tr('Compte propriétaire du serveur : accès sans abonnement.');
  if (b.reason === 'paid' && b.subscribed) {
    if (b.cancelAtPeriodEnd) return tr('Abonnement résilié : ton accès reste ouvert jusqu’au {paidUntil}.', { paidUntil: day(b.paidUntil) });
    if (b.status === 'trialing' && b.paidUntil) return tr('Abonnement actif. Prochain prélèvement le {paidUntil}.', { paidUntil: day(b.paidUntil) });
    if (b.status === 'past_due') return tr('Le dernier paiement a échoué : mets à jour ta carte pour garder ton accès.');
    return tr('Abonnement actif, renouvelé le {paidUntil}.', { paidUntil: day(b.paidUntil) });
  }
  if (b.reason === 'comp') return tr('Accès offert jusqu’au {compUntil}.', { compUntil: day(b.compUntil) });
  if (b.reason === 'free') return tr('Accès offert à tous jusqu’au {freeUntil}, pendant le lancement de l’abonnement.', { freeUntil: day(b.freeUntil) });
  return tr('Pas d’abonnement en cours.');
}

function billingCardBody(b) {
  const p = priceOf(b);
  const manage = b.canManage !== false;
  const buttons = [];
  const canSubscribe = manage && !b.subscribed && b.reason !== 'owner';
  const half = b.referral && b.referral.discount;
  const subscribeRow = canSubscribe
    ? '<div class="sub-card-tiers" data-tier-host>' + tiersHTML(p, half) +
        '<button type="button" class="btn btn-primary btn-sm" data-bill-checkout data-tier-cta="S’abonner"' + (chosenCents(p, b.maxAmount) === null ? ' disabled' : '') + '>' + esc(ctaText(p, tr('S’abonner'), b.maxAmount)) + '</button></div>'
    : '';
  if (manage && b.hasCustomer) buttons.push('<button type="button" class="btn btn-ghost btn-sm" data-bill-portal>' + tr('Carte et factures') + '</button>');
  const active = manage && b.subscribed && b.reason === 'paid';
  let cancelRow = '';
  if (active && b.cancelAtPeriodEnd) {
    cancelRow = rowHTML(tr('Résiliation'), tr('Plus aucun prélèvement. Tu peux changer d’avis jusqu’au {paidUntil}.', { paidUntil: day(b.paidUntil) }), () => '<button type="button" class="btn btn-primary btn-sm" data-bill-resume>' + tr('Reprendre mon abonnement') + '</button>');
  } else if (active && cardConfirm) {
    cancelRow = rowHTML(tr('Résilier ?'), tr('Plus rien ne sera prélevé. Ton accès reste ouvert jusqu’au {paidUntil}, puis l’app te proposera de te réabonner. Tes profils et ta bibliothèque sont gardés.', { paidUntil: day(b.paidUntil) }),
      () => '<button type="button" class="btn btn-ghost btn-sm sub-danger" data-bill-cancel-yes>' + tr('Confirmer la résiliation') + '</button><button type="button" class="btn btn-ghost btn-sm" data-bill-keep>' + tr('Garder mon abonnement') + '</button>');
  } else if (active) {
    cancelRow = rowHTML(tr('Résiliation'), tr('Sans engagement : tu arrêtes quand tu veux, l’accès reste ouvert jusqu’à la fin de la période payée.'), () => '<button type="button" class="btn btn-ghost btn-sm" data-bill-cancel>' + tr('Résilier') + '</button>');
  }
  const r = b.referral;
  const referral = r && r.rewardMonths > 0
    ? rowHTML(tr('Parrainage'), tr('Chaque ami qui s’abonne avec un de tes billets t’offre {rewardMonths} mois, et paie sa première année à moitié prix.', { rewardMonths: r.rewardMonths }), () => '<span class="set-val">' + (r.earnedMonths > 0 ? tr('{earnedMonths} mois gagnés', { earnedMonths: r.earnedMonths }) : tr('Aucun mois gagné')) + '</span>')
    : '';
  return rowHTML(tr('État'), statusText(b), () => buttons.join('')) + subscribeRow + cancelRow + referral +
    '<p class="set-hint" data-bill-msg role="status"></p>' +
    '<p class="set-hint">' + tr('L’abonnement de soutien couvre tout ton foyer. Laststream ne fournit aucune extension Stremio : tes sources restent les tiennes. Le code est public sur') + ' <a href="' + SOURCE_URL + '" target="_blank" rel="noopener">GitHub</a>.</p>';
}

/** Emplacement de la carte (rempli par refreshBillingCard ; vide sur un serveur sans abonnement). */
export function billingCardSlot() {
  return '<div data-bill-slot></div>';
}

/** Lit l'état de l'abonnement et remplit la carte des réglages. */
export async function refreshBillingCard() {
  let b;
  try {
    b = await readBilling();
  } catch {
    return;
  }
  const slot = document.querySelector('[data-bill-slot]');
  if (!slot || !b.enabled) return;
  cardBilling = b;
  // eslint-disable-next-line laststream/no-html-sink -- gabarit local, textes dynamiques échappés par esc (prix, état)
  slot.innerHTML = card(tr('Abonnement de soutien'), billingCardBody(b));
}
