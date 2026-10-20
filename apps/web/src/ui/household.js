/* Invitations sur un profil du foyer, côté hôte (contrat invitations v3, partie A) : panneau « Inviter sur ce profil »
 * (durée 24 h / 3 j / 7 j, lien à copier ou partager, anneau de temps restant, révocation), indicateur d’état dans l’éditeur
 * d’un profil et liste « Invitations du foyer » des réglages. Session verrouillée : rien de tout cela n’est proposé. */
import { auth, isProfileLocked, managingProfileId } from '../data/auth';
import { foyerLink } from '../data/foyerLink';
import {
  createHouseholdInvite, householdErrorCode, listHouseholdInvites, revokeHouseholdInvite,
} from '../data/householdApi';
import { shareBase } from '../data/shareBase';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { ICON } from './icons.js';
import { card } from './settings-ui.js';
import { esc } from './util.js';
import '../styles/household.css';

// Ce module n'importe pas dom.js (qui lit #detail et #modal à son chargement) : il est chargé par l'éditeur de profil.

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

const ERROR_TEXT = {
  profile_locked: 'Cette session est verrouillée sur un profil : aucun lien ne peut être créé.',
  network: 'Serveur injoignable : réessaie dans un instant.',
};

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

/** Panneau ouvert : un seul à la fois. `invite` : lien courant `{id, token, expiresAt}` ; `status` : loading | ready | error | revoked. */
let panel = null;

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

/** Peint l’état courant du panneau (lien, durées, copie, temps restant, boutons). */
function paint() {
  if (!panel) return;
  const { node, invite, status, ttl, copied } = panel;
  const q = (sel) => node.querySelector(sel);
  const link = invite ? foyerLink(shareBase(), invite.token) : '';
  const input = q('[data-hh-link]');
  input.value = link;
  input.placeholder = status === 'loading' ? 'Création du lien…' : status === 'error' ? 'Lien indisponible' : status === 'revoked' ? 'Lien révoqué' : '';
  node.querySelectorAll('[data-hh-ttl]').forEach((b) => {
    const on = Number(b.dataset.hhTtl) === ttl;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
  });
  const ready = status === 'ready' && !!invite;
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

/** Anneau et texte d’expiration : rafraîchis aussi toutes les 30 s pendant que le panneau est ouvert. */
function paintTime() {
  if (!panel) return;
  const { node, invite, status, ttl } = panel;
  const when = node.querySelector('[data-hh-when]');
  const ring = node.querySelector('[data-hh-ring]');
  if (!invite || status !== 'ready') {
    when.textContent = status === 'error' ? 'Pas de lien valide : choisis une durée pour réessayer.' : status === 'revoked' ? 'Lien révoqué.' : 'Création du lien…';
    ring.style.strokeDashoffset = String(RING);
    return;
  }
  const left = remainingLabel(invite.expiresAt);
  when.textContent = left === 'expiré' ? 'Lien expiré' : 'Expire ' + expiryLabel(invite.expiresAt) + ' · dans ' + left;
  ring.style.strokeDashoffset = String(RING * (1 - remainingFraction(invite.expiresAt, ttl)));
}

function setMsg(text, isError = false) {
  if (!panel) return;
  const m = panel.node.querySelector('[data-hh-msg]');
  m.textContent = text;
  m.classList.toggle('is-error', isError);
}

/** Demande un lien pour la durée `ttl`. Chaque demande remplace la précédente : seule la dernière répond à l’écran. */
async function requestLink(ttl) {
  if (!panel) return;
  const seq = ++panel.seq;
  panel.ttl = ttl;
  panel.status = 'loading';
  panel.invite = null; // le lien précédent est remplacé côté serveur : on ne l'affiche plus pendant la création
  panel.copied = false;
  setMsg('');
  paint();
  try {
    const invite = await createLink(panel.profile.id, ttl);
    if (!panel || seq !== panel.seq) return;
    panel.invite = { id: invite.id, token: invite.token, expiresAt: invite.expiresAt };
    panel.status = 'ready';
    paint();
    panel.onChange?.();
  } catch (err) {
    if (!panel || seq !== panel.seq) return;
    panel.invite = null;
    panel.status = 'error';
    const code = householdErrorCode(err);
    setMsg(ERROR_TEXT[code] || 'Lien non créé : réessaie dans un instant.', true);
    paint();
  }
}

async function copyLink() {
  if (!panel || !panel.invite) return;
  const ok = await copyText(foyerLink(shareBase(), panel.invite.token), panel.node.querySelector('[data-hh-link]'));
  if (!panel) return;
  if (!ok) { setMsg('Copie impossible : sélectionne le lien et copie-le.', true); return; }
  panel.copied = true;
  paint();
  clearTimeout(panel.timers.copy);
  panel.timers.copy = setTimeout(() => { if (panel) { panel.copied = false; paint(); } }, COPIED_MS);
}

async function shareLink() {
  if (!panel || !panel.invite) return;
  const url = foyerLink(shareBase(), panel.invite.token);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Invitation Laststream', text: 'Rejoins ' + panel.profile.name + ' sur Laststream :', url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // partage annulé
    }
  }
  await copyLink();
}

async function revokeLink() {
  if (!panel || !panel.invite) return;
  const id = panel.invite.id;
  const trigger = panel.node.querySelector('[data-hh-revoke]');
  trigger.disabled = true;
  try {
    await revokeHouseholdInvite(id);
    if (!panel) return;
    panel.invite = null;
    panel.status = 'revoked';
    setMsg('Lien révoqué : il ne fonctionne plus. Choisis une durée pour en créer un nouveau.');
    paint();
    panel.node.querySelector('[data-hh-done]')?.focus();
    panel.onChange?.();
  } catch {
    if (!panel) return;
    trigger.disabled = false;
    setMsg('Révocation impossible : réessaie.', true);
  }
}

function closePanel() {
  if (!panel) return;
  const current = panel;
  panel = null;
  clearTimeout(current.timers.copy);
  clearInterval(current.timers.clock);
  document.removeEventListener('keydown', onKey);
  current.node.remove();
  if (current.returnFocus && current.returnFocus.isConnected && typeof current.returnFocus.focus === 'function') current.returnFocus.focus();
}

function onKey(e) {
  if (e.key === 'Escape') closePanel();
}

function onPanelClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !panel) return;
  if (t === panel.node || t.closest('[data-hh-close]')) { closePanel(); return; }
  const ttl = t.closest('[data-hh-ttl]');
  if (ttl) { void requestLink(Number(ttl.dataset.hhTtl)); return; }
  if (t.closest('[data-hh-copy], [data-hh-copy-big]')) { void copyLink(); return; }
  if (t.closest('[data-hh-share]')) { void shareLink(); return; }
  if (t.closest('[data-hh-revoke]')) { void revokeLink(); }
}

/**
 * Ouvre « Inviter sur ce profil » pour un profil invitable (voir `canInviteOn`). Crée aussitôt un lien de 3 jours.
 * `onChange` : appelé après une création ou une révocation réussie (l’éditeur de profil rafraîchit son indicateur).
 */
export function openHouseholdPanel(profile, opts = {}) {
  if (panel || !canInviteOn(profile)) return;
  const node = document.createElement('div');
  node.className = 'hh-back';
  node.innerHTML = panelHTML(profile);
  document.body.appendChild(node);
  panel = {
    node, profile, invite: null, status: 'loading', ttl: DEFAULT_TTL, copied: false, seq: 0,
    timers: { copy: 0, clock: 0 }, returnFocus: document.activeElement, onChange: opts.onChange,
  };
  void hydrateAvatars(node);
  node.addEventListener('click', onPanelClick);
  document.addEventListener('keydown', onKey);
  panel.timers.clock = setInterval(paintTime, CLOCK_MS);
  paint();
  node.querySelector('#hh-title').focus({ preventScroll: true });
  void requestLink(DEFAULT_TTL);
}

/* ---------- Indicateur dans l’éditeur d’un profil ---------- */

/** Ligne « Inviter » de l’éditeur d’un profil (chaîne vide si le profil n’est pas invitable). */
export function profileInviteRowHTML(profile) {
  if (!canInviteOn(profile)) return '';
  return '<div class="hh-row" data-hh-row>' +
    '<p class="hh-row-state" data-hh-state role="status" hidden></p>' +
    '<button type="button" class="btn btn-ghost hh-row-btn" data-hh-invite>Inviter quelqu’un sur ce profil</button></div>';
}

/** Complète l’indicateur : « Invitation en attente · expire dans … », ou « Son propre accès » si un identifiant existe. */
export async function paintProfileInviteRow(row, profile) {
  if (!row || !profile) return;
  let text = '';
  try {
    const { invites } = await listHouseholdInvites();
    const mine = invites.filter((i) => i.profileId === profile.id);
    const pending = mine
      .filter((i) => i.state === 'pending' && Date.parse(i.expiresAt) > Date.now())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (pending) text = 'Invitation en attente · expire dans ' + remainingLabel(pending.expiresAt);
    else if (mine.some((i) => i.state === 'used')) text = 'Son propre accès';
  } catch {
    text = ''; // indicatif : sans lui, le bouton reste utile
  }
  const state = row.querySelector('[data-hh-state]');
  if (!state || !row.isConnected) return;
  state.textContent = text;
  state.hidden = !text;
}

/* ---------- Liste « Invitations du foyer » (réglages) ---------- */

/** Dernière liste lue : null (chargement), 'error', ou la réponse de `listHouseholdInvites`. */
let listData = null;
/** Message bref sous la liste (révocation réussie ou non). */
let listNote = '';
const STATE_LABEL = { pending: 'En attente', used: 'Utilisée', expired: 'Expirée', revoked: 'Révoquée' };

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

/** Carte des réglages « Profil et compte » ; vide en session verrouillée. */
export function householdInvitesCard() {
  if (isProfileLocked()) return '';
  return card('Invitations du foyer', '<div id="hh-invites-slot">' + householdInvitesHTML(listData) + '</div>',
    { desc: 'Les personnes invitées sur un de tes profils créent leur identifiant et ne se connectent que sur ce profil.' });
}

function paintList() {
  const slot = document.getElementById('hh-invites-slot');
  if (slot) slot.innerHTML = householdInvitesHTML(listData, listNote);
}

/** Charge la liste du foyer (à l’ouverture des réglages). */
export async function refreshHouseholdInvites() {
  if (isProfileLocked()) return null;
  try {
    listData = await listHouseholdInvites();
  } catch {
    listData = 'error';
  }
  paintList();
  return listData;
}

async function revokeFromList(id) {
  try {
    await revokeHouseholdInvite(id);
    listNote = 'Invitation révoquée.';
  } catch {
    listNote = 'Révocation impossible : réessaie.';
  }
  await refreshHouseholdInvites();
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const rev = t.closest('[data-hh-list-revoke]');
  if (rev) { e.preventDefault(); void revokeFromList(rev.dataset.hhListRevoke); return; }
  if (t.closest('[data-hh-reload]')) { e.preventDefault(); listData = null; void refreshHouseholdInvites(); }
});
