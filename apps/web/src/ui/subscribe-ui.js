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

const SOURCE_URL = 'https://github.com/gtko/laststream';
const SPIN = '<svg class="auth-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9"/></svg>';

/** Montant Stripe (centimes) en texte : « 24 € ». */
function money(amount, currency) {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: (currency || 'eur').toUpperCase(), maximumFractionDigits: amount % 100 === 0 ? 0 : 2 }).format(amount / 100);
  } catch {
    return (amount / 100) + ' ' + (currency || '').toUpperCase();
  }
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
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
    if (err.code === 'already_subscribed') return 'Ton abonnement est déjà actif.';
    if (err.code === 'manage_in_portal') return 'Ton abonnement est résilié mais encore en cours : réactive-le depuis les réglages (« Reprendre mon abonnement »).';
    if (err.code === 'not_subscribed') return 'Aucun abonnement en cours sur ce compte.';
    if (err.code === 'billing_unavailable' || err.code === 'network') return 'Le paiement est momentanément indisponible. Réessaie dans un instant.';
    if (err.code === 'profile_locked') return 'Seul le titulaire du compte peut gérer l’abonnement.';
  }
  return 'Une erreur est survenue. Réessaie dans un instant.';
}

/** Écran d'attente pendant la lecture de l'état de l'abonnement. */
export function subscribeLoadingHTML() {
  return '<div class="auth-card auth-panel"><div class="auth-brand">' + brand() + '</div><p class="auth-lead">' + SPIN + ' Un instant…</p></div>';
}

/** Lignes communes : ce que couvre l'abonnement, pas d'extensions fournies, code libre. */
function factsHTML() {
  return '<ul class="sub-facts">' +
    '<li>Profils, bibliothèque et progression synchronisés sur tous tes écrans, pour tout ton foyer.</li>' +
    '<li>Laststream ne fournit ni n’installe aucune extension Stremio : tu ajoutes toi-même les sources que tu utilises.</li>' +
    '<li>Le code est public : tu peux aussi <a href="' + SOURCE_URL + '" target="_blank" rel="noopener">installer Laststream sur ton propre serveur</a>, gratuitement.</li>' +
    '</ul>';
}

/** Écran bloquant « Activer ton accès » (compte sans abonnement en cours sur le service en ligne). */
function subscribeHTML(b, state) {
  const p = priceOf(b);
  const half = b && b.referral && b.referral.discount;
  const canManage = !b || b.canManage !== false;
  const monthly = p.interval === 'year' ? ' (soit ' + money(Math.round(p.amount / 12), p.currency) + ' par mois)' : '';
  const expired = b && (b.status === 'canceled' || b.status === 'unpaid' || b.status === 'past_due' || b.status === 'incomplete_expired');
  const lead = expired
    ? 'Ton abonnement de soutien est arrivé à échéance. Renouvelle-le pour retrouver tes profils et ta bibliothèque.'
    : 'Laststream en ligne est financé par celles et ceux qui l’utilisent. L’abonnement de soutien garde les serveurs allumés.';
  const offer = half
    ? '<p class="sub-offer"><strong>Invité par un ami :</strong> ta première année est à moitié prix, ' + esc(money(Math.round(p.amount / 2), p.currency)) + ' au lieu de ' + esc(money(p.amount, p.currency)) + '.</p>'
    : '';
  const msg = state.msg ? '<p class="auth-msg' + (state.info ? ' is-info' : '') + '" role="status">' + esc(state.msg) + '</p>' : '';
  const actions = canManage
    ? '<button type="button" class="btn btn-primary auth-btn" data-sub-checkout' + (state.busy ? ' disabled' : '') + '>' +
        (state.busy === 'checkout' ? SPIN + 'Ouverture du paiement…' : 'Activer mon accès · ' + esc(money(p.amount, p.currency)) + ' par ' + per(p.interval)) + '</button>' +
      (b && b.hasCustomer ? '<button type="button" class="btn auth-btn auth-btn-alt" data-sub-portal' + (state.busy ? ' disabled' : '') + '>Gérer mon abonnement</button>' : '') +
      '<button type="button" class="auth-link" data-sub-check' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'check' ? 'Vérification…' : 'J’ai payé, vérifier') + '</button>'
    : '<p class="auth-note">Seul le titulaire du compte peut activer l’abonnement. Il couvre tout le foyer : demande-lui de le renouveler.</p>' +
      '<button type="button" class="auth-link" data-sub-check>Vérifier à nouveau</button>';
  return '<div class="auth-card auth-panel sub-panel"><div class="auth-brand">' + brand() + '</div>' +
    '<div class="auth-head"><h1 class="auth-title">Activer ton accès</h1><p class="auth-lead">' + esc(lead) + '</p></div>' +
    '<p class="sub-price"><span class="sub-amount">' + esc(money(p.amount, p.currency)) + '</span> par ' + per(p.interval) + esc(monthly) + '</p>' +
    offer + factsHTML() + msg + '<div class="sub-actions">' + actions + '</div>' +
    '<button type="button" class="btn btn-ghost" data-auth-signout>Se déconnecter</button></div>';
}

let current = null;
let state = { busy: '', msg: '', info: false };
let host = null;
let focusBound = false;

function paint() {
  // eslint-disable-next-line no-restricted-syntax -- gabarit local, textes dynamiques échappés par esc (prix, messages)
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
  state = { busy: 'check', msg: 'Paiement reçu, activation de ton accès…', info: true };
  paint();
  for (let i = 0; i < 8; i++) {
    if (await check(true)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  state = { busy: '', msg: 'Le paiement est en cours de confirmation. Réessaie « J’ai payé, vérifier » dans une minute.', info: true };
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
  if (back === 'cancel') state = { busy: '', msg: 'Paiement annulé : rien n’a été prélevé.', info: true };
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
    const { url } = await billingCheckout();
    if (openStripe(url) === 'outside') state = { busy: '', msg: 'Termine le paiement dans ton navigateur, puis reviens ici.', info: true };
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
  if (t.closest('.sub-panel')) {
    if (t.closest('[data-sub-checkout]')) { void startCheckout(); return; }
    if (t.closest('[data-sub-portal]')) { void openPortal((msg) => { state = { busy: '', msg, info: false }; paint(); }); return; }
    if (t.closest('[data-sub-check]')) {
      state = { busy: 'check', msg: '', info: false };
      paint();
      void check(false).then((ok) => { if (!ok && state.busy) { state = { busy: '', msg: 'Pas encore d’abonnement actif sur ce compte.', info: true }; paint(); } });
    }
    return;
  }
  if (t.closest('[data-bill-checkout]')) { void billingCheckout().then(({ url }) => openStripe(url), (err) => setCardMsg(errorText(err))); return; }
  if (t.closest('[data-bill-portal]')) { void openPortal(setCardMsg); return; }
  if (t.closest('[data-bill-cancel]')) { cardConfirm = true; void refreshBillingCard(); return; }
  if (t.closest('[data-bill-keep]')) { cardConfirm = false; void refreshBillingCard(); return; }
  if (t.closest('[data-bill-cancel-yes]')) { void changeCancel(true); return; }
  if (t.closest('[data-bill-resume]')) void changeCancel(false);
});

// ---------- Réglages : carte « Abonnement de soutien » ----------

/** Vrai pendant la confirmation de la résiliation (deuxième clic). */
let cardConfirm = false;
let cardBusy = false;

/** Résilie (fin de période) ou reprend l'abonnement, puis relit la carte. */
async function changeCancel(cancel) {
  if (cardBusy) return;
  cardBusy = true;
  setCardMsg(cancel ? 'Résiliation…' : 'Reprise de l’abonnement…');
  try {
    const r = await (cancel ? billingCancel() : billingResume());
    cardConfirm = false;
    await refreshBillingCard();
    setCardMsg(cancel
      ? 'C’est résilié : plus aucun prélèvement. Ton accès reste ouvert jusqu’au ' + day(r.paidUntil) + '.'
      : 'Ton abonnement reprend : il sera renouvelé le ' + day(r.paidUntil) + '.');
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
  if (b.reason === 'owner') return 'Compte propriétaire du serveur : accès sans abonnement.';
  if (b.reason === 'paid' && b.subscribed) {
    if (b.cancelAtPeriodEnd) return 'Abonnement résilié : ton accès reste ouvert jusqu’au ' + day(b.paidUntil) + '.';
    if (b.status === 'trialing' && b.paidUntil) return 'Abonnement actif. Prochain prélèvement le ' + day(b.paidUntil) + '.';
    if (b.status === 'past_due') return 'Le dernier paiement a échoué : mets à jour ta carte pour garder ton accès.';
    return 'Abonnement actif, renouvelé le ' + day(b.paidUntil) + '.';
  }
  if (b.reason === 'comp') return 'Accès offert jusqu’au ' + day(b.compUntil) + '.';
  if (b.reason === 'free') return 'Accès offert à tous jusqu’au ' + day(b.freeUntil) + ', pendant le lancement de l’abonnement.';
  return 'Pas d’abonnement en cours.';
}

function billingCardBody(b) {
  const p = priceOf(b);
  const manage = b.canManage !== false;
  const buttons = [];
  if (manage && !b.subscribed && b.reason !== 'owner') buttons.push('<button type="button" class="btn btn-primary btn-sm" data-bill-checkout>S’abonner · ' + esc(money(p.amount, p.currency)) + ' par ' + per(p.interval) + '</button>');
  if (manage && b.hasCustomer) buttons.push('<button type="button" class="btn btn-ghost btn-sm" data-bill-portal>Carte et factures</button>');
  const active = manage && b.subscribed && b.reason === 'paid';
  let cancelRow = '';
  if (active && b.cancelAtPeriodEnd) {
    cancelRow = rowHTML('Résiliation', 'Plus aucun prélèvement. Tu peux changer d’avis jusqu’au ' + day(b.paidUntil) + '.', () => '<button type="button" class="btn btn-primary btn-sm" data-bill-resume>Reprendre mon abonnement</button>');
  } else if (active && cardConfirm) {
    cancelRow = rowHTML('Résilier ?', 'Plus rien ne sera prélevé. Ton accès reste ouvert jusqu’au ' + day(b.paidUntil) + ', puis l’app te proposera de te réabonner. Tes profils et ta bibliothèque sont gardés.',
      () => '<button type="button" class="btn btn-ghost btn-sm sub-danger" data-bill-cancel-yes>Confirmer la résiliation</button><button type="button" class="btn btn-ghost btn-sm" data-bill-keep>Garder mon abonnement</button>');
  } else if (active) {
    cancelRow = rowHTML('Résiliation', 'Sans engagement : tu arrêtes quand tu veux, l’accès reste ouvert jusqu’à la fin de la période payée.', () => '<button type="button" class="btn btn-ghost btn-sm" data-bill-cancel>Résilier</button>');
  }
  const r = b.referral;
  const referral = r && r.rewardMonths > 0
    ? rowHTML('Parrainage', 'Chaque ami qui s’abonne avec un de tes billets t’offre ' + r.rewardMonths + ' mois, et paie sa première année à moitié prix.', () => '<span class="set-val">' + (r.earnedMonths > 0 ? r.earnedMonths + ' mois gagnés' : 'Aucun mois gagné') + '</span>')
    : '';
  return rowHTML('État', statusText(b), () => buttons.join('')) + cancelRow + referral +
    '<p class="set-hint" data-bill-msg role="status"></p>' +
    '<p class="set-hint">L’abonnement de soutien couvre tout ton foyer. Laststream ne fournit aucune extension Stremio : tes sources restent les tiennes. Le code est public sur <a href="' + SOURCE_URL + '" target="_blank" rel="noopener">GitHub</a>.</p>';
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
  // eslint-disable-next-line no-restricted-syntax -- gabarit local, textes dynamiques échappés par esc (prix, état)
  slot.innerHTML = card('Abonnement de soutien', billingCardBody(b));
}
