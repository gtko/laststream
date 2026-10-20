/* Comptes : écran de connexion, choix du profil (façon Netflix), clavier PIN, gestion des profils, mode enfant. */
import {
  auth, canManageProfiles, chooseProfile, grantManager, hasValidToken, isProfileLocked, offlineWithoutSession, parentalProfile,
  signIn, signOut, signUp, unlock,
} from '../data/auth';
import { checkInviteTicket, normalizeInviteCode, parseInviteCode, withoutInvite } from '../data/invite';
import { getBase, isOfficialBase } from '../data/config';
import { me as readMe, UserApiError } from '../data/userApi';
import { avatarAttrs } from './avatar-art.js';
import { brand } from './fragments.js';
import { ICON } from './icons.js';
import { openProfileEditor, PROFILE_COLORS as COLORS } from './profile-editor.js';
import { mountReferral, referralReasonText } from './referral-join.js';
import { esc } from './util.js';

/** Message de l'écran de connexion quand le serveur ne répond pas et qu'aucune session n'existe. */
const OFFLINE_MSG = 'Serveur Laststream injoignable. Vérifie ta connexion puis réessaie.';

let root = null;
let resolveFlow = null;

function el() {
  if (!root) {
    root = document.createElement('div');
    root.id = 'auth';
    root.className = 'auth';
    root.hidden = true;
    document.body.appendChild(root);
  }
  return root;
}

function show(html) {
  const r = el();
  r.innerHTML = html;
  r.hidden = false;
  document.body.classList.add('modal-open');
}

function hide() {
  const r = el();
  r.hidden = true;
  r.innerHTML = '';
  document.body.classList.remove('modal-open');
}

const initialOfName = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

/** Message lisible d'une erreur de l'API utilisateur. */
export function errorText(err) {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  const wait = err.retryAfterSec ? ' Réessaie dans ' + (err.retryAfterSec > 90 ? Math.ceil(err.retryAfterSec / 60) + ' min' : err.retryAfterSec + ' s') + '.' : '';
  switch (err.code) {
    case 'network': return 'lastAddon est injoignable.';
    case 'invalid_credentials': return 'Nom d’utilisateur ou mot de passe incorrect.';
    case 'username_taken': return 'Ce nom d’utilisateur est déjà pris.';
    case 'signup_disabled': return 'Inscription sur invitation : demande un lien de parrainage à un ami déjà inscrit.';
    case 'invite_invalid': return 'Ce lien d’invitation est invalide, déjà utilisé ou révoqué.';
    case 'bootstrap_token_invalid': return 'Jeton d’amorçage invalide.';
    case 'invalid_body': return 'Nom : 3 à 32 caractères (a-z, 0-9, _ . -). Mot de passe : 8 caractères minimum.';
    case 'invalid_pin': return 'Code incorrect.';
    case 'pin_locked': return 'Trop d’essais : profil bloqué.' + wait;
    case 'rate_limited': return 'Trop de tentatives.' + wait;
    case 'stremio_login_failed': return 'Connexion Stremio refusée : vérifie l’e-mail et le mot de passe.';
    case 'invalid_config': return 'Configuration lastAddon invalide : enregistre-la d’abord dans les réglages.';
    case 'avatar_not_allowed_for_kid': return 'Cet avatar n’est pas autorisé sur un profil enfant : choisis-en un autre.';
    case 'invalid_avatar': return 'Cet avatar n’est plus disponible : choisis-en un autre.';
    default: return 'Erreur (' + err.code + ').' + wait;
  }
}

// ---------- Connexion / création de compte ----------
/** Lien de parrainage : `?invite=<code>` ou `#/join/<code>` dans l'adresse, sinon code saisi à la main. */
const invite = { code: '', status: 'none', inviter: '', first: false, ticket: null, reason: '' };
let inviteToken = 0;

/** Vérifie le code auprès du serveur (sans session) : « invité par … » ou lien invalide. */
async function checkInviteCode(raw) {
  const code = normalizeInviteCode(raw);
  const token = ++inviteToken;
  invite.code = code;
  invite.inviter = '';
  invite.ticket = null;
  invite.reason = '';
  if (!code) { invite.status = raw && raw.trim() ? 'invalid' : 'none'; return invite.status; }
  invite.status = 'checking';
  try {
    const res = await checkInviteTicket(code);
    if (token !== inviteToken) return invite.status;
    invite.status = res.valid ? 'valid' : 'invalid';
    // Billet de parrainage (v3) : `inviter` est l'objet du parrain, et le billet porte son mot et ses coups de cœur. Sans
    // parrain (billet de l'administrateur, `inviter: null`), le formulaire classique reste utilisé.
    const inviter = res.valid && res.inviter ? res.inviter : null;
    invite.ticket = inviter ? res : null;
    invite.inviter = inviter ? inviter.name || '' : '';
    invite.reason = res.valid ? '' : res.reason || '';
  } catch {
    if (token === inviteToken) invite.status = 'unknown'; // serveur injoignable : le code sera vérifié à l'inscription
  }
  return invite.status;
}

/** Vue affichée : 'login' (Connexion) ou 'invite' (Rejoindre Laststream). */
let mode = 'login';

/** Lit le code d'invitation de l'adresse de la page (au démarrage) : la vue « Rejoindre Laststream » s'ouvre alors directement. */
export function readInviteFromLocation() {
  const code = parseInviteCode(location.search, location.hash);
  invite.first = false;
  invite.inviter = '';
  invite.ticket = null;
  invite.reason = '';
  invite.code = code;
  invite.status = code ? 'checking' : 'none';
  mode = code ? 'invite' : 'login';
}
readInviteFromLocation();

function forgetInviteInUrl() {
  const rest = withoutInvite(location.search, location.hash);
  try { history.replaceState(null, '', location.pathname + rest.search + rest.hash); } catch (_) { /* adresse inchangée */ }
}

/** Billet de parrainage : l'écran d'arrivée remplace l'overlay. Un billet qui ne vaut plus renvoie à la saisie du code. */
function showReferral() {
  const r = el();
  r.hidden = false;
  document.body.classList.add('modal-open');
  mountReferral(r, {
    ticket: invite.ticket,
    create: createFromReferral,
    message: errorText,
    onGone: (reason) => { invite.status = 'invalid'; invite.reason = reason || ''; invite.ticket = null; showLogin(); },
    onEnter: () => route(),
  });
}

/** Création du compte avec le billet (code et choix d'amitié), puis session. Résout avec le handle connu du serveur, ou ''. */
async function createFromReferral({ username, password, autoFriend }) {
  await signUp(username, password, undefined, invite.code, autoFriend);
  forgetInviteInUrl();
  invite.code = '';
  invite.status = 'none';
  invite.ticket = null;
  try {
    const { account } = await readMe(4000);
    return account && typeof account.handle === 'string' ? account.handle : '';
  } catch {
    return '';
  }
}

const EYE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19C5.6 19 2 12 2 12a18 18 0 0 1 5.1-5.9M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.2M1 1l22 22"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/></svg>';
const ALERT_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/></svg>';
const SPIN_SVG = '<svg class="auth-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9"/></svg>';
const BACK_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';

/** Message de l'écran : une erreur (icône) ou une information neutre (vérification du lien). Vide : le bloc reste en place, invisible. */
function msgHTML(text, info) {
  return '<p class="auth-msg' + (info ? ' is-info' : '') + '" id="auth-msg" role="alert">' + (text ? (info ? '' : ALERT_SVG) + '<span>' + esc(text) + '</span>' : '') + '</p>';
}

/** Champ : label au-dessus, saisie de 48 px ; `toggle` ajoute le bouton œil (mot de passe). */
function fieldHTML(o) {
  const id = 'auth-f-' + o.name;
  return '<div class="auth-field"><label class="auth-label" for="' + id + '">' + o.label + '</label><span class="auth-input">' +
    '<input id="' + id + '" type="' + o.type + '" name="' + o.name + '" autocomplete="' + o.auto + '"' + (o.attrs || '') + (o.invalid ? ' aria-invalid="true" aria-describedby="auth-msg"' : '') + '>' +
    (o.toggle ? '<button type="button" class="auth-eye" data-pw-toggle aria-label="Afficher le mot de passe">' + EYE_SVG + '</button>' : '') + '</span></div>';
}

/** Étape 1 de « Rejoindre Laststream » : coller le lien (ou le code), puis valider. Le lien est vérifié auprès du serveur. */
function inviteCodeHTML(msg) {
  const st = invite.status;
  const checking = !msg && st === 'checking';
  const err = msg || (st === 'invalid'
    ? (referralReasonText(invite.reason) || 'Ce lien d’invitation est invalide, déjà utilisé ou révoqué. Demande un nouveau lien à la personne qui t’invite.')
    : '');
  return '<form class="auth-form auth-invite" data-invite-form>' +
    fieldHTML({ label: 'Colle ton lien ou code d’invitation', type: 'text', name: 'code', auto: 'off', invalid: !!err,
      attrs: ' autocapitalize="none" spellcheck="false" placeholder="Lien ou code d’invitation" value="' + esc(st === 'invalid' ? '' : invite.code) + '"' }) +
    msgHTML(checking ? 'Vérification du lien…' : err, checking) +
    '<p class="auth-note">Le lien entier ou seulement son code : les deux fonctionnent.</p>' +
    '<button type="submit" class="btn btn-primary auth-btn">Valider</button></form>' +
    (isOfficialBase(getBase()) ? '' : '<button type="button" class="link-btn auth-link" data-invite-first>C’est le premier compte de ce serveur</button>');
}

/** Étape 2 : l'invitation est reconnue (qui invite). Rien à afficher pour le premier compte du serveur. */
function inviteStatusHTML() {
  if (invite.first) return '';
  if (invite.status === 'valid') return '<p class="auth-invite-ok" role="status">' + (invite.inviter ? 'Invité par <strong>' + esc(invite.inviter) + '</strong>' : 'Lien d’invitation valide') + '</p>';
  return '<p class="auth-invite-ok" role="status">Lien d’invitation enregistré (vérifié à l’inscription).</p>';
}

/** Nom d’utilisateur et mot de passe ; à l’inscription, le jeton d’amorçage du premier compte si le serveur l’exige. */
function credentialsFormHTML(reg, msg) {
  return '<form id="auth-form" class="auth-form" autocomplete="on">' +
    fieldHTML({ label: 'Nom d’utilisateur', type: 'text', name: 'username', auto: 'username', attrs: ' autocapitalize="none" placeholder="ex. camille" required' }) +
    fieldHTML({ label: 'Mot de passe', type: 'password', name: 'password', auto: reg ? 'new-password' : 'current-password', attrs: ' required', toggle: true }) +
    (reg && invite.first ? fieldHTML({ label: 'Jeton d’amorçage (premier compte, si le serveur l’exige)', type: 'password', name: 'bootstrap', auto: 'off' }) : '') +
    msgHTML(msg) +
    '<button type="submit" class="btn btn-primary auth-btn" data-auth-submit>' + (reg ? 'Créer mon compte' : 'Se connecter') + '</button></form>';
}

/** Titre et sous-titre court d'une vue. */
const headHTML = (title, lead) => '<div class="auth-head"><h1 class="auth-title">' + title + '</h1><p class="auth-lead">' + lead + '</p></div>';

/** Vue « Connexion » (par défaut) : le formulaire, « ou », puis « Pas encore de compte ? » pour ouvrir l’invitation. */
function loginViewHTML(msg) {
  return headHTML('Connexion', 'Retrouve tes profils, ta bibliothèque et ta progression.') + credentialsFormHTML(false, msg) +
    '<div class="auth-sep" aria-hidden="true">ou</div>' +
    '<section class="auth-new" aria-labelledby="auth-new-title"><p class="auth-note" id="auth-new-title">Pas encore de compte ? Les comptes se créent sur invitation : demande un lien à un ami déjà inscrit.</p>' +
    '<button type="button" class="btn auth-btn auth-btn-alt" data-auth-mode="invite">J’ai un lien d’invitation</button></section>';
}

/** Vue « Rejoindre Laststream » : coller le lien (étape 1), puis créer son compte (étape 2). */
function inviteViewHTML(msg) {
  const ready = invite.first || invite.status === 'valid' || invite.status === 'unknown';
  return headHTML('Rejoindre Laststream', ready ? 'Choisis ton nom d’utilisateur et ton mot de passe.' : 'Colle le lien que ton ami t’a envoyé pour créer ton compte.') +
    (ready ? inviteStatusHTML() + credentialsFormHTML(true, msg) : inviteCodeHTML(msg)) +
    '<button type="button" class="auth-back" data-auth-mode="login">' + BACK_SVG + 'J’ai déjà un compte</button>';
}

function loginHTML(msg) {
  const body = mode === 'invite' ? inviteViewHTML(msg) : loginViewHTML(msg);
  return '<div class="auth-card auth-panel"><div class="auth-brand">' + brand() + '</div>' + body +
    (isOfficialBase(getBase()) ? '' : '<p class="auth-note">Le compte vit sur ton serveur lastAddon : profils, bibliothèque et progression y sont enregistrés.</p>') +
    '</div>';
}

function showLogin(msg) {
  // Billet de parrainage valide : « Ta place est réservée », puis compte, puis bienvenue (referral-join.js).
  if (mode === 'invite' && invite.status === 'valid' && invite.ticket) { showReferral(); return; }
  show(loginHTML(msg));
  const u = el().querySelector('input[name="username"]') || el().querySelector('input[name="code"]');
  if (u) u.focus();
  // Lien de l'adresse : vérifié à l'ouverture de la vue (« Vérification du lien… »).
  if (mode === 'invite' && invite.status === 'checking') void validateInvite(invite.code);
}

/** Vérifie le lien ou le code saisi (ou collé), puis réaffiche : compte à créer, ou message si le lien ne vaut rien. */
function validateInvite(raw) {
  invite.status = 'checking';
  // Réponse périmée (une validation plus récente est en vol) : rien à redessiner, sinon showLogin relancerait la vérification.
  return checkInviteCode(raw).then(() => { if (invite.status !== 'checking' && !root.hidden && mode === 'invite') showLogin(); });
}

/** Bascule Connexion ↔ Rejoindre Laststream. Ouvrir « Rejoindre » repart de la saisie du lien (le code reste dans le champ). */
function setMode(next) {
  mode = next;
  invite.first = false;
  if (next === 'invite' && invite.status !== 'checking') invite.status = 'none';
}

/** Envoi en cours : bouton désactivé avec chargeur, champs en lecture seule, formulaire occupé (aria-busy). */
function setBusy(form, on) {
  form.setAttribute('aria-busy', String(on));
  form.querySelectorAll('input').forEach((i) => { i.readOnly = on; });
  const alt = el().querySelector('.auth-btn-alt');
  if (alt) alt.disabled = on;
  const btn = form.querySelector('[data-auth-submit]');
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.innerHTML = SPIN_SVG + (mode === 'invite' ? 'Création du compte…' : 'Connexion en cours…');
  } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

/** Erreur de saisie ou d'identifiants (4xx de validation) : les champs sont fautifs. Réseau coupé, 5xx, limitation : non. */
const isInputError = (err) => err instanceof UserApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && !['rate_limited', 'network', 'pin_locked'].includes(err.code);

/** Affiche l'erreur ; pour une erreur de saisie, marque les champs (aria-invalid) et remet le focus sur le premier. */
function showFormError(form, err) {
  const msg = el().querySelector('#auth-msg');
  if (msg) msg.innerHTML = ALERT_SVG + '<span>' + esc(errorText(err)) + '</span>';
  if (!isInputError(err)) return;
  const fields = [...form.querySelectorAll('input[name="username"], input[name="password"]')];
  fields.forEach((i) => { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'auth-msg'); });
  if (fields[0]) fields[0].focus();
}

/** Remet les champs mot de passe masqués (type password) avant l'envoi : le gestionnaire de mots de passe doit les reconnaître. */
function maskPasswords(form) {
  form.querySelectorAll('[data-pw-toggle]').forEach((eye) => {
    const input = eye.parentElement && eye.parentElement.querySelector('input');
    if (input) input.type = 'password';
    eye.innerHTML = EYE_SVG;
    eye.setAttribute('aria-label', 'Afficher le mot de passe');
  });
}

async function submitLogin(form) {
  const f = form.elements;
  const msg = el().querySelector('#auth-msg');
  if (msg) msg.innerHTML = '';
  form.querySelectorAll('[aria-invalid]').forEach((i) => { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); });
  const values = { username: f.username.value, password: f.password.value, bootstrap: f.bootstrap && f.bootstrap.value };
  maskPasswords(form);
  setBusy(form, true);
  try {
    if (mode === 'invite') {
      await signUp(values.username, values.password, values.bootstrap, invite.first ? '' : invite.code);
      forgetInviteInUrl();
      invite.code = ''; invite.status = 'none';
    } else await signIn(values.username, values.password);
    route();
  } catch (err) {
    setBusy(form, false);
    if (err instanceof UserApiError && err.code === 'invite_invalid') { invite.status = 'invalid'; invite.first = false; showLogin(errorText(err)); return; }
    showFormError(form, err);
  }
}

// ---------- Choix du profil ----------
let manage = false;

function profileTile(p) {
  return '<button type="button" class="pf" data-pf="' + esc(p.id) + '" aria-label="' + esc(p.name + (p.isKid ? ', profil enfant' : '') + (p.hasPin ? ', verrouillé' : '') + (manage ? ', modifier' : '')) + '">' +
    '<span class="pf-av"' + avatarAttrs(p.avatar, p.avatarColor || COLORS[0]) + '>' + esc(initialOfName(p.name)) +
    (p.hasPin ? '<span class="pf-lock" aria-hidden="true">' + ICON.lock + '</span>' : '') +
    (manage ? '<span class="pf-edit" aria-hidden="true">' + ICON.pencil + '</span>' : '') + '</span>' +
    '<span class="pf-name">' + esc(p.name) + '</span>' + (p.isKid ? '<em class="pf-kid">Enfant</em>' : '') + '</button>';
}

/**
 * Seul le profil principal gère les profils : « Gérer les profils » et « Ajouter un profil » sont masqués pour les autres.
 * Sans profil actif (connexion), le bouton reste proposé et demande le code du profil principal.
 */
const mayManage = () => canManageProfiles();
const offerManage = () => mayManage() || !auth.profile;

function pickerHTML(note) {
  if (manage && !mayManage()) manage = false;
  return '<div class="auth-card auth-wide"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">' + (manage ? 'Gérer les profils' : 'Qui regarde ?') + '</h1>' +
    '<div class="pf-grid" role="list">' + auth.profiles.map(profileTile).join('') +
    (mayManage() ? '<button type="button" class="pf pf-add" data-pf-add aria-label="Ajouter un profil"><span class="pf-av">+</span><span class="pf-name">Ajouter un profil</span></button>' : '') + '</div>' +
    '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(note || '') + '</p>' +
    '<div class="tv-form-actions auth-actions">' + (offerManage() ? '<button type="button" class="btn btn-ghost" data-pf-manage aria-pressed="' + manage + '">' + (manage ? 'Terminé' : 'Gérer les profils') + '</button>' : '') +
    '<button type="button" class="btn btn-ghost" data-auth-signout>Se déconnecter</button>' +
    (resolveFlow ? '' : '<button type="button" class="btn btn-ghost" data-auth-close>Fermer</button>') + '</div></div>';
}

export function openPicker(note) {
  if (isProfileLocked()) return; // session verrouillée : jamais « Qui regarde ? »
  manage = false;
  show(pickerHTML(note));
  const first = el().querySelector('.pf');
  if (first) first.focus();
}

async function afterChoice() {
  // Le magasin de données a changé : on repart d'un état propre.
  if (resolveFlow) route();
  else { location.hash = '#/'; location.reload(); }
}

async function pick(id) {
  const p = auth.profiles.find((x) => x.id === id);
  if (!p) return;
  if (manage) { editProfile(p); return; }
  try {
    await chooseProfile(id);
    await afterChoice();
  } catch (err) {
    if (err instanceof UserApiError && err.code === 'pin_required') {
      pinPad({ title: 'Code de ' + p.name, profile: p, onOk: async () => { await chooseProfile(id); hidePad(); await afterChoice(); } });
    } else {
      const m = el().querySelector('#auth-msg');
      if (m) m.textContent = errorText(err);
    }
  }
}

// ---------- Clavier PIN ----------
let pad = null;

export function hidePad() {
  if (pad && pad.node) pad.node.remove();
  if (pad && pad.onKey) document.removeEventListener('keydown', pad.onKey, true);
  pad = null;
}

/**
 * Clavier PIN. `profile` : profil à déverrouiller ; `choices` : plusieurs profils possibles (PIN d'un adulte).
 * `onOk` est appelé quand le serveur accepte le code.
 */
/** @param {{ title: string, profile?: any, choices?: any[] | null, onOk: (p: any) => Promise<void>, onCancel?: (() => void) | null }} opts */
export function pinPad({ title, profile = null, choices = null, onOk, onCancel = null }) {
  hidePad();
  const node = document.createElement('div');
  node.className = 'pin-back';
  const state = { digits: '', busy: false, profile: profile || (choices && choices[0]) };
  const render = (msg) => {
    node.innerHTML = '<div class="pin" role="dialog" aria-modal="true" aria-labelledby="pin-title"><h2 id="pin-title" class="pin-title">' + esc(title) + '</h2>' +
      (choices && choices.length > 1 ? '<div class="pills pin-choices" role="group" aria-label="Profil adulte">' + choices.map((c) =>
        '<button type="button" class="pill" data-pin-who="' + esc(c.id) + '" aria-pressed="' + (c.id === state.profile.id) + '">' + esc(c.name) + '</button>').join('') + '</div>' : '') +
      '<div class="pin-dots" aria-label="' + state.digits.length + ' chiffres saisis">' + [0, 1, 2, 3].map((i) => '<span class="' + (i < state.digits.length ? 'is-on' : '') + '"></span>').join('') + '</div>' +
      '<p class="pin-msg" role="alert">' + esc(msg || '') + '</p>' +
      '<div class="pin-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '<button type="button" data-pin-key="' + n + '">' + n + '</button>').join('') +
      '<button type="button" data-pin-cancel aria-label="Annuler">Annuler</button><button type="button" data-pin-key="0">0</button>' +
      '<button type="button" data-pin-back aria-label="Effacer">' + ICON.back + '</button></div></div>';
  };
  const submit = async () => {
    state.busy = true;
    try {
      await unlock(state.profile.id, state.digits);
      await onOk(state.profile);
    } catch (err) {
      state.digits = '';
      state.busy = false;
      render(errorText(err));
    }
  };
  const press = (d) => {
    if (state.busy || state.digits.length >= 4) return;
    state.digits += d;
    render('');
    if (state.digits.length === 4) submit();
  };
  node.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const k = t.closest('[data-pin-key]');
    if (k) { press(k.dataset.pinKey); return; }
    if (t.closest('[data-pin-back]')) { state.digits = state.digits.slice(0, -1); render(''); return; }
    const who = t.closest('[data-pin-who]');
    if (who) { state.profile = choices.find((c) => c.id === who.dataset.pinWho); state.digits = ''; render(''); return; }
    if (t.closest('[data-pin-cancel]') || t === node) { hidePad(); if (onCancel) onCancel(); }
  });
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); state.digits = state.digits.slice(0, -1); render(''); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hidePad(); if (onCancel) onCancel(); }
  };
  document.addEventListener('keydown', onKey, true);
  pad = { node, onKey };
  render('');
  document.body.appendChild(node);
}

// ---------- Édition d'un profil ----------
function editProfile(p) {
  if (!mayManage() || isProfileLocked()) return;
  // Page plein écran ; après un enregistrement ou une suppression, retour à « Gérer les profils ».
  const open = (profile) => openProfileEditor(profile, { errorText, onDone: () => { manage = true; show(pickerHTML()); } });
  if (p && p.hasPin && !hasValidToken(p.id)) {
    pinPad({ title: 'Code de ' + p.name, profile: p, onOk: async () => { hidePad(); open(p); } });
    return;
  }
  open(p);
}


// ---------- Quitter un profil enfant ----------
/**
 * Depuis un profil enfant : changer de profil, ouvrir « Qui regarde ? », se déconnecter ou accéder aux réglages exige le
 * code parental (PIN du profil principal, vérifié par le serveur : 5 essais puis blocage de 5 minutes). Rien n'est
 * gardé en clair. Sans code défini, le principal est invité à en choisir un (réglages) et l'écran s'ouvre.
 */
export function leaveKidProfile() {
  const main = parentalProfile();
  if (!main || !main.hasPin) { openPicker(); return; }
  pinPad({ title: 'Code parental', profile: main, onOk: async () => { grantManager(main.id); hidePad(); openPicker(); } });
}

// ---------- Orchestration ----------
function route() {
  if (auth.status === 'needs-login') { showLogin(); return; }
  if (offlineWithoutSession()) { showLogin(OFFLINE_MSG); return; }
  if (auth.status === 'needs-profile') { openPicker(); return; }
  hide();
  if (resolveFlow) { const r = resolveFlow; resolveFlow = null; r(); }
  else location.reload();
}

/** Affiche l'écran requis par l'état de connexion ; se résout quand le profil est prêt. */
export function runAuthFlow() {
  if (auth.status !== 'needs-login' && auth.status !== 'needs-profile' && !offlineWithoutSession()) return Promise.resolve();
  return new Promise((resolve) => {
    resolveFlow = resolve;
    route();
  });
}

/** Réglages → « Se connecter » : ouvre l'écran de connexion, puis recharge. */
export function openLogin() {
  mode = 'login';
  resolveFlow = null;
  showLogin();
}

document.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !t.closest('#auth')) return;
  const eye = t.closest('[data-pw-toggle]');
  if (eye) {
    const input = eye.parentElement && eye.parentElement.querySelector('input');
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    eye.innerHTML = reveal ? EYE_OFF_SVG : EYE_SVG;
    eye.setAttribute('aria-label', reveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    return;
  }
  const m = t.closest('[data-auth-mode]');
  if (m) { setMode(m.dataset.authMode); showLogin(); return; }
  if (t.closest('[data-invite-first]')) { invite.first = true; showLogin(); return; }
  if (t.closest('[data-auth-signout]')) { await signOut(); if (resolveFlow) showLogin(); else location.reload(); return; }
  const pf = t.closest('[data-pf]');
  if (pf) { pick(pf.dataset.pf); return; }
  if (t.closest('[data-auth-close]')) { hide(); return; }
  if (t.closest('[data-pf-add]')) { editProfile(null); return; }
  if (t.closest('[data-pf-manage]')) {
    if (manage) { manage = false; show(pickerHTML()); return; }
    if (mayManage()) { manage = true; show(pickerHTML()); return; }
    // Aucun profil actif : le profil principal se reconnaît par son code.
    const main = parentalProfile() || auth.profiles.find((p) => p.isMainProfile);
    if (!main) return;
    const grant = () => { grantManager(main.id); hidePad(); manage = true; show(pickerHTML()); };
    if (main.hasPin) pinPad({ title: 'Code du profil principal', profile: main, onOk: async () => grant() });
    else grant();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'auth-form') { e.preventDefault(); submitLogin(e.target); return; }
  if (e.target && e.target.matches && e.target.matches('[data-invite-form]')) {
    e.preventDefault();
    void validateInvite(e.target.elements.code.value);
  }
});

// Lien complet ou code collé dans le champ d'invitation : vérifié aussitôt (le texte n'est dans le champ qu'après l'événement).
document.addEventListener('paste', (e) => {
  const t = e.target instanceof HTMLInputElement ? e.target : null;
  if (!t || t.name !== 'code' || !t.closest('[data-invite-form]')) return;
  setTimeout(() => { void validateInvite(t.value); }, 0);
});

