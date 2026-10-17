/* Comptes : écran de connexion, choix du profil (façon Netflix), clavier PIN, gestion des profils, mode enfant. */
import {
  adultsWithPin, auth, chooseProfile, continueWithoutAccount, hasValidToken, removeProfile,
  saveProfile, signIn, signOut, signUp, unlock,
} from '../data/auth';
import { KID_AGES, UserApiError } from '../data/userApi';
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
    case 'signup_disabled': return 'Les inscriptions sont fermées sur ce serveur.';
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
let mode = 'login';

function loginHTML(msg) {
  const reg = mode === 'register';
  return '<div class="auth-card"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">' + (reg ? 'Créer un compte' : 'Connexion') + '</h1>' +
    '<div class="pills" role="group" aria-label="Mode"><button type="button" class="pill" data-auth-mode="login" aria-pressed="' + !reg + '">Connexion</button>' +
    '<button type="button" class="pill" data-auth-mode="register" aria-pressed="' + reg + '">Créer un compte</button></div>' +
    '<form id="auth-form" class="tv-form auth-form" autocomplete="on">' +
    '<label class="tv-field">Nom d’utilisateur<input type="text" name="username" autocomplete="username" autocapitalize="none" required value=""></label>' +
    '<label class="tv-field">Mot de passe<input type="password" name="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required></label>' +
    (reg ? '<label class="tv-field">Jeton d’amorçage (premier compte, si le serveur l’exige)<input type="password" name="bootstrap" autocomplete="off"></label>' : '') +
    '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(msg || '') + '</p>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">' + (reg ? 'Créer le compte' : 'Se connecter') + '</button>' +
    '<button type="button" class="btn btn-ghost" data-auth-local>Continuer sans compte</button></div>' +
    '<p class="tv-form-note">Le compte vit sur ton serveur lastAddon : profils, bibliothèque et progression y sont enregistrés. Sans compte, tout reste dans ce navigateur.</p></form></div>';
}

function showLogin(msg) {
  show(loginHTML(msg));
  const u = el().querySelector('input[name="username"]');
  if (u) u.focus();
}

async function submitLogin(form) {
  const f = form.elements;
  const msg = el().querySelector('#auth-msg');
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  if (msg) msg.textContent = '';
  try {
    if (mode === 'register') await signUp(f.username.value, f.password.value, f.bootstrap && f.bootstrap.value);
    else await signIn(f.username.value, f.password.value);
    route();
  } catch (err) {
    btn.disabled = false;
    if (msg) msg.textContent = errorText(err);
  }
}

// ---------- Choix du profil ----------
let manage = false;

function profileTile(p) {
  return '<button type="button" class="pf" data-pf="' + esc(p.id) + '" aria-label="' + esc(p.name + (p.isKid ? ', profil enfant' : '') + (p.hasPin ? ', verrouillé' : '') + (manage ? ', modifier' : '')) + '">' +
    '<span class="pf-av" style="background:' + esc(p.avatarColor || COLORS[0]) + '">' + esc(initialOfName(p.name)) +
    (p.hasPin ? '<span class="pf-lock" aria-hidden="true">' + ICON.lock + '</span>' : '') +
    (manage ? '<span class="pf-edit" aria-hidden="true">' + ICON.pencil + '</span>' : '') + '</span>' +
    '<span class="pf-name">' + esc(p.name) + '</span>' + (p.isKid ? '<em class="pf-kid">Enfant</em>' : '') + '</button>';
}

function pickerHTML(note) {
  return '<div class="auth-card auth-wide"><div class="auth-brand">' + brand() + '</div>' +
    '<h1 class="auth-title">' + (manage ? 'Gérer les profils' : 'Qui regarde ?') + '</h1>' +
    '<div class="pf-grid" role="list">' + auth.profiles.map(profileTile).join('') +
    '<button type="button" class="pf pf-add" data-pf-add aria-label="Ajouter un profil"><span class="pf-av">+</span><span class="pf-name">Ajouter un profil</span></button></div>' +
    '<p class="tv-form-msg" id="auth-msg" role="alert">' + esc(note || '') + '</p>' +
    '<div class="tv-form-actions auth-actions"><button type="button" class="btn btn-ghost" data-pf-manage aria-pressed="' + manage + '">' + (manage ? 'Terminé' : 'Gérer les profils') + '</button>' +
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
  const open = (profile) => profileEditor(profile);
  if (p && p.hasPin && !hasValidToken(p.id)) {
    pinPad({ title: 'Code de ' + p.name, profile: p, onOk: async () => { hidePad(); open(p); } });
    return;
  }
  open(p);
}

function profileEditor(p) {
  const isNew = !p;
  const cur = p || { name: '', avatarColor: COLORS[0], isKid: false, kidMaxAge: 12, hasPin: false };
  const node = document.createElement('div');
  node.className = 'pin-back';
  node.innerHTML = '<form class="pin pf-editor" role="dialog" aria-modal="true" aria-labelledby="pfe-title"><h2 id="pfe-title" class="pin-title">' + (isNew ? 'Nouveau profil' : 'Modifier le profil') + '</h2>' +
    '<label class="tv-field">Nom<input type="text" name="name" maxlength="40" required value="' + esc(cur.name) + '"></label>' +
    '<div class="pf-colors" role="radiogroup" aria-label="Couleur">' + COLORS.map((c) =>
      '<label class="pf-color" style="background:' + c + '"><input type="radio" name="color" value="' + c + '"' + (c.toLowerCase() === String(cur.avatarColor).toLowerCase() ? ' checked' : '') + '><span class="sr-only">' + c + '</span></label>').join('') + '</div>' +
    '<label class="set-check"><input type="checkbox" name="kid"' + (cur.isKid ? ' checked' : '') + '> <span>Profil enfant</span></label>' +
    '<label class="tv-field" data-kidage' + (cur.isKid ? '' : ' hidden') + '>Âge maximal<select name="age">' + KID_AGES.map((a) =>
      '<option value="' + a + '"' + (a === (cur.kidMaxAge || 12) ? ' selected' : '') + '>' + a + ' ans</option>').join('') + '</select></label>' +
    '<label class="tv-field">Code PIN (4 chiffres)<input type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="' + (cur.hasPin ? 'Laisser vide pour garder' : 'Aucun') + '"></label>' +
    (cur.hasPin ? '<label class="set-check"><input type="checkbox" name="nopin"> <span>Retirer le code PIN</span></label>' : '') +
    '<p class="pin-msg" id="pfe-msg" role="alert"></p>' +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">Enregistrer</button><button type="button" class="btn btn-ghost" data-pfe-cancel>Annuler</button>' +
    (isNew ? '' : '<button type="button" class="btn btn-ghost" data-pfe-delete>Supprimer</button>') + '</div></form>';
  document.body.appendChild(node);
  const form = node.querySelector('form');
  const msg = node.querySelector('#pfe-msg');
  const close = () => node.remove();
  form.elements.name.focus();
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kid') node.querySelector('[data-kidage]').hidden = !e.target.checked;
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
    if (input.isKid) input.kidMaxAge = Number(f.age.value);
    const pin = f.pin.value.trim();
    if (pin && !/^\d{4}$/.test(pin)) { msg.textContent = 'Le code PIN compte 4 chiffres.'; return; }
    if (pin) input.pin = pin;
    else if (f.nopin && f.nopin.checked) input.pin = null;
    try {
      await saveProfile(isNew ? null : cur.id, input);
      close();
      manage = true;
      show(pickerHTML());
    } catch (err) {
      msg.textContent = errorText(err);
    }
  });
}

// ---------- Quitter un profil enfant ----------
/** Depuis un profil enfant : le PIN d'un profil adulte est exigé (s'il existe) avant de changer de profil. */
export function leaveKidProfile() {
  const adults = adultsWithPin();
  if (!adults.length) { openPicker(); return; }
  pinPad({ title: 'Code d’un profil adulte', choices: adults, onOk: async () => { hidePad(); openPicker(); } });
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
  if (m) { mode = m.dataset.authMode; showLogin(); return; }
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
  if (t.closest('[data-pf-manage]')) { manage = !manage; show(pickerHTML()); }
});

document.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'auth-form') { e.preventDefault(); submitLogin(e.target); }
});

