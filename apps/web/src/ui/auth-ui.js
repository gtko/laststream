/* Comptes : écran de connexion, choix du profil (façon Netflix), clavier PIN, gestion des profils, mode enfant. */
import {
  auth, canManageProfiles, chooseProfile, grantManager, hasValidToken, isProfileLocked, offlineWithoutSession, parentalProfile,
  removeProfile, saveProfile, signIn, signOut, signUp, unlock,
} from '../data/auth';
import { KID_SECTIONS, sectionAllowed } from '../data/kid';
import { checkInviteTicket, normalizeInviteCode, parseInviteCode, withoutInvite } from '../data/invite';
import { getBase, isOfficialBase } from '../data/config';
import { KID_AGES, me as readMe, UserApiError } from '../data/userApi';
import { isValidAvatar, parseColAvatar } from '../data/avatars';
import { isKidAllowed, loadCatalog, recentAvatars } from '../data/avatar-catalog';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { closeAvatarStudio, describeAvatar, describeAvatarSync, openAvatarStudio } from './avatar-studio.js';
import { openHouseholdPanel, paintProfileInviteRow, profileInviteRowHTML } from './household.js';
import { brand } from './fragments.js';
import { ICON } from './icons.js';
import { mountReferral, referralReasonText } from './referral-join.js';
import { esc } from './util.js';

const COLORS = ['#ff5a36', '#7b5bf5', '#19c3a6', '#f5b700', '#3b82f6', '#ec4899', '#22c55e', '#94a3b8'];
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

/** Étape 1 de « Rejoindre Laststream » : coller le lien (ou le code), puis valider. Le lien est vérifié auprès du serveur. */
function inviteCodeHTML(msg) {
  const st = invite.status;
  const note = msg || (st === 'invalid'
    ? (referralReasonText(invite.reason) || 'Ce lien d’invitation est invalide, déjà utilisé ou révoqué. Demande un nouveau lien à la personne qui t’invite.')
    : st === 'checking' ? 'Vérification du lien…' : '');
  return '<form class="tv-form auth-form auth-invite" data-invite-form>' +
    '<label class="tv-field">Colle ton lien ou code d’invitation<input type="text" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" value="' + esc(st === 'invalid' ? '' : invite.code) + '"></label>' +
    '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(note) + '</p>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">Valider</button></div>' +
    '<p class="tv-form-note">Le lien entier ou seulement son code : les deux fonctionnent.</p></form>' +
    (isOfficialBase(getBase()) ? '' : '<button type="button" class="link-btn" data-invite-first>C’est le premier compte de ce serveur</button>');
}

/** Étape 2 : l'invitation est reconnue (qui invite). Rien à afficher pour le premier compte du serveur. */
function inviteStatusHTML() {
  if (invite.first) return '';
  if (invite.status === 'valid') return '<p class="auth-invite-ok" role="status">' + (invite.inviter ? 'Invité par <strong>' + esc(invite.inviter) + '</strong>' : 'Lien d’invitation valide') + '</p>';
  return '<p class="auth-invite-ok" role="status">Lien d’invitation enregistré (vérifié à l’inscription).</p>';
}

/** Nom d’utilisateur et mot de passe ; à l’inscription, le jeton d’amorçage du premier compte si le serveur l’exige. */
function credentialsFormHTML(reg, msg) {
  return '<form id="auth-form" class="tv-form auth-form" autocomplete="on">' +
    '<label class="tv-field">Nom d’utilisateur<input type="text" name="username" autocomplete="username" autocapitalize="none" required value=""></label>' +
    '<label class="tv-field">Mot de passe<input type="password" name="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required></label>' +
    (reg && invite.first ? '<label class="tv-field">Jeton d’amorçage (premier compte, si le serveur l’exige)<input type="password" name="bootstrap" autocomplete="off"></label>' : '') +
    '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(msg || '') + '</p>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">' + (reg ? 'Créer mon compte' : 'Se connecter') + '</button></div></form>';
}

/** Vue « Connexion » (par défaut) : le formulaire, puis « Pas encore de compte ? » pour ouvrir l’invitation. */
function loginViewHTML(msg) {
  return '<h1 class="auth-title">Connexion</h1>' + credentialsFormHTML(false, msg) +
    '<section class="auth-new" aria-labelledby="auth-new-title"><h2 class="auth-sub" id="auth-new-title">Pas encore de compte ?</h2>' +
    '<p class="tv-form-note">Les comptes se créent sur invitation : demande un lien à un ami déjà inscrit.</p>' +
    '<button type="button" class="btn auth-new-btn" data-auth-mode="invite">J’ai un lien d’invitation</button></section>';
}

/** Vue « Rejoindre Laststream » : coller le lien (étape 1), puis créer son compte (étape 2). */
function inviteViewHTML(msg) {
  const ready = invite.first || invite.status === 'valid' || invite.status === 'unknown';
  return '<h1 class="auth-title">Rejoindre Laststream</h1>' +
    (ready ? inviteStatusHTML() + credentialsFormHTML(true, msg) : inviteCodeHTML(msg)) +
    '<button type="button" class="link-btn" data-auth-mode="login">← J’ai déjà un compte</button>';
}

function loginHTML(msg) {
  const body = mode === 'invite' ? inviteViewHTML(msg) : loginViewHTML(msg);
  return '<div class="auth-card"><div class="auth-brand">' + brand() + '</div>' + body +
    (isOfficialBase(getBase()) ? '' : '<p class="tv-form-note">Le compte vit sur ton serveur lastAddon : profils, bibliothèque et progression y sont enregistrés.</p>') +
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

async function submitLogin(form) {
  const f = form.elements;
  const msg = el().querySelector('#auth-msg');
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  if (msg) msg.textContent = '';
  try {
    if (mode === 'invite') {
      await signUp(f.username.value, f.password.value, f.bootstrap && f.bootstrap.value, invite.first ? '' : invite.code);
      forgetInviteInUrl();
      invite.code = ''; invite.status = 'none';
    } else await signIn(f.username.value, f.password.value);
    route();
  } catch (err) {
    btn.disabled = false;
    if (err instanceof UserApiError && err.code === 'invite_invalid') { invite.status = 'invalid'; invite.first = false; showLogin(errorText(err)); return; }
    if (msg) msg.textContent = errorText(err);
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
  const open = (profile) => profileEditor(profile);
  if (p && p.hasPin && !hasValidToken(p.id)) {
    pinPad({ title: 'Code de ' + p.name, profile: p, onOk: async () => { hidePad(); open(p); } });
    return;
  }
  open(p);
}

/** Crédits des illustrations : ré-exportés depuis avatar-picker.js (réglages). */
export { creditsHTML } from './avatar-picker.js';

/**
 * Éditeur de profil (maquette « Main ») : avatar actuel avec « Changer d'avatar » (studio), « Récemment utilisés », nom,
 * profil enfant, puis les options existantes (âge, rubriques, code parental, PIN). Enregistrer / Supprimer en pied.
 */
function profileEditor(p) {
  if (isProfileLocked()) return;
  const isNew = !p;
  const cur = p || { name: '', avatarColor: COLORS[0], isKid: false, kidMaxAge: 12, hasPin: false };
  const node = document.createElement('div');
  node.className = 'pin-back pf-back';
  node.innerHTML = '<form class="pf-modal pf-editor pfe" role="dialog" aria-modal="true" aria-labelledby="pfe-title">' +
    '<header class="pf-head"><h2 id="pfe-title" class="pf-title">' + (isNew ? 'Nouveau profil' : 'Modifier le profil') + '</h2>' +
    '<button type="button" class="pf-x" data-pfe-cancel aria-label="Fermer" title="Fermer">' + ICON.close + '</button></header>' +
    '<div class="pf-body pfe-body">' +
    '<div class="pfe-avatar-row">' +
    '<button type="button" class="pfe-avatar" data-pfe-studio tabindex="-1" aria-hidden="true"><span data-pfe-art></span><span class="pfe-badge">' + ICON.pencil + '</span></button>' +
    '<div class="pfe-avatar-info"><span class="pfe-muted">Avatar actuel</span><span class="pfe-avatar-name" data-pfe-avname></span>' +
    '<span class="pfe-muted" data-pfe-avsub></span>' +
    '<button type="button" class="btn btn-primary pfe-change" data-pfe-studio>Changer d\'avatar</button></div></div>' +
    '<div class="pfe-recent" data-pfe-recent hidden><span class="pfe-muted">Récemment utilisés</span><div class="pfe-recent-list" data-pfe-recent-list></div></div>' +
    '<div class="pfe-color"><span class="pfe-muted" id="pfe-color-label">Couleur</span><div class="pfe-colors" role="group" aria-labelledby="pfe-color-label" data-pfe-colors>' +
    COLORS.map((c) => '<button type="button" class="pfe-color-btn" data-pfe-color="' + c + '" aria-label="Couleur ' + c + '" aria-pressed="false" style="background:' + c + '"></button>').join('') + '</div></div>' +
    '<label class="tv-field">Nom du profil<input type="text" name="name" maxlength="40" required value="' + esc(cur.name) + '"></label>' +
    '<label class="pfe-kid"><span class="pfe-kid-text"><strong>Profil enfant</strong><small>Avatars et contenus adaptés aux enfants</small></span>' +
    '<input type="checkbox" name="kid"' + (cur.isKid ? ' checked' : '') + '></label>' +
    '<div class="pfe-kidwarn" data-pfe-kidwarn hidden role="alert"><p>Cet avatar n\'est pas disponible pour un profil enfant : choisis-en un autre.</p>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pfe-kidpick>Choisir un avatar enfant</button></div>' +
    '<div data-kidage' + (cur.isKid ? '' : ' hidden') + '><label class="tv-field">Âge maximal<select name="age">' + KID_AGES.map((a) =>
      '<option value="' + a + '"' + (a === (cur.kidMaxAge || 12) ? ' selected' : '') + '>' + a + ' ans</option>').join('') + '</select></label>' +
    '<fieldset class="pf-sections"><legend>Rubriques autorisées</legend>' + KID_SECTIONS.map(([id, label]) =>
      '<label class="set-check"><input type="checkbox" name="sec" value="' + id + '"' + (sectionAllowed(cur.allowedCatalogs, id) ? ' checked' : '') + '> <span>' + esc(label) + '</span></label>').join('') + '</fieldset></div>' +
    '<div data-parental' + (needsParentalCode(cur) ? '' : ' hidden') + '><p class="set-hint">Un profil enfant se quitte avec un code parental : celui du profil principal. Choisis-le maintenant (4 chiffres).</p>' +
    '<label class="tv-field">Code parental (4 chiffres)<input type="password" name="parental" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off"></label></div>' +
    '<label class="tv-field">Code PIN (4 chiffres)<input type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="' + (cur.hasPin ? 'Laisser vide pour garder' : 'Aucun') + '"></label>' +
    (cur.hasPin ? '<label class="set-check"><input type="checkbox" name="nopin"> <span>Retirer le code PIN</span></label>' : '') +
    profileInviteRowHTML(p) + '</div>' +
    '<footer class="pf-foot"><p class="pin-msg pf-msg" id="pfe-msg" role="alert"></p>' +
    '<div class="pf-actions">' + (isNew ? '' : '<button type="button" class="btn btn-ghost pf-del" data-pfe-delete>Supprimer le profil</button>') +
    '<button type="submit" class="btn btn-primary">Enregistrer</button></div></footer>' +
    '</form>';
  document.body.appendChild(node);
  void paintProfileInviteRow(node.querySelector('[data-hh-row]'), p);
  const form = node.querySelector('form');
  const msg = node.querySelector('#pfe-msg');
  const kidBox = form.elements.kid;
  const close = () => { closeAvatarStudio(); node.remove(); };
  const state = { avatar: isValidAvatar(cur.avatar) ? cur.avatar : null, color: cur.avatarColor || COLORS[0] };

  /** Avatar actuel : vignette sur la couleur du profil (ou initiale), nom et collection. */
  const paintArt = () => {
    const name = form.elements.name.value.trim();
    node.querySelector('[data-pfe-art]').innerHTML = '<span class="pfe-avatar-art"' + avatarAttrs(state.avatar, state.color) + '>' +
      (state.avatar ? '' : esc(initialOfName(name))) + '</span>';
    hydrateAvatars(node);
    const sync = describeAvatarSync(state.avatar);
    node.querySelector('[data-pfe-avname]').textContent = sync.name;
    node.querySelector('[data-pfe-avsub]').textContent = sync.sub;
    const wanted = state.avatar;
    void describeAvatar(wanted).then((d) => {
      if (state.avatar !== wanted || !node.isConnected) return;
      node.querySelector('[data-pfe-avname]').textContent = d.name;
      node.querySelector('[data-pfe-avsub]').textContent = d.sub;
    });
  };

  /** Couleur de repli : la pastille de la couleur courante est marquée. */
  const paintColors = () => {
    node.querySelectorAll('[data-pfe-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pfeColor.toLowerCase() === String(state.color).toLowerCase())));
  };

  /** Avatar d'un profil enfant : vérifié contre le catalogue ; avertit et propose le studio enfant si non autorisé. */
  async function checkKid() {
    const warn = node.querySelector('[data-pfe-kidwarn]');
    if (!kidBox.checked || !state.avatar) { warn.hidden = true; return; }
    let cat = null;
    try { cat = await loadCatalog(); } catch { cat = null; }
    if (!node.isConnected) return;
    warn.hidden = !kidBox.checked || (cat ? isKidAllowed(cat, state.avatar) : !parseColAvatar(state.avatar));
  }

  const openStudio = (kidMode) => openAvatarStudio({
    profile: { id: cur.id, name: form.elements.name.value.trim() },
    kid: kidMode,
    current: state.avatar,
    color: state.color,
    onPick: (value, color) => {
      state.avatar = value;
      if (color) state.color = color;
      paintArt();
      paintColors();
      void checkKid();
    },
  });

  // Récemment utilisés : les derniers choix de ce profil (rien pour un profil nouveau). Profil enfant : seulement les
  // avatars autorisés ; catalogue indisponible, la rangée est masquée.
  const recents = isNew ? [] : recentAvatars(cur.id);
  async function renderRecents() {
    let shown = recents;
    if (kidBox.checked) {
      let cat = null;
      try { cat = await loadCatalog(); } catch { cat = null; }
      if (!node.isConnected) return;
      shown = !kidBox.checked ? recents : cat ? recents.filter((v) => isKidAllowed(cat, v)) : [];
    }
    node.querySelector('[data-pfe-recent]').hidden = shown.length === 0;
    node.querySelector('[data-pfe-recent-list]').innerHTML = shown.map((v) =>
      '<button type="button" class="pfe-recent-btn" data-pfe-recent="' + esc(v) + '" aria-label="' + esc(describeAvatarSync(v).name) + '">' +
      '<span class="pfe-recent-art"' + avatarAttrs(v, '#94a3b8') + '></span></button>').join('');
    hydrateAvatars(node);
  }

  form.elements.name.focus();
  paintArt();
  paintColors();
  void renderRecents();
  void checkKid();
  form.addEventListener('input', (e) => {
    if (e.target.name === 'name' && !state.avatar) paintArt();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'kid') return;
    node.querySelector('[data-kidage]').hidden = !e.target.checked;
    node.querySelector('[data-parental]').hidden = !(e.target.checked && needsParentalCode({ isKid: true }));
    void renderRecents();
    void checkKid();
  });
  node.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const inviteBtn = t.closest('[data-hh-invite]');
    if (inviteBtn) {
      openHouseholdPanel(cur, { opener: inviteBtn, onChange: () => void paintProfileInviteRow(node.querySelector('[data-hh-row]'), cur) });
      return;
    }
    if (t.closest('[data-pfe-cancel]') || t === node) { close(); return; }
    if (t.closest('[data-pfe-studio]')) { openStudio(kidBox.checked); return; }
    if (t.closest('[data-pfe-kidpick]')) { openStudio(true); return; }
    const rb = t.closest('[data-pfe-recent]');
    if (rb) { state.avatar = rb.dataset.pfeRecent; paintArt(); void checkKid(); return; }
    const pc = t.closest('[data-pfe-color]');
    if (pc) { state.color = pc.dataset.pfeColor; paintArt(); paintColors(); return; }
    if (t.closest('[data-pfe-delete]')) {
      if (!window.confirm('Supprimer le profil « ' + cur.name + ' » avec sa bibliothèque et sa progression ?')) return;
      try { await removeProfile(cur.id); close(); manage = true; show(pickerHTML()); } catch (err) { msg.textContent = errorText(err); }
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const input = { name: f.name.value.trim(), avatarColor: state.color, isKid: f.kid.checked };
    if (input.isKid) {
      input.kidMaxAge = Number(f.age.value);
      const chosen = Array.from(form.querySelectorAll('input[name="sec"]:checked')).map((x) => x.value);
      // Défaut (toutes les rubriques sauf la TV jeunesse) = liste vide.
      const isDefault = chosen.length === KID_SECTIONS.length - 1 && !chosen.includes('tv');
      input.allowedCatalogs = isDefault ? [] : chosen;
    }
    // Profil enfant : un avatar « collection » doit être autorisé (catalogue requis) ; sinon on bloque et on propose le studio enfant.
    if (input.isKid && parseColAvatar(state.avatar)) {
      let cat = null;
      try { cat = await loadCatalog(); } catch { cat = null; }
      if (!cat || !isKidAllowed(cat, state.avatar)) {
        node.querySelector('[data-pfe-kidwarn]').hidden = false;
        return;
      }
    }
    if (state.avatar !== (cur.avatar || null)) input.avatar = state.avatar;
    const pin = f.pin.value.trim();
    if (pin && !/^\d{4}$/.test(pin)) { msg.textContent = 'Le code PIN compte 4 chiffres.'; return; }
    const parental = f.parental ? f.parental.value.trim() : '';
    const mustSetParental = input.isKid && needsParentalCode({ isKid: true });
    if (mustSetParental && !/^\d{4}$/.test(parental)) { msg.textContent = 'Choisis un code parental à 4 chiffres : il protège la sortie du profil enfant.'; return; }
    if (pin) input.pin = pin;
    else if (f.nopin && f.nopin.checked) input.pin = null;
    try {
      // Pas encore de code parental : le profil principal en reçoit un avant que l'enfant soit créé ou modifié.
      // Le PIN tout juste posé verrouille le principal : on le déverrouille aussitôt pour que la création de l'enfant passe.
      if (mustSetParental) {
        await saveProfile(parentalProfile().id, { pin: parental });
        await unlock(parentalProfile().id, parental);
      }
      await saveProfile(isNew ? null : cur.id, input);
      close();
      manage = true;
      show(pickerHTML());
    } catch (err) {
      msg.textContent = errorText(err);
    }
  });
}

/** Un profil enfant sans code parental défini : le profil principal doit en choisir un (modifier le principal lui-même exclu). */
function needsParentalCode(profile) {
  const m = parentalProfile();
  return !!profile.isKid && !!m && !m.hasPin;
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

