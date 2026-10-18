/* Comptes : écran de connexion, choix du profil (façon Netflix), clavier PIN, gestion des profils, mode enfant. */
import {
  auth, canManageProfiles, chooseProfile, continueWithoutAccount, grantManager, hasValidToken, parentalProfile,
  removeProfile, saveProfile, signIn, signOut, signUp, unlock,
} from '../data/auth';
import { KID_SECTIONS, sectionAllowed } from '../data/kid';
import { normalizeInviteCode, parseInviteCode, withoutInvite } from '../data/invite';
import { checkInvite } from '../data/socialApi';
import { KID_AGES, UserApiError } from '../data/userApi';
import { AVATAR_TABS, avatarCredits, HERO_FAMILIES, LICENSE_LABEL, LICENSE_URL, parseAvatar, parseHero, randomSeed, tabTiles } from '../data/avatars';
import { avatarAttrs } from './avatar-art.js';
import { brand } from './fragments.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

const COLORS = ['#ff5a36', '#7b5bf5', '#19c3a6', '#f5b700', '#3b82f6', '#ec4899', '#22c55e', '#94a3b8'];

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

export const initialOfName = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

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
    default: return 'Erreur (' + err.code + ').' + wait;
  }
}

// ---------- Connexion / création de compte ----------
/** Lien de parrainage : `?invite=<code>` ou `#/join/<code>` dans l'adresse, sinon code saisi à la main. */
const invite = { code: '', status: 'none', inviter: '', first: false };
let inviteToken = 0;

/** Vérifie le code auprès du serveur (sans session) : « invité par … » ou lien invalide. */
export async function checkInviteCode(raw) {
  const code = normalizeInviteCode(raw);
  const token = ++inviteToken;
  invite.code = code;
  invite.inviter = '';
  if (!code) { invite.status = raw && raw.trim() ? 'invalid' : 'none'; return invite.status; }
  invite.status = 'checking';
  try {
    const res = await checkInvite(code);
    if (token !== inviteToken) return invite.status;
    invite.status = res.valid ? 'valid' : 'invalid';
    invite.inviter = res.valid && res.inviter ? res.inviter : '';
  } catch {
    if (token === inviteToken) invite.status = 'unknown'; // serveur injoignable : le code sera vérifié à l'inscription
  }
  return invite.status;
}

let mode = 'login';

/** Lit le code d'invitation de l'adresse de la page (au démarrage) : l'inscription s'ouvre alors directement. */
export function readInviteFromLocation() {
  const code = parseInviteCode(location.search, location.hash);
  invite.first = false;
  invite.inviter = '';
  invite.code = code;
  invite.status = code ? 'checking' : 'none';
  mode = code ? 'register' : 'login';
}
readInviteFromLocation();

function forgetInviteInUrl() {
  const rest = withoutInvite(location.search, location.hash);
  try { history.replaceState(null, '', location.pathname + rest.search + rest.hash); } catch (_) { /* adresse inchangée */ }
}

function inviteBlockHTML() {
  const st = invite.status;
  const field = '<form class="tv-form auth-invite" data-invite-form><label class="tv-field">Code ou lien d’invitation<input type="text" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" value="' + esc(st === 'invalid' ? '' : invite.code) + '"></label>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">Valider le code</button></div></form>';
  if (st === 'valid') return '<p class="auth-invite-ok" role="status">' + (invite.inviter ? 'Invité par <strong>' + esc(invite.inviter) + '</strong>' : 'Lien d’invitation valide') + '</p>';
  if (st === 'checking') return '<p class="tv-form-msg" role="status">Vérification du lien…</p>';
  if (st === 'unknown') return '<p class="auth-invite-ok" role="status">Lien d’invitation enregistré (vérifié à l’inscription).</p>';
  return '<h2 class="auth-sub">Inscription sur invitation</h2>' +
    '<p class="tv-form-note">' + (st === 'invalid'
      ? 'Ce lien d’invitation est invalide, déjà utilisé ou révoqué. Demande un nouveau lien à la personne qui t’invite.'
      : 'Les comptes se créent avec un lien de parrainage : demande-le à un ami déjà inscrit, ou saisis ici le code reçu.') + '</p>' +
    field + '<button type="button" class="link-btn" data-invite-first>C’est le premier compte de ce serveur</button>';
}

function loginHTML(msg) {
  const reg = mode === 'register';
  const showForm = !reg || invite.status === 'valid' || invite.status === 'unknown' || invite.first;
  return '<div class="auth-card"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">' + (reg ? 'Créer un compte' : 'Connexion') + '</h1>' +
    '<div class="pills" role="group" aria-label="Mode"><button type="button" class="pill" data-auth-mode="login" aria-pressed="' + !reg + '">Connexion</button>' +
    '<button type="button" class="pill" data-auth-mode="register" aria-pressed="' + reg + '">Créer un compte</button></div>' +
    (reg && !invite.first ? inviteBlockHTML() : '') +
    (showForm ? '<form id="auth-form" class="tv-form auth-form" autocomplete="on">' +
      '<label class="tv-field">Nom d’utilisateur<input type="text" name="username" autocomplete="username" autocapitalize="none" required value=""></label>' +
      '<label class="tv-field">Mot de passe<input type="password" name="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required></label>' +
      (reg && invite.first ? '<label class="tv-field">Jeton d’amorçage (premier compte, si le serveur l’exige)<input type="password" name="bootstrap" autocomplete="off"></label>' : '') +
      '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(msg || '') + '</p>' +
      '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">' + (reg ? 'Créer le compte' : 'Se connecter') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-auth-local>Continuer sans compte</button></div>' +
      '<p class="tv-form-note">Le compte vit sur ton serveur lastAddon : profils, bibliothèque et progression y sont enregistrés. Sans compte, tout reste dans ce navigateur.</p></form>'
      : '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(msg || '') + '</p>' +
        '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-auth-local>Continuer sans compte</button></div>') +
    '</div>';
}

function showLogin(msg) {
  show(loginHTML(msg));
  const u = el().querySelector('input[name="username"]') || el().querySelector('input[name="code"]');
  if (u) u.focus();
  if (mode === 'register' && invite.status === 'checking') {
    checkInviteCode(invite.code).then(() => { if (!root.hidden && mode === 'register') showLogin(); });
  }
}

async function submitLogin(form) {
  const f = form.elements;
  const msg = el().querySelector('#auth-msg');
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  if (msg) msg.textContent = '';
  try {
    if (mode === 'register') {
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

function hidePad() {
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
  if (!mayManage()) return;
  const open = (profile) => profileEditor(profile);
  if (p && p.hasPin && !hasValidToken(p.id)) {
    pinPad({ title: 'Code de ' + p.name, profile: p, onOk: async () => { hidePad(); open(p); } });
    return;
  }
  open(p);
}

/** Crédits des illustrations (CC BY 4.0 et licences à attribution) : liste des illustrateurs et licences. */
export function creditsHTML() {
  return '<ul class="av-credits">' + avatarCredits().map((c) =>
    '<li><strong>' + esc(c.creator) + '</strong> : ' + c.styles.map((st) => '<a href="' + esc(st.source) + '" target="_blank" rel="noopener noreferrer">' + esc(st.label) + '</a>').join(', ') +
    ' · <a href="' + esc(LICENSE_URL[c.license]) + '" target="_blank" rel="noopener noreferrer">' + esc(LICENSE_LABEL[c.license]) + '</a></li>').join('') +
    '</ul><p class="av-credits">Avatars « Héros » : dessins originaux laststream, générés en local.</p><p class="av-credits">Avatars générés avec <a href="https://www.dicebear.com" target="_blank" rel="noopener noreferrer">DiceBear</a> (MIT), en local sur ton appareil.</p>';
}

function avatarPickerHTML() {
  return '<section class="pf-picker-avatars" aria-labelledby="pfe-av-title"><h3 class="pf-section-title" id="pfe-av-title">Avatar</h3>' +
    '<div class="av-tabs pills" role="tablist" aria-label="Familles d’avatars">' + AVATAR_TABS.map((t) =>
      '<button type="button" class="pill" role="tab" data-av-tab="' + t.id + '" aria-pressed="false">' + esc(t.label) + '</button>').join('') + '</div>' +
    '<div class="av-subs pills" role="group" aria-label="Types de héros" data-av-subs>' + HERO_FAMILIES.map((f) =>
      '<button type="button" class="pill" data-av-sub="' + f.id + '" aria-pressed="false">' + esc(f.label) + '</button>').join('') + '</div>' +
    '<div class="av-tools"><input class="set-input" type="search" name="avsearch" maxlength="40" placeholder="Un prénom pour essayer…" aria-label="Chercher un avatar à partir d’un mot" autocomplete="off">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-av-random>Au hasard</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-av-none>Initiale</button></div>' +
    '<div class="av-grid" data-av-grid role="group" aria-label="Avatars"></div>' +
    '<button type="button" class="btn btn-ghost btn-sm av-more" data-av-more>Voir plus</button>' +
    '<details class="av-credits-more"><summary>Crédits des illustrations</summary>' + creditsHTML() + '</details></section>';
}

/**
 * Sélecteur d'avatars du formulaire : onglets par famille, recherche / au hasard, grille paginée (rendu à la demande).
 * `onPick(avatar)` est appelé à chaque choix (vignette ou « Initiale »).
 */
function avatarPicker(node, cur, onPick = () => {}) {
  const PAGE = 48;
  const parsed = parseAvatar(cur.avatar);
  const hero = parseHero(cur.avatar);
  const valid = !!(parsed || hero);
  const state = { avatar: valid ? cur.avatar : null, tab: hero ? 'heroes' : parsed ? parsed.style.family : cur.isKid ? 'enfants' : 'heroes', sub: hero ? hero.family : 'heros', word: '', shown: PAGE, touched: valid };
  const grid = node.querySelector('[data-av-grid]');
  const more = node.querySelector('[data-av-more]');
  const render = () => {
    const tiles = tabTiles(state.tab, state.word, state.sub);
    grid.innerHTML = tiles.slice(0, state.shown).map((t) =>
      '<button type="button" class="av-tile"' + avatarAttrs(t.value, '#94a3b8') + ' data-av-pick="' + esc(t.value) + '" aria-pressed="' + (state.avatar === t.value) + '" aria-label="' + esc(t.style.label + ', ' + t.seed) + '"></button>').join('');
    more.hidden = state.shown >= tiles.length;
    node.querySelectorAll('[data-av-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avTab === state.tab)));
    node.querySelectorAll('[data-av-sub]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avSub === state.sub)));
    node.querySelector('[data-av-subs]').hidden = state.tab !== 'heroes';
  };
  node.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest('[data-av-tab]');
    if (tab) { state.tab = tab.dataset.avTab; state.shown = PAGE; state.touched = true; render(); return; }
    const sub = t.closest('[data-av-sub]');
    if (sub) { state.sub = sub.dataset.avSub; state.shown = PAGE; render(); return; }
    const pick = t.closest('[data-av-pick]');
    if (pick) { state.avatar = pick.dataset.avPick; render(); onPick(state.avatar); return; }
    if (t.closest('[data-av-none]')) { state.avatar = null; render(); onPick(null); return; }
    if (t.closest('[data-av-more]')) { state.shown += PAGE; render(); return; }
    if (t.closest('[data-av-random]')) {
      state.word = randomSeed();
      node.querySelector('input[name="avsearch"]').value = state.word;
      state.shown = PAGE;
      render();
    }
  });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.name === 'avsearch') e.preventDefault(); });
  node.addEventListener('input', (e) => {
    if (e.target.name !== 'avsearch') return;
    state.word = e.target.value;
    state.shown = PAGE;
    render();
  });
  render();
  return {
    value: () => state.avatar,
    kidChanged: (isKid) => { if (!state.touched) { state.tab = isKid ? 'enfants' : 'heroes'; state.shown = PAGE; render(); } },
  };
}

function profileEditor(p) {
  const isNew = !p;
  const cur = p || { name: '', avatarColor: COLORS[0], isKid: false, kidMaxAge: 12, hasPin: false };
  const node = document.createElement('div');
  node.className = 'pin-back pf-back';
  // Fenêtre : en-tête fixe (titre, fermer), corps défilant (aperçu + options à gauche, avatars à droite), pied fixe.
  node.innerHTML = '<form class="pf-modal pf-editor" role="dialog" aria-modal="true" aria-labelledby="pfe-title">' +
    '<header class="pf-head"><h2 id="pfe-title" class="pf-title">' + (isNew ? 'Nouveau profil' : 'Modifier le profil') + '</h2>' +
    '<button type="button" class="pf-x" data-pfe-cancel aria-label="Fermer" title="Fermer">' + ICON.close + '</button></header>' +
    '<div class="pf-body"><div class="pf-cols">' +
    '<div class="pf-side">' +
    '<div class="pf-preview-box"><div data-pfe-preview></div><p class="pf-preview-name" data-pfe-preview-name></p></div>' +
    '<label class="tv-field">Nom<input type="text" name="name" maxlength="40" required value="' + esc(cur.name) + '"></label>' +
    '<div class="pf-group"><span class="pf-label" id="pfe-color-label">Couleur</span><div class="pf-colors" role="radiogroup" aria-labelledby="pfe-color-label">' + COLORS.map((c) =>
      '<label class="pf-color" style="background:' + c + '"><input type="radio" name="color" value="' + c + '"' + (c.toLowerCase() === String(cur.avatarColor).toLowerCase() ? ' checked' : '') + '><span class="sr-only">' + c + '</span></label>').join('') + '</div></div>' +
    '<label class="set-check"><input type="checkbox" name="kid"' + (cur.isKid ? ' checked' : '') + '> <span>Profil enfant</span></label>' +
    '<div data-kidage' + (cur.isKid ? '' : ' hidden') + '><label class="tv-field">Âge maximal<select name="age">' + KID_AGES.map((a) =>
      '<option value="' + a + '"' + (a === (cur.kidMaxAge || 12) ? ' selected' : '') + '>' + a + ' ans</option>').join('') + '</select></label>' +
    '<fieldset class="pf-sections"><legend>Rubriques autorisées</legend>' + KID_SECTIONS.map(([id, label]) =>
      '<label class="set-check"><input type="checkbox" name="sec" value="' + id + '"' + (sectionAllowed(cur.allowedCatalogs, id) ? ' checked' : '') + '> <span>' + esc(label) + '</span></label>').join('') + '</fieldset></div>' +
    '<div data-parental' + (needsParentalCode(cur) ? '' : ' hidden') + '><p class="set-hint">Un profil enfant se quitte avec un code parental : celui du profil principal. Choisis-le maintenant (4 chiffres).</p>' +
    '<label class="tv-field">Code parental (4 chiffres)<input type="password" name="parental" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off"></label></div>' +
    '<label class="tv-field">Code PIN (4 chiffres)<input type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="' + (cur.hasPin ? 'Laisser vide pour garder' : 'Aucun') + '"></label>' +
    (cur.hasPin ? '<label class="set-check"><input type="checkbox" name="nopin"> <span>Retirer le code PIN</span></label>' : '') +
    '</div>' +
    '<div class="pf-main">' + avatarPickerHTML() + '</div>' +
    '</div></div>' +
    '<footer class="pf-foot"><p class="pin-msg pf-msg" id="pfe-msg" role="alert"></p>' +
    '<div class="pf-actions">' + (isNew ? '' : '<button type="button" class="btn btn-ghost pf-del" data-pfe-delete>Supprimer</button>') +
    '<button type="button" class="btn btn-ghost" data-pfe-cancel>Annuler</button><button type="submit" class="btn btn-primary">Enregistrer</button></div></footer>' +
    '</form>';
  document.body.appendChild(node);
  const form = node.querySelector('form');
  const msg = node.querySelector('#pfe-msg');
  const close = () => node.remove();
  // Aperçu en direct : avatar choisi (ou initiale), couleur et nom.
  const paintPreview = (avatar) => {
    const color = (form.querySelector('input[name="color"]:checked') || {}).value || COLORS[0];
    const name = form.elements.name.value.trim();
    node.querySelector('[data-pfe-preview]').innerHTML = '<span class="pf-av pf-av-lg"' + avatarAttrs(avatar, color) + '>' + esc(initialOfName(name)) + '</span>';
    node.querySelector('[data-pfe-preview-name]').textContent = name || 'Nouveau profil';
  };
  form.elements.name.focus();
  const av = avatarPicker(node, cur, paintPreview);
  paintPreview(av.value());
  form.addEventListener('input', (e) => {
    if (e.target.name === 'name') paintPreview(av.value());
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'color') paintPreview(av.value());
    if (e.target.name === 'kid') {
      node.querySelector('[data-kidage]').hidden = !e.target.checked;
      av.kidChanged(e.target.checked);
      node.querySelector('[data-parental]').hidden = !(e.target.checked && needsParentalCode({ isKid: true }));
    }
  });
  node.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-pfe-cancel]') || t === node) { close(); return; }
    if (t.closest('[data-pfe-delete]')) {
      if (!window.confirm('Supprimer le profil « ' + cur.name + ' » avec sa bibliothèque et sa progression ?')) return;
      try { await removeProfile(cur.id); close(); manage = true; show(pickerHTML()); } catch (err) { msg.textContent = errorText(err); }
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const input = { name: f.name.value.trim(), avatarColor: (form.querySelector('input[name="color"]:checked') || {}).value || COLORS[0], isKid: f.kid.checked };
    if (input.isKid) {
      input.kidMaxAge = Number(f.age.value);
      const chosen = Array.from(form.querySelectorAll('input[name="sec"]:checked')).map((x) => x.value);
      // Défaut (toutes les rubriques sauf la TV jeunesse) = liste vide.
      const isDefault = chosen.length === KID_SECTIONS.length - 1 && !chosen.includes('tv');
      input.allowedCatalogs = isDefault ? [] : chosen;
    }
    if (av.value() !== (cur.avatar || null)) input.avatar = av.value();
    const pin = f.pin.value.trim();
    if (pin && !/^\d{4}$/.test(pin)) { msg.textContent = 'Le code PIN compte 4 chiffres.'; return; }
    const parental = f.parental ? f.parental.value.trim() : '';
    const mustSetParental = input.isKid && needsParentalCode({ isKid: true });
    if (mustSetParental && !/^\d{4}$/.test(parental)) { msg.textContent = 'Choisis un code parental à 4 chiffres : il protège la sortie du profil enfant.'; return; }
    if (pin) input.pin = pin;
    else if (f.nopin && f.nopin.checked) input.pin = null;
    try {
      // Pas encore de code parental : le profil principal en reçoit un avant que l'enfant soit créé ou modifié.
      if (mustSetParental) await saveProfile(parentalProfile().id, { pin: parental });
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
  if (auth.status === 'needs-profile') { openPicker(); return; }
  hide();
  if (resolveFlow) { const r = resolveFlow; resolveFlow = null; r(); }
  else location.reload();
}

/** Affiche l'écran requis par l'état de connexion ; se résout quand le profil est prêt (ou le mode local choisi). */
export function runAuthFlow() {
  if (auth.status !== 'needs-login' && auth.status !== 'needs-profile') return Promise.resolve();
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
  if (m) { mode = m.dataset.authMode; invite.first = false; showLogin(); return; }
  if (t.closest('[data-invite-first]')) { invite.first = true; showLogin(); return; }
  if (t.closest('[data-auth-local]')) {
    continueWithoutAccount();
    if (resolveFlow) { hide(); const r = resolveFlow; resolveFlow = null; r(); } else { hide(); location.reload(); }
    return;
  }
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
    const raw = e.target.elements.code.value;
    invite.status = 'checking';
    checkInviteCode(raw).then(() => showLogin());
  }
});

