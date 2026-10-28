/* Invitations sur un profil du foyer, côté hôte (contrat invitations v3, partie A) : panneau « Inviter sur ce profil »
 * (durée 24 h / 3 j / 7 j, lien à copier ou partager, anneau de temps restant, révocation), indicateur d’état dans l’éditeur
 * d’un profil et liste « Invitations du foyer » des réglages. Session verrouillée : rien de tout cela n’est proposé. */
import { auth, isKidProfile, isMainProfile, isProfileLocked, isServerMode, managingProfileId, onAuthChange } from '../data/auth';
import { foyerLink } from '../data/foyerLink';
import {
  createHouseholdInvite, householdErrorCode, listHouseholdInvites, removeProfileLogin, revokeHouseholdInvite,
} from '../data/householdApi';
import { shareBase } from '../data/shareBase';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { ICON } from './icons.js';
import { card } from './settings-ui.js';
import { esc } from './util.js';
import '../styles/household.css';

// Ce module n’importe ni dom.js (qui lit #detail et #modal à son chargement) ni invites.js : il est chargé par l’éditeur de profil.

const HOUR = 3600000;
const DEFAULT_TTL = 72;
const TTLS = [[24, '24 heures'], [72, '3 jours'], [168, '7 jours']];
const COPIED_MS = 1600;
const CLOCK_MS = 30000;
/** Périmètre de l’anneau (cercle de rayon 24). */
const RING = 2 * Math.PI * 24;
const ACCENT = '#ff5a36';
const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pad2 = (n) => String(n).padStart(2, '0');
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const KEY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="15" r="4"></circle><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"></path></svg>';
const LINK_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>';
const CHECK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';
const SHARE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"></path><path d="M16 6l-4-4-4 4M12 2v13"></path></svg>';

/** Date d’expiration lisible (« jeu. 23 oct., 10:00 »), vide si la date est invalide. */
export function expiryLabel(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : DATE_FMT.format(new Date(t));
}

/** Temps restant avant `iso` (« 2 j 23 h », « 5 h 04 min », « 42 min »), ou « expiré ». */
export function remainingLabel(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return 'expiré';
  const d = Math.floor(ms / (24 * HOUR));
  const h = Math.floor((ms % (24 * HOUR)) / HOUR);
  const m = Math.floor((ms % HOUR) / 60000);
  if (d > 0) return d + ' j ' + h + ' h';
  if (h > 0) return h + ' h ' + pad2(m) + ' min';
  return Math.max(m, 1) + ' min';
}

/** Part du délai restant (0 à 1), pour l’anneau. */
export function remainingFraction(iso, ttlHours, now = Date.now()) {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left)) return 0;
  return Math.min(1, Math.max(0, left / (ttlHours * HOUR)));
}

/** Inviter sur ce profil : profil adulte non principal du compte, dans une session non verrouillée. */
export const canInviteOn = (profile) => !!profile && !profile.isKid && profile.isMainProfile === false && !isProfileLocked();

/** Crée le lien. Le profil qui agit n’est passé que s’il diffère du profil actif (gestion après une sortie de profil enfant). */
function createLink(profileId, ttl) {
  const actor = managingProfileId();
  return actor && actor !== auth.profile?.id ? createHouseholdInvite(profileId, ttl, actor) : createHouseholdInvite(profileId, ttl);
}

/** Messages des codes d’erreur des routes foyer (création du lien, retrait de l’accès). */
const ERROR_TEXT = {
  profile_locked: 'Cette session est verrouillée sur un profil : cette action n’est pas disponible.',
  profile_has_login: 'Ce profil a déjà son propre accès : il ne peut plus recevoir d’invitation.',
  principal_profile: 'Le profil principal du compte ne peut pas recevoir d’invitation.',
  kid_profile: 'Un profil enfant ne peut pas recevoir d’invitation.',
  adult_profile_required: 'Seul un profil adulte du compte peut inviter quelqu’un : choisis un profil adulte.',
  pin_required: 'Déverrouille ton profil avec ton code PIN, puis réessaie.',
  invalid_body: 'La demande n’a pas pu être envoyée : recharge la page et réessaie.',
  profile_not_found: 'Ce profil n’existe plus : il a peut-être été supprimé.',
  no_login: 'Ce profil n’a pas d’accès à retirer.',
  rate_limited: 'Trop de demandes en peu de temps : réessaie dans quelques minutes.',
  network: 'Serveur injoignable : réessaie dans un instant.',
};

/** Message affiché pour une erreur des routes foyer : le texte du code connu, sinon `fallback`. */
export function householdErrorText(err, fallback = 'Action impossible : réessaie dans un instant.') {
  return ERROR_TEXT[householdErrorCode(err)] || fallback;
}
const WHEN_TEXT = {
  loading: 'Création du lien…',
  error: 'Pas de lien valide : crée un nouveau lien.',
  revoked: 'Lien révoqué.',
  expired: 'Lien expiré : crée un nouveau lien pour inviter.',
};
const PLACEHOLDER = { loading: 'Création du lien…', error: 'Lien indisponible', revoked: 'Lien révoqué', expired: 'Lien expiré' };

async function copyText(text, input) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* repli ci-dessous */ }
  }
  if (input) {
    input.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
  return false;
}

/* ---------- Panneau « Inviter sur ce profil » ---------- */

/**
 * Panneau ouvert, un seul à la fois. `invite` : lien courant `{id, token, expiresAt}` ; `status` : loading | ready | error |
 * revoked | expired ; `pending` : une demande de lien est en cours (aucune autre n’est lancée) ; `changed` : un lien a été
 * créé ou révoqué (l’éditeur de profil est rafraîchi à la fermeture).
 */
let panel = null;
/** Éléments de la page rendus inertes pendant que le panneau est ouvert. */
let inerted = [];

function panelHTML(p) {
  const initial = (p.name || '?').trim().slice(0, 1).toUpperCase();
  const ttls = TTLS.map(([h, label]) => '<button type="button" class="hh-btn hh-ttl" data-hh-ttl="' + h + '" aria-pressed="false">' + label + '</button>').join('');
  return '<aside class="hh-panel" role="dialog" aria-modal="true" aria-labelledby="hh-title" aria-describedby="hh-lead">' +
    '<header class="hh-head">' +
    '<span class="hh-who"><span class="hh-av"' + avatarAttrs(p.avatar, p.avatarColor || ACCENT) + '>' + (p.avatar ? '' : esc(initial)) + '</span>' +
    '<span class="hh-key" aria-hidden="true">' + KEY_ICON + '</span></span>' +
    '<div class="hh-titles"><p class="hh-eyebrow">Inviter sur ce profil</p>' +
    '<h2 class="hh-title" id="hh-title" tabindex="-1">' + esc(p.name) + '</h2></div>' +
    '<button type="button" class="hh-x" data-hh-close aria-label="Fermer">' + ICON.close + '</button></header>' +
    '<p class="hh-lead" id="hh-lead">' + esc(p.name) + ' choisit son identifiant et son mot de passe, puis se connecte directement sur ce profil.</p>' +
    '<div class="hh-sec"><p class="hh-label" id="hh-ttl-label">Validité du lien</p>' +
    '<div class="hh-ttls" role="group" aria-labelledby="hh-ttl-label">' + ttls + '</div></div>' +
    '<div class="hh-sec"><p class="hh-label" id="hh-link-label">Lien d’invitation</p>' +
    '<div class="hh-linkbox">' + LINK_ICON +
    '<input class="hh-link" type="text" readonly data-hh-link value="" aria-labelledby="hh-link-label" spellcheck="false">' +
    '<button type="button" class="hh-btn hh-copy" data-hh-copy>Copier</button></div>' +
    '<div class="hh-pair"><button type="button" class="hh-btn hh-soft" data-hh-share>' + SHARE_ICON + 'Partager…</button>' +
    '<button type="button" class="hh-btn hh-soft" data-hh-copy-big>Copier le lien</button></div>' +
    '<button type="button" class="hh-btn hh-soft hh-regen" data-hh-regen>Nouveau lien</button>' +
    '<p class="hh-msg" role="status" data-hh-msg></p></div>' +
    '<div class="hh-time"><svg class="hh-ring" viewBox="0 0 56 56" aria-hidden="true" focusable="false">' +
    '<circle class="hh-ring-bg" cx="28" cy="28" r="24"></circle>' +
    '<circle class="hh-ring-fg" data-hh-ring cx="28" cy="28" r="24" stroke-dasharray="' + RING + '" stroke-dashoffset="' + RING + '" transform="rotate(-90 28 28)"></circle></svg>' +
    '<div class="hh-time-t"><p class="hh-time-main" data-hh-when>Création du lien…</p>' +
    '<p class="hh-time-sub">Usage unique · révocable à tout moment</p></div></div>' +
    '<ul class="hh-checks"><li>' + CHECK_ICON + 'Tu ne verras jamais son mot de passe</li>' +
    '<li>' + CHECK_ICON + 'Accès limité au profil ' + esc(p.name) + ', pas aux autres</li></ul>' +
    '<footer class="hh-foot"><button type="button" class="hh-btn hh-revoke" data-hh-revoke>' + ICON.close + 'Révoquer le lien</button>' +
    '<button type="button" class="hh-btn hh-done" data-hh-close data-hh-done>Terminé</button></footer>' +
    '</aside>';
}

/** Peint l’état courant du panneau : lien, durées, copie, boutons, anneau et texte d’expiration. */
function paint() {
  if (!panel) return;
  const { node, invite, status, ttl, copied } = panel;
  const q = (sel) => node.querySelector(sel);
  const busy = status === 'loading';
  const ready = status === 'ready' && !!invite;
  q('[data-hh-link]').value = ready ? foyerLink(shareBase(), invite.token) : '';
  q('[data-hh-link]').placeholder = PLACEHOLDER[status] || '';
  node.querySelectorAll('[data-hh-ttl]').forEach((b) => {
    const on = Number(b.dataset.hhTtl) === ttl;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.disabled = busy;
  });
  q('[data-hh-regen]').disabled = busy;
  q('[data-hh-copy]').disabled = !ready;
  q('[data-hh-copy-big]').disabled = !ready;
  q('[data-hh-share]').disabled = !ready;
  q('[data-hh-revoke]').disabled = !ready;
  q('[data-hh-copy]').textContent = copied ? 'Copié !' : 'Copier';
  q('[data-hh-copy-big]').textContent = copied ? 'Copié !' : 'Copier le lien';
  q('[data-hh-copy]').classList.toggle('is-done', copied);
  q('[data-hh-copy-big]').classList.toggle('is-done', copied);
  paintTime();
}

/** Anneau et texte d’expiration. */
function paintTime() {
  if (!panel) return;
  const { node, invite, status, ttl } = panel;
  const when = node.querySelector('[data-hh-when]');
  const ring = node.querySelector('[data-hh-ring]');
  if (status !== 'ready' || !invite) {
    when.textContent = WHEN_TEXT[status] || WHEN_TEXT.loading;
    ring.style.strokeDashoffset = String(RING);
    return;
  }
  when.textContent = 'Expire ' + expiryLabel(invite.expiresAt) + ' · dans ' + remainingLabel(invite.expiresAt);
  ring.style.strokeDashoffset = String(RING * (1 - remainingFraction(invite.expiresAt, ttl)));
}

/** Passe le lien en « expiré » quand son délai est écoulé (actions désactivées, « Nouveau lien » reste possible). */
function checkExpiry() {
  if (!panel || panel.status !== 'ready' || !panel.invite) return;
  if (!(Date.parse(panel.invite.expiresAt) <= Date.now())) { paintTime(); return; }
  panel.status = 'expired';
  setMsg('Ce lien a expiré : crée un nouveau lien pour inviter.', true);
  paint();
}

function setMsg(text, isError = false) {
  if (!panel) return;
  const m = panel.node.querySelector('[data-hh-msg]');
  m.textContent = text;
  m.classList.toggle('is-error', isError);
}

/** Demande un lien pour la durée `ttl`. Une seule demande à la fois : durées et boutons sont désactivés pendant l’attente. */
async function requestLink(ttl) {
  const current = panel;
  if (!current || current.pending) return;
  current.pending = true;
  current.ttl = ttl;
  current.status = 'loading';
  current.invite = null; // le lien précédent est remplacé côté serveur : on ne l’affiche plus pendant la création
  current.copied = false;
  setMsg('');
  paint();
  try {
    const invite = await createLink(current.profile.id, ttl);
    current.pending = false;
    if (panel !== current) { void revokeHouseholdInvite(invite.id).catch(() => undefined); return; } // fermé entre-temps : rien ne reste actif
    current.invite = { id: invite.id, token: invite.token, expiresAt: invite.expiresAt };
    current.status = 'ready';
    current.changed = true;
    paint();
    checkExpiry();
  } catch (err) {
    current.pending = false;
    if (panel !== current) return;
    current.invite = null;
    current.status = 'error';
    if (householdErrorCode(err) === 'profile_has_login') current.changed = true; // l’éditeur affichera « Son propre accès »
    setMsg(householdErrorText(err, 'Lien non créé : réessaie dans un instant.'), true);
    paint();
  }
}

async function copyLink() {
  const current = panel;
  if (!current || !current.invite) return;
  const ok = await copyText(foyerLink(shareBase(), current.invite.token), current.node.querySelector('[data-hh-link]'));
  if (panel !== current) return;
  if (!ok) { setMsg('Copie impossible : sélectionne le lien et copie-le.', true); return; }
  current.copied = true;
  setMsg('Lien copié.');
  paint();
  clearTimeout(current.timers.copy);
  current.timers.copy = setTimeout(() => { if (panel === current) { current.copied = false; paint(); } }, COPIED_MS);
}

async function shareLink() {
  const current = panel;
  if (!current || !current.invite) return;
  const url = foyerLink(shareBase(), current.invite.token);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Invitation Laststream', text: 'Rejoins ' + current.profile.name + ' sur Laststream :', url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // partage annulé
    }
  }
  await copyLink();
}

async function revokeLink() {
  const current = panel;
  if (!current || !current.invite) return;
  const id = current.invite.id;
  const trigger = current.node.querySelector('[data-hh-revoke]');
  trigger.disabled = true;
  try {
    await revokeHouseholdInvite(id);
    if (panel !== current) return;
    current.invite = null;
    current.status = 'revoked';
    current.changed = true;
    setMsg('Lien révoqué : il ne fonctionne plus. « Nouveau lien » en crée un autre.');
    paint();
    current.node.querySelector('[data-hh-done]')?.focus();
  } catch {
    if (panel !== current) return;
    trigger.disabled = false;
    setMsg('Révocation impossible : réessaie.', true);
  }
}

/** Rend inertes les autres enfants de `body` (le reste de la page, l’éditeur de profil) ; restaure-les à `false`. */
function setInert(on) {
  if (on) {
    for (const el of Array.from(document.body.children)) {
      if (el === panel.node || el.tagName === 'SCRIPT' || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      inerted.push(el);
    }
  } else {
    for (const el of inerted) el.removeAttribute('inert');
    inerted = [];
  }
}

function closePanel() {
  const current = panel;
  if (!current) return;
  panel = null;
  clearTimeout(current.timers.copy);
  clearInterval(current.timers.clock);
  window.removeEventListener('keydown', onKey, true);
  setInert(false);
  current.node.remove();
  const back = current.returnFocus;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  if (current.changed) current.onChange?.();
}

/** Escape ferme le panneau sans toucher à l’éditeur dessous ; Tab reste dans le panneau. */
function onKey(e) {
  if (!panel) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePanel();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = Array.from(panel.node.querySelectorAll(FOCUSABLE));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = !panel.node.contains(active);
  if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
}

function onPanelClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !panel) return;
  if (t === panel.node || t.closest('[data-hh-close]')) { closePanel(); return; }
  const pill = t.closest('[data-hh-ttl]');
  if (pill) {
    // La durée déjà active ne régénère rien : « Nouveau lien » sert à remplacer le lien.
    const ttl = Number(pill.dataset.hhTtl);
    if (ttl !== panel.ttl) void requestLink(ttl);
    return;
  }
  if (t.closest('[data-hh-regen]')) { void requestLink(panel.ttl); return; }
  if (t.closest('[data-hh-copy], [data-hh-copy-big]')) { void copyLink(); return; }
  if (t.closest('[data-hh-share]')) { void shareLink(); return; }
  if (t.closest('[data-hh-revoke]')) void revokeLink();
}

/**
 * Ouvre « Inviter sur ce profil » pour un profil invitable (voir `canInviteOn`) et crée aussitôt un lien de 3 jours.
 * `opener` : bouton qui a ouvert le panneau (le focus y revient à la fermeture). `onChange` : appelé à la fermeture
 * si un lien a été créé ou révoqué (l’éditeur de profil rafraîchit son indicateur).
 */
export function openHouseholdPanel(profile, opts = {}) {
  if (panel || !canInviteOn(profile)) return;
  const node = document.createElement('div');
  node.className = 'hh-back';
  node.innerHTML = panelHTML(profile);
  document.body.appendChild(node);
  panel = {
    node, profile, invite: null, status: 'loading', ttl: DEFAULT_TTL, copied: false, changed: false, pending: false,
    timers: { copy: 0, clock: 0 }, returnFocus: opts.opener || document.activeElement, onChange: opts.onChange,
  };
  setInert(true);
  void hydrateAvatars(node);
  node.addEventListener('click', onPanelClick);
  window.addEventListener('keydown', onKey, true);
  panel.timers.clock = setInterval(checkExpiry, CLOCK_MS);
  paint();
  node.querySelector('#hh-title').focus({ preventScroll: true });
  void requestLink(DEFAULT_TTL);
}

/* ---------- Indicateur dans l’éditeur d’un profil ---------- */

const inviteButtonHTML = () => '<button type="button" class="btn btn-ghost hh-row-btn" data-hh-invite>Inviter quelqu’un sur ce profil</button>';
const UNLINK_LABEL = 'Retirer son accès';
const UNLINK_CONFIRM = 'Confirmer le retrait';

/** Ligne « Inviter » de l’éditeur d’un profil (chaîne vide si le profil n’est pas invitable). */
export function profileInviteRowHTML(profile) {
  if (!canInviteOn(profile)) return '';
  return '<div class="hh-row" data-hh-row data-hh-profile="' + esc(profile.id) + '">' +
    '<p class="hh-row-state" data-hh-state role="status" hidden></p>' + inviteButtonHTML() +
    '<div data-hh-unlink-box hidden>' +
    '<button type="button" class="btn btn-ghost hh-row-btn" data-hh-unlink>' + UNLINK_LABEL + '</button>' +
    '<p class="hh-row-help">Son profil et sa bibliothèque restent ; seul son identifiant est supprimé et ses appareils sont déconnectés.</p>' +
    '</div></div>';
}

/** Texte d’état de la ligne (vide = masqué). */
function setRowState(row, text) {
  const state = row.querySelector('[data-hh-state]');
  if (!state) return;
  state.textContent = text;
  state.hidden = !text;
}

/**
 * Ligne « Son propre accès » : le bouton d’invitation disparaît et « Retirer son accès » apparaît ; l’inverse après un retrait.
 */
function setOwnAccess(row, own) {
  const invite = row.querySelector('[data-hh-invite]');
  if (own && invite) invite.remove();
  if (!own && !invite) row.querySelector('[data-hh-state]')?.insertAdjacentHTML('afterend', inviteButtonHTML());
  const box = row.querySelector('[data-hh-unlink-box]');
  if (box) box.hidden = !own;
}

/**
 * Complète l’indicateur : « Son propre accès » (et « Retirer son accès ») si le profil a déjà un identifiant, sinon
 * « Invitation en attente · expire dans … ». `linkedProfileIds` du serveur fait foi ; à défaut, une invitation `used`.
 */
export async function paintProfileInviteRow(row, profile) {
  if (!row || !profile) return;
  let text = '';
  let own = false;
  try {
    const data = await listHouseholdInvites();
    const mine = data.invites.filter((i) => i.profileId === profile.id);
    own = Array.isArray(data.linkedProfileIds) ? data.linkedProfileIds.includes(profile.id) : mine.some((i) => i.state === 'used');
    const pending = mine
      .filter((i) => i.state === 'pending' && Date.parse(i.expiresAt) > Date.now())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (own) text = 'Son propre accès';
    else if (pending) text = 'Invitation en attente · expire dans ' + remainingLabel(pending.expiresAt);
  } catch {
    text = ''; // indicatif : sans lui, le bouton reste utile
  }
  if (!row.isConnected) return;
  setOwnAccess(row, own);
  setRowState(row, text);
}

/* ---------- Retrait de l’accès d’un profil (ligne de l’éditeur) ---------- */

/** Délai après lequel le premier clic sur « Retirer son accès » n’attend plus de confirmation. */
const ARM_MS = 6000;
/** Bouton qui attend la confirmation (un seul à la fois) et minuterie qui le désarme. */
let armed = null;
let armTimer = 0;

function disarmUnlink() {
  clearTimeout(armTimer);
  if (armed && armed.isConnected) armed.textContent = UNLINK_LABEL;
  armed = null;
}

/**
 * Retrait en deux temps, dans le bouton : le premier clic demande « Confirmer le retrait », le second retire l’accès
 * (`DELETE /profiles/:id/login`), puis la ligne et la liste des invitations sont rafraîchies.
 */
async function unlinkFromRow(button) {
  if (armed !== button) {
    disarmUnlink();
    armed = button;
    button.textContent = UNLINK_CONFIRM;
    armTimer = setTimeout(disarmUnlink, ARM_MS);
    return;
  }
  disarmUnlink();
  const row = button.closest('[data-hh-row]');
  const profileId = row ? row.dataset.hhProfile : '';
  if (!row || !profileId) return;
  button.disabled = true;
  // Même profil acteur que pour la création du lien : le profil géré, s’il diffère du profil actif.
  const actor = managingProfileId();
  let done = false;
  try {
    await removeProfileLogin(profileId, actor && actor !== auth.profile?.id ? actor : undefined);
    done = true;
  } catch (err) {
    setRowState(row, householdErrorText(err, 'Retrait impossible : réessaie dans un instant.'));
  }
  button.disabled = false;
  if (!done) return;
  await refreshHouseholdInvites();
  await paintProfileInviteRow(row, { id: profileId });
  setRowState(row, 'Accès retiré.');
}

/* ---------- Liste « Invitations du foyer » (réglages) ---------- */

/** Dernière liste lue : null (chargement), 'error', ou la réponse de `listHouseholdInvites`. */
let listData = null;
/** Message bref sous la liste (révocation réussie ou non). */
let listNote = '';
const STATE_LABEL = { pending: 'En attente', used: 'Utilisée', expired: 'Expirée', revoked: 'Révoquée' };

/** Pas de liste : session verrouillée, profil enfant, ou repli local sans serveur. */
const listHidden = () => isProfileLocked() || isKidProfile() || !isServerMode() || !isMainProfile();

/** État affiché d’une invitation : une invitation en attente dont l’échéance est passée est affichée expirée. */
function shownState(inv) {
  return inv.state === 'pending' && Date.parse(inv.expiresAt) <= Date.now() ? 'expired' : inv.state;
}

function itemHTML(inv) {
  const state = shownState(inv);
  const detail = state === 'pending' ? 'expire dans ' + remainingLabel(inv.expiresAt)
    : state === 'used' && inv.usedAt ? 'acceptée le ' + expiryLabel(inv.usedAt) : '';
  return '<li class="hh-item is-' + esc(state) + '">' +
    '<span class="hh-dot" aria-hidden="true"></span>' +
    '<span class="hh-item-name">' + esc(inv.profileName) + '</span>' +
    '<span class="hh-item-state">' + esc(STATE_LABEL[state] || state) + (detail ? ' · ' + esc(detail) : '') + '</span>' +
    (state === 'pending' ? '<button type="button" class="link-btn hh-item-rev" data-hh-list-revoke="' + esc(inv.id) + '" aria-label="Révoquer l’invitation sur ' + esc(inv.profileName) + '">Révoquer</button>' : '') +
    '</li>';
}

/** Contenu de la liste selon son état de chargement (exporté pour les tests). */
export function householdInvitesHTML(d, note = '') {
  const noteHTML = note ? '<p class="set-hint" role="status">' + esc(note) + '</p>' : '';
  if (d === null) return '<p class="set-hint" role="status">Chargement des invitations…</p>';
  if (d === 'error') return '<p class="set-hint" role="alert">Invitations indisponibles : le serveur ne répond pas. <button type="button" class="link-btn" data-hh-reload>Réessayer</button></p>';
  if (!d.invites.length) return '<p class="set-hint">Aucune invitation sur un profil ces 30 derniers jours.</p>' + noteHTML;
  return '<ul class="hh-list">' + d.invites.map(itemHTML).join('') + '</ul>' + noteHTML;
}

/** Carte des réglages « Profil et compte » ; vide en session verrouillée, pour un profil enfant ou sans serveur. */
export function householdInvitesCard() {
  if (listHidden()) return '';
  return card('Invitations du foyer', '<div id="hh-invites-slot">' + householdInvitesHTML(listData, listNote) + '</div>',
    { desc: 'Les personnes invitées sur un de tes profils créent leur identifiant et ne se connectent que sur ce profil.' });
}

function paintList() {
  const slot = document.getElementById('hh-invites-slot');
  if (slot) slot.innerHTML = householdInvitesHTML(listData, listNote);
}

/** Vide la liste mémorisée (ouverture des réglages, changement de session). */
export function resetHouseholdList() {
  listData = null;
  listNote = '';
  paintList();
}

/** Charge la liste du foyer (à l’ouverture des réglages). */
export async function refreshHouseholdInvites() {
  if (listHidden()) return null;
  try {
    listData = await listHouseholdInvites();
  } catch {
    listData = 'error';
  }
  paintList();
  return listData;
}

async function revokeFromList(id, button) {
  if (button) button.disabled = true;
  try {
    await revokeHouseholdInvite(id);
    listNote = 'Invitation révoquée.';
  } catch {
    listNote = 'Révocation impossible : réessaie.';
  }
  await refreshHouseholdInvites();
}

// Sortie de session : la liste du compte précédent ne doit pas rester en mémoire.
onAuthChange(() => { if (!isServerMode()) resetHouseholdList(); });

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const rev = t.closest('[data-hh-list-revoke]');
  if (rev) { e.preventDefault(); void revokeFromList(rev.dataset.hhListRevoke, rev); return; }
  const unlink = t.closest('[data-hh-unlink]');
  if (unlink) { e.preventDefault(); void unlinkFromRow(unlink); return; }
  if (t.closest('[data-hh-reload]')) { e.preventDefault(); listData = null; void refreshHouseholdInvites(); }
});
