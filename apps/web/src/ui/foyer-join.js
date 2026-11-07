/* Invitation au foyer (#/foyer/<jeton>), page sans compte (contrat invitations v3, partie A). Parcours : arrivée (mur de fanart,
 * hôte et profil), formulaire (nom du profil, identifiant, mot de passe, conditions), bienvenue. Les liens expirés, déjà utilisés,
 * révoqués ou inconnus ont leur écran. Toute chaîne venant du serveur passe par esc() ; une image n'est affichée que si son adresse
 * est en https. `root` : conteneur de la vue détail, remplacé à chaque écran. Le mot de passe n'est jamais journalisé ni stocké. */
import '../styles/foyer.css';
import { adoptSession } from '../data/auth';
import { checkHouseholdInvite, householdErrorCode, redeemHouseholdInvite } from '../data/householdApi';
import { safeImageUrl } from '../data/imageUrl';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { esc } from './util.js';

/** Couleur de repli des avatars (le contrat ne transmet pas la couleur du profil). */
const AVATAR_COLOR = '#ff5a36';
/** Mot de passe : mêmes règles minimales que `register`. */
const PWD_MIN = 8;
const NAME_MAX = 32;
/** Champs du formulaire : identifiant de saisie `fj-<champ>`, message d'erreur `fj-<champ>-err`. */
const FIELD_OF_ID = { 'fj-name': 'name', 'fj-login': 'login', 'fj-pwd': 'pwd', 'fj-cgu': 'cgu' };
/** États d'un lien qui ont leur écran d'erreur (réponse de la vérification, ou code d'erreur du `redeem`). */
const LINK_STATES = ['expired', 'used', 'revoked', 'unknown'];
const BACKDROP_MAX = 12;
const CONFETTI = 14;
const CONFETTI_COLORS = ['#ff5a36', '#7b5bf5', '#19c3a6', '#f5b700', '#ff9a80'];
/** Jauge du mot de passe (indicative) : libellé selon le score de 0 à 4. Les couleurs sont dans foyer.css (`data-level`). */
const STRENGTH_LABELS = ['Choisis un mot de passe', 'Faible', 'Correct', 'Solide', 'Excellent'];
/** Numéro d'écran courant : un résultat d'API qui arrive après un changement d'écran est ignoré. */
let currentScreen = 0;
let screenSeq = 0;
const nextScreen = () => {
  currentScreen = ++screenSeq;
  return currentScreen;
};
/** Trois arguments du foyer affichés à l'arrivée. */
const PILLS = [
  { label: 'Ton propre mot de passe', body: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>' },
  { label: 'Ta bibliothèque à toi', body: '<path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 7h6"></path>' },
  { label: 'Extensions du foyer incluses', body: '<path d="M12 2l3 7h7l-5.5 4.5 2 7.5L12 17l-6.5 4 2-7.5L2 9h7z"></path>' },
];
/** Icônes d'écran d'erreur : couleur et classe d'animation. */
const ERROR_ICONS = {
  sand: { cls: 'fj-sand', color: '#f5b700', body: '<path d="M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10"></path>' },
  used: { cls: '', color: '#19c3a6', body: '<circle cx="8" cy="15" r="4"></circle><path d="M10.8 12.2 20 3M16 7l3 3"></path><path d="M14 18l2 2 4-4"></path>' },
  revoked: { cls: 'fj-wob', color: '#ef6b4a', body: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path><path d="M3 3l18 18"></path>' },
  unknown: { cls: '', color: '#a19dae', body: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"></path><path d="M12 17.5h.01"></path>' },
  offline: { cls: '', color: '#a19dae', body: '<path d="M2 8.8a15 15 0 0 1 20 0"></path><path d="M5 12.6a10 10 0 0 1 14 0"></path><path d="M8.5 16.1a5 5 0 0 1 7 0"></path><path d="M3 3l18 18"></path>' },
};

const icon = (size, body, cls = '') =>
  '<svg' + (cls ? ' class="' + cls + '"' : '') + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
const ARROW = icon(18, '<path d="M5 12h14M13 6l6 6-6 6"></path>', 'fj-arrow');
const PLAY = '<svg class="fj-arrow" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"></path></svg>';
const KEY = icon(24, '<g class="fj-turn"><circle cx="8" cy="15" r="4"></circle><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"></path></g>', 'fj-key-svg');
const CLOCK = icon(14, '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>');
const EYE = icon(20, '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>');
const LOGO = '<svg class="fj-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="#ff5a36"></rect><path d="M11 8.5 L24 16 L11 23.5Z" fill="#0c0b11"></path><rect x="8" y="12.2" width="18" height="1.6" fill="#ff5a36"></rect><rect x="8" y="15.2" width="18" height="1.6" fill="#ff5a36"></rect><rect x="8" y="18.2" width="18" height="1.6" fill="#ff5a36"></rect></svg>';

/** Score du mot de passe (0 à 4), même grille que la maquette : longueur, mélange de types, signes. */
function passwordScore(p) {
  if (!p) return 0;
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if ((/[A-Z]/.test(p) && /[a-z]/.test(p)) || /\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 16) score++;
  return score;
}

/** Temps restant avant `expiresAt` (« 2 j 23 h », « 5 h 12 min », « 40 min »), ou '' si la date est absente ou passée. */
function remainingText(expiresAt, now = Date.now()) {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return '';
  const min = Math.floor((end - now) / 60000);
  if (min <= 0) return '';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return d + ' j ' + h + ' h';
  if (h > 0) return h + ' h ' + String(m).padStart(2, '0') + ' min';
  return m + ' min';
}

/** Fonds acceptés : même règle que les billets (https, hôte autorisé, voir data/imageUrl.ts), les autres sont écartés. */
const backdropUrls = (list) => (Array.isArray(list) ? list : []).map((u) => safeImageUrl(u)).filter(Boolean).slice(0, BACKDROP_MAX);
/** Premier caractère (point de code entier, pas une unité de code UTF-16), en majuscule. */
const initialOf = (name) => (Array.from(String(name || '').trim())[0] || '?').toUpperCase();
/** Texte limité à `n` caractères (points de code entiers) : un nom prérempli ne dépasse jamais la longueur acceptée. */
const clip = (s, n) => Array.from(String(s || '')).slice(0, n).join('');
const hostName = (c) => (c && c.inviter && c.inviter.name) || '';
const profileName = (c) => (c && c.profile && c.profile.name) || '';

/** Mur de fanart : quatre rangées défilantes (sens alternés), ou un fond de repli sans image. */
function wallHTML(list) {
  const urls = backdropUrls(list);
  if (!urls.length) return '<div class="fj-wall fj-wall--plain" aria-hidden="true"></div>';
  const rows = ['fj-row--a', 'fj-row--b', 'fj-row--c', 'fj-row--d'].map((cls, r) => {
    const base = [];
    for (let i = 0; base.length < 6; i++) base.push(urls[(i + r * 3) % urls.length]);
    return '<div class="fj-row ' + cls + '">' + base.concat(base).map((u) => '<img class="fj-tile" src="' + esc(u) + '" alt="" loading="lazy" decoding="async">').join('') + '</div>';
  });
  return '<div class="fj-wall" aria-hidden="true"><div class="fj-rows">' + rows.join('') + '</div></div>';
}

/** Bandeau d'image (formulaire, bienvenue, erreurs) : la première image valide, ou le fond de repli. */
function bannerHTML(list, cls) {
  const [url] = backdropUrls(list);
  return '<div class="fj-banner ' + cls + (url ? '' : ' fj-banner--plain') + '" aria-hidden="true">' +
    (url ? '<img class="fj-banner-img" src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<div class="fj-banner-fade"></div></div>';
}

/** Avatar du profil ou de l'hôte : même rendu que les profils (avatar-art), initiale sur la couleur de repli. */
function avatarHTML(person, cls) {
  const p = person || {};
  return '<span class="fj-av ' + cls + '"' + avatarAttrs(p.avatar || null, AVATAR_COLOR) + ' aria-hidden="true">' + esc(initialOf(p.name)) + '</span>';
}

const wordmarkHTML = () => '<span class="fj-wordmark">' + LOGO + '<span>last<span class="fj-accent">stream</span></span></span>';

/** Copie des écrans d'erreur (états du lien, ou erreur de vérification). `host` : nom de l'hôte, s'il est connu. */
function errorCopy(state, host) {
  const who = host || 'la personne qui t’invite';
  switch (state) {
    case 'expired':
      return { title: 'Ce lien a expiré', body: 'Il n’est plus valable. Demande à ' + who + ' d’en générer un nouveau : ça prend deux secondes.', cta: 'J’ai déjà un accès', icon: 'sand' };
    case 'used':
      return { title: 'Ce lien a déjà servi', body: 'Un accès a déjà été créé avec cette invitation. Si c’était toi, connecte-toi simplement avec ton identifiant.', cta: 'Me connecter', icon: 'used' };
    case 'revoked':
      return { title: 'Invitation annulée', body: 'Cette invitation a été retirée. Si c’est une erreur, demande un nouveau lien à ' + who + '.', cta: 'J’ai déjà un accès', icon: 'revoked' };
    case 'network':
      return { title: 'Lien impossible à vérifier', body: 'lastAddon est injoignable. Vérifie ta connexion, puis réessaie.', cta: 'Réessayer', icon: 'offline', retry: true };
    case 'rate_limited':
      return { title: 'Trop de tentatives', body: 'Patiente une minute, puis réessaie.', cta: 'Réessayer', icon: 'offline', retry: true };
    default:
      return { title: 'Lien introuvable', body: 'Ce lien ne correspond à aucune invitation. Vérifie qu’il est complet, ou demande un nouveau lien à ' + who + '.', cta: 'J’ai déjà un accès', icon: 'unknown' };
  }
}

/** Retour à l'accueil : sans session, l'app affiche l'écran de connexion ; avec la session de l'invité, elle ouvre son profil. */
function goHome() {
  try { location.hash = '#/'; } catch (_) { /* adresse inchangée */ }
  location.reload();
}

/** Remplace le contenu de la vue, pose le focus sur le titre et branche les actions de l'écran. */
function paint(ctx, html, bind) {
  nextScreen();
  ctx.root.innerHTML = html;
  if (bind) bind(ctx.root);
  const title = ctx.root.querySelector('#fj-title');
  if (title) title.focus({ preventScroll: true });
  hydrateAvatars(ctx.root).catch(() => undefined);
}

/** Vérifie le lien (sans le consommer) puis affiche l'arrivée, ou l'écran d'erreur de son état. */
function start(ctx) {
  nextScreen();
  ctx.root.innerHTML ='<section class="fj-page fj-page--state" aria-busy="true"><div class="fj-center"><p class="fj-loading" role="status">Vérification du lien…</p></div></section>';
  checkHouseholdInvite(ctx.token).then(
    (res) => {
      const c = res && typeof res === 'object' ? res : {};
      ctx.check = { inviter: c.inviter, profile: c.profile, expiresAt: c.expiresAt, backdrops: c.backdrops };
      if (c.state === 'ok') showArrival(ctx);
      else showError(ctx, LINK_STATES.includes(c.state) ? c.state : 'unknown');
    },
    (err) => {
      const code = householdErrorCode(err);
      if (LINK_STATES.includes(code)) {
        showError(ctx, code);
        return;
      }
      showError(ctx, code === 'rate_limited' ? 'rate_limited' : 'network');
    },
  );
}

/** Écran d'arrivée : mur de fanart, arche avec le profil, hôte en bas à gauche, clé qui tourne, puis « Créer mon accès ». */
function showArrival(ctx) {
  const c = ctx.check;
  const host = hostName(c);
  const prof = profileName(c) || 'ce profil';
  const left = remainingText(c.expiresAt);
  const title = host ? host + ' te garde une place à la maison.' : 'Une place t’attend à la maison.';
  const html = '<section class="fj-page fj-page--arrival" aria-label="Invitation au foyer">' +
    wallHTML(c.backdrops) +
    '<div class="fj-shade" aria-hidden="true"></div><div class="fj-fade" aria-hidden="true"></div>' +
    '<header class="fj-top">' + wordmarkHTML() + '</header>' +
    '<div class="fj-center">' +
      '<div class="fj-crest fj-up" aria-hidden="true"><span class="fj-arch"></span>' +
        avatarHTML(c.profile, 'fj-av--profile fj-pop fj-d2') +
        (host ? avatarHTML(c.inviter, 'fj-av--host fj-pop') : '') +
        '<span class="fj-key">' + KEY + '</span>' +
      '</div>' +
      '<p class="fj-kicker fj-up fj-d1">Invitation au foyer</p>' +
      '<h1 id="fj-title" class="fj-h1 fj-up fj-d2" tabindex="-1">' + esc(title) + '</h1>' +
      '<p class="fj-lead fj-up fj-d3">Le profil « ' + esc(prof) + ' » t’attend dans son foyer Laststream : ton identifiant, ta bibliothèque, ton historique. Les extensions du foyer sont déjà prêtes.</p>' +
      '<ul class="fj-pills fj-up fj-d4">' + PILLS.map((p) => '<li class="fj-pill">' + icon(15, p.body) + '<span>' + esc(p.label) + '</span></li>').join('') + '</ul>' +
      '<button type="button" class="fj-cta fj-up fj-d5" data-fj-create><span class="fj-sweep" aria-hidden="true"></span><span class="fj-cta-label">Créer mon accès</span>' + ARROW + '</button>' +
      '<p class="fj-expiry fj-up fj-d6">' + CLOCK + '<span>Lien personnel à usage unique' + (left ? ' · expire dans ' + esc(left) : '') + '</span></p>' +
    '</div></section>';
  paint(ctx, html, (root) => {
    root.querySelector('[data-fj-create]').addEventListener('click', () => showForm(ctx));
  });
}

/** Écran d'erreur : lien expiré, déjà utilisé, révoqué, inconnu, ou serveur injoignable. */
function showError(ctx, state) {
  const c = ctx.check || {};
  const host = hostName(c);
  const prof = profileName(c);
  const copy = errorCopy(state, host);
  const ic = ERROR_ICONS[copy.icon];
  const kicker = host && prof ? 'Invitation de ' + host + ' · profil ' + prof : 'Invitation au foyer';
  const fine = copy.retry ? '' : '<p class="fj-fine fj-up fj-d3">Par sécurité, une invitation au foyer sert une seule fois et dure au plus 7 jours.</p>';
  const html = '<section class="fj-page fj-page--error" aria-label="Invitation au foyer">' +
    bannerHTML(c.backdrops, 'fj-banner--error') +
    '<div class="fj-center fj-center--error">' +
      '<div class="fj-tile-icon fj-up" aria-hidden="true" style="color:' + ic.color + '">' + icon(40, ic.body, ic.cls) + '</div>' +
      '<p class="fj-kicker fj-kicker--muted fj-up fj-d1">' + esc(kicker) + '</p>' +
      '<h1 id="fj-title" class="fj-h1 fj-h1--sm fj-up fj-d1" tabindex="-1">' + esc(copy.title) + '</h1>' +
      '<p class="fj-lead fj-up fj-d2">' + esc(copy.body) + '</p>' +
      '<div class="fj-stack fj-up fj-d3"><button type="button" class="fj-cta fj-cta--block" data-fj-action>' + esc(copy.cta) + '</button></div>' +
      fine +
    '</div></section>';
  paint(ctx, html, (root) => {
    root.querySelector('[data-fj-action]').addEventListener('click', () => (copy.retry ? start(ctx) : goHome()));
  });
}

/** Formulaire « Crée ton accès » : nom du profil prérempli, identifiant, mot de passe avec jauge, conditions. */
function showForm(ctx) {
  const c = ctx.check;
  const host = hostName(c);
  const prof = clip(profileName(c), NAME_MAX) || 'Nouveau profil';
  const html = '<section class="fj-page fj-page--form" aria-label="Créer mon accès">' +
    bannerHTML(c.backdrops, 'fj-banner--form') +
    '<div class="fj-bar">' +
      '<button type="button" class="fj-back" data-fj-back aria-label="Retour">' + icon(20, '<path d="M15 6l-6 6 6 6"></path>') + '</button>' +
      '<p class="fj-steps" role="img" aria-label="Étape 2 sur 3"><span class="is-done"></span><span class="is-current"></span><span></span></p>' +
      '<span class="fj-bar-spacer" aria-hidden="true"></span>' +
    '</div>' +
    '<form class="fj-form" data-fj-form novalidate>' +
      avatarHTML(c.profile, 'fj-av--square') +
      '<h1 id="fj-title" class="fj-h1 fj-h1--form" tabindex="-1">Crée ton accès</h1>' +
      '<p class="fj-sub">Profil <strong>' + esc(prof) + '</strong>' + (host ? ' · foyer de ' + esc(host) : '') + '</p>' +
      '<div class="fj-field"><label for="fj-name">Nom du profil</label>' +
        '<input id="fj-name" class="fj-input" name="name" type="text" maxlength="' + NAME_MAX + '" autocomplete="off" value="' + esc(clip(profileName(c), NAME_MAX)) + '" aria-describedby="fj-name-err">' +
        '<p id="fj-name-err" class="fj-err" hidden></p></div>' +
      '<div class="fj-field"><label for="fj-login">Identifiant de connexion (e-mail ou pseudo)</label>' +
        '<input id="fj-login" class="fj-input" name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="toi@exemple.fr" aria-describedby="fj-login-err">' +
        '<p id="fj-login-err" class="fj-err" hidden></p></div>' +
      '<div class="fj-field"><label for="fj-pwd">Mot de passe</label>' +
        '<div class="fj-pwd-wrap">' +
          '<input id="fj-pwd" class="fj-input fj-input--pwd" name="password" type="password" autocomplete="new-password" placeholder="12 caractères ou une phrase" aria-describedby="fj-pwd-hint fj-pwd-err">' +
          '<button type="button" class="fj-eye" data-fj-eye aria-label="Afficher le mot de passe" aria-pressed="false" aria-controls="fj-pwd">' + EYE + '</button>' +
        '</div>' +
        '<div class="fj-gauge" aria-hidden="true"><span class="fj-seg"></span><span class="fj-seg"></span><span class="fj-seg"></span><span class="fj-seg"></span></div>' +
        '<p id="fj-pwd-hint" class="fj-strength"><span class="fj-strength-label" data-level="0" aria-live="polite">' + esc(STRENGTH_LABELS[0]) + '</span><span class="fj-dim">Jamais visible par ' + esc(host || 'la personne qui t’invite') + '</span></p>' +
        '<p id="fj-pwd-err" class="fj-err" hidden></p></div>' +
      '<div class="fj-field fj-field--check"><label class="fj-check" for="fj-cgu"><input id="fj-cgu" name="cgu" type="checkbox" aria-describedby="fj-cgu-err"><span>J’accepte les conditions d’utilisation</span></label>' +
        '<p id="fj-cgu-err" class="fj-err" hidden></p></div>' +
      '<button type="submit" class="fj-cta fj-cta--block fj-cta--submit" data-fj-submit><span class="fj-cta-label">Entrer dans le foyer</span>' + ARROW + '</button>' +
      '<p id="fj-msg" class="fj-msg" role="alert" hidden></p>' +
    '</form></section>';
  paint(ctx, html, (root) => bindForm(ctx, root));
}

function readForm(root) {
  return {
    name: root.querySelector('#fj-name').value.trim(),
    login: root.querySelector('#fj-login').value.trim(),
    pwd: root.querySelector('#fj-pwd').value,
    cgu: root.querySelector('#fj-cgu').checked,
  };
}

/** Erreurs de saisie par champ (vide = valide). Les règles reprennent celles de `register` (8 caractères minimum). */
function validateForm(v) {
  const e = {};
  if (!v.name) e.name = 'Donne un nom au profil.';
  else if (v.name.length > NAME_MAX) e.name = 'Nom : ' + NAME_MAX + ' caractères au plus.';
  if (!v.login) e.login = 'Indique un e-mail ou un pseudo.';
  if (v.pwd.length < PWD_MIN) e.pwd = 'Mot de passe : ' + PWD_MIN + ' caractères minimum.';
  if (!v.cgu) e.cgu = 'Accepte les conditions d’utilisation pour continuer.';
  return e;
}

function setErr(root, field, text) {
  const err = root.querySelector('#fj-' + field + '-err');
  const input = root.querySelector('#fj-' + field);
  if (err) {
    err.textContent = text;
    err.hidden = !text;
  }
  if (input) input.setAttribute('aria-invalid', text ? 'true' : 'false');
}

function setMsg(root, text) {
  const msg = root.querySelector('#fj-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.hidden = !text;
}

/** Envoi en cours : le bouton et Retour sont figés (un retour d'écran pendant l'envoi relâcherait le lien). */
function setBusy(root, busy) {
  const btn = root.querySelector('[data-fj-submit]');
  const back = root.querySelector('[data-fj-back]');
  if (back) back.disabled = busy;
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
  btn.querySelector('.fj-cta-label').textContent = busy ? 'Création de l’accès…' : 'Entrer dans le foyer';
}

/**
 * Accès créé mais session non ouverte : le lien est consommé, donc « Entrer dans le foyer » ne doit plus renvoyer le formulaire.
 * Le bouton est remplacé par « Aller à la connexion ».
 */
function showLoginOnly(root, text) {
  const btn = root.querySelector('[data-fj-submit]');
  if (btn) {
    btn.hidden = true;
    btn.disabled = true;
  }
  setMsg(root, text);
  const form = root.querySelector('[data-fj-form]');
  let go = root.querySelector('[data-fj-login]');
  if (!go && form) {
    go = document.createElement('button');
    go.type = 'button';
    go.className = 'fj-cta fj-cta--block';
    go.setAttribute('data-fj-login', '');
    go.textContent = 'Aller à la connexion';
    go.addEventListener('click', goHome);
    form.append(go);
  }
  go?.focus();
}

function bindForm(ctx, root) {
  const form = root.querySelector('[data-fj-form]');
  const pwd = root.querySelector('#fj-pwd');
  const eye = root.querySelector('[data-fj-eye]');
  const segs = Array.from(root.querySelectorAll('.fj-seg'));
  const label = root.querySelector('.fj-strength-label');
  const refresh = () => {
    const v = readForm(root);
    const score = passwordScore(v.pwd);
    segs.forEach((s, i) => s.classList.toggle('is-on', i < score));
    form.dataset.level = String(score);
    // Le libellé n'est réécrit qu'au changement de palier : le lecteur d'écran n'annonce pas chaque frappe.
    if (label.dataset.level !== String(score)) {
      label.dataset.level = String(score);
      label.textContent = STRENGTH_LABELS[score];
    }
    form.classList.toggle('is-ready', Object.keys(validateForm(v)).length === 0);
  };
  form.addEventListener('input', (ev) => {
    const field = FIELD_OF_ID[ev.target.id];
    if (field) setErr(root, field, '');
    refresh();
  });
  form.addEventListener('change', refresh);
  eye.addEventListener('click', () => {
    const shown = pwd.type === 'password';
    pwd.type = shown ? 'text' : 'password';
    eye.setAttribute('aria-label', shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    eye.setAttribute('aria-pressed', String(shown));
  });
  root.querySelector('[data-fj-back]').addEventListener('click', () => showArrival(ctx));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitForm(ctx, root);
  });
  refresh();
}

async function submitForm(ctx, root) {
  if (ctx.busy) return;
  const v = readForm(root);
  const errors = validateForm(v);
  const fields = ['name', 'login', 'pwd', 'cgu'];
  fields.forEach((f) => setErr(root, f, errors[f] || ''));
  setMsg(root, '');
  const first = fields.find((f) => errors[f]);
  if (first) {
    root.querySelector('#fj-' + first)?.focus();
    return;
  }
  // Écran de l'envoi : si la page a changé pendant l'attente, la réponse n'est plus affichée ni appliquée.
  const screen = currentScreen;
  ctx.busy = true;
  setBusy(root, true);
  let res;
  try {
    res = await redeemHouseholdInvite({ token: ctx.token, login: v.login, password: v.pwd, name: v.name });
  } catch (err) {
    ctx.busy = false;
    if (screen !== currentScreen) return;
    setBusy(root, false);
    redeemFailed(ctx, root, householdErrorCode(err));
    return;
  }
  if (screen !== currentScreen) return;
  try {
    await adoptSession({ token: res.token, expiresAt: res.expiresAt, profileId: res.profileId });
  } catch (_) {
    ctx.busy = false;
    if (screen !== currentScreen) return;
    // L'accès est créé et le lien consommé : pas de nouvel envoi, seulement un passage par la connexion.
    showLoginOnly(root, 'Ton accès est créé, connecte-toi avec ton identifiant.');
    return;
  }
  ctx.busy = false;
  if (screen !== currentScreen) return;
  showWelcome(ctx, v.name || profileName(ctx.check));
}

/** Refus de `redeem` : erreur sous le champ concerné, ou message du formulaire, ou écran d'erreur si le lien a changé d'état. */
function redeemFailed(ctx, root, code) {
  const focusSubmit = () => root.querySelector('[data-fj-submit]')?.focus();
  switch (code) {
    case 'login_taken':
      setErr(root, 'login', 'Cet identifiant est déjà pris. Choisis-en un autre.');
      root.querySelector('#fj-login')?.focus();
      return;
    case 'bad_login':
      setErr(root, 'login', 'Cet identifiant n’est pas valide : e-mail ou pseudo.');
      root.querySelector('#fj-login')?.focus();
      return;
    case 'weak_password':
      setErr(root, 'pwd', 'Ce mot de passe est trop faible. Choisis-en un plus long.');
      root.querySelector('#fj-pwd')?.focus();
      return;
    case 'expired':
    case 'used':
    case 'revoked':
    case 'unknown':
      showError(ctx, code);
      return;
    case 'profile_locked':
      setMsg(root, 'Ce profil est déjà rattaché à un identifiant.');
      focusSubmit();
      return;
    case 'rate_limited':
      setMsg(root, 'Trop de tentatives. Réessaie dans quelques minutes.');
      focusSubmit();
      return;
    case 'network':
      setMsg(root, 'lastAddon est injoignable. Vérifie ta connexion, puis réessaie.');
      focusSubmit();
      return;
    default:
      setMsg(root, 'Une erreur est survenue. Réessaie.');
      focusSubmit();
  }
}

/** Confettis du cercle : même répartition que la maquette (rayon et taille en alternance). */
function confettiHTML() {
  let out = '';
  for (let i = 0; i < CONFETTI; i++) {
    const a = (i / CONFETTI) * Math.PI * 2;
    const r = 90 + (i % 3) * 22;
    const sz = 6 + (i % 4) * 2;
    const style = 'width:' + sz + 'px;height:' + sz + 'px;margin:-' + sz / 2 + 'px;border-radius:' + (i % 2 ? '50%' : '2px') +
      ';background:' + CONFETTI_COLORS[i % 5] + ';--dx:' + Math.round(Math.cos(a) * r) + 'px;--dy:' + Math.round(Math.sin(a) * r) +
      'px;animation-delay:' + (0.25 + (i % 5) * 0.04).toFixed(2) + 's';
    out += '<span class="fj-dot" style="' + style + '"></span>';
  }
  return out;
}

/** Écran de bienvenue : anneau conique, confettis, « Bienvenue chez toi, <nom> ». */
function showWelcome(ctx, name) {
  const c = ctx.check;
  const shown = name || 'toi';
  const html = '<section class="fj-page fj-page--welcome" aria-label="Bienvenue">' +
    bannerHTML(c.backdrops, 'fj-banner--welcome') +
    '<div class="fj-center">' +
      '<div class="fj-ring" aria-hidden="true">' + confettiHTML() +
        '<span class="fj-ring-spin"></span><span class="fj-ring-hole"></span>' +
        avatarHTML({ name: shown, avatar: c.profile && c.profile.avatar }, 'fj-av--ring fj-zoom') +
      '</div>' +
      '<p class="fj-kicker fj-kicker--ok fj-up fj-d1">Accès créé</p>' +
      '<h1 id="fj-title" class="fj-h1 fj-h1--welcome fj-up fj-d1" tabindex="-1">Bienvenue chez toi, ' + esc(shown) + '</h1>' +
      '<p class="fj-lead fj-lead--sm fj-up fj-d2">Connecte-toi avec ton identifiant sur la TV, le PC ou le téléphone : tu arrives directement sur ton profil.</p>' +
      '<div class="fj-stack fj-up fj-d5"><button type="button" class="fj-cta fj-cta--block" data-fj-start>Commencer à regarder' + PLAY + '</button></div>' +
    '</div></section>';
  paint(ctx, html, (root) => {
    root.querySelector('[data-fj-start]').addEventListener('click', goHome);
  });
}

/** Affiche la page d'invitation dans `root` (remplace son contenu) et vérifie le lien. */
export function mountFoyerJoin(root, token) {
  start({ root, token, check: null, busy: false });
}
