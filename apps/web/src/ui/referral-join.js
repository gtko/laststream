/* Billet de parrainage (contrat invitations v3, partie B) : « Ta place est réservée », création du compte, bienvenue.
 * Trois écrans remplacent le contenu de `root` (l'overlay de connexion, rendu par auth-ui.js). Toute chaîne venant du serveur
 * passe par esc() ; une image n'est affichée que si son adresse est en https (sinon un dégradé de repli, jamais d'image inventée).
 * Le mot de passe reste dans le formulaire : il n'est ni journalisé ni stocké ici. Animations CSS seulement (referral.css). */
import '../styles/referral.css';
import { safeImageUrl } from '../data/imageUrl';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { esc } from './util.js';

/** Couleur de repli des avatars (le billet ne transmet pas la couleur du parrain). */
const AVATAR_COLOR = '#ff5a36';
const NAME_MIN = 3;
const NAME_MAX = 32;
const NAME_TEXT_MAX = 64;
const PWD_MIN = 8;
const PICKS_MAX = 3;
const MESSAGE_MAX = 280;
const DUST = 14;
/** Nom d'utilisateur : a-z, 0-9, _ . - uniquement (en minuscules, après normalisation). */
const NAME_RE = /^[a-z0-9_.-]+$/;
/**
 * Codes qui signifient « ce billet ne sert plus » : retour à la saisie du code, avec la raison affichée (raison '' = générique).
 * Les codes `invite_*` sont ceux du serveur ; les noms courts restent acceptés.
 */
const GONE_REASON = new Map([
  ['invite_expired', 'expired'], ['expired', 'expired'],
  ['invite_used', 'used'], ['used', 'used'],
  ['invite_revoked', 'revoked'], ['revoked', 'revoked'],
  ['invite_invalid', ''], ['unknown', 'unknown'],
]);
const STRENGTH = ['Choisis un mot de passe', 'Faible', 'Correct', 'Solide', 'Excellent'];

function icon(size, body, cls = '') {
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}
const ARROW = icon(18, '<path d="M5 12h14M13 6l6 6-6 6"></path>', 'rf-arrow');
const TICKET_BODY = '<path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6z"></path><path d="M14 5v14" stroke-dasharray="2 3"></path>';
const LOGO = '<svg class="rf-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="#ff5a36"></rect><path d="M11 8.5 L24 16 L11 23.5Z" fill="#0c0b11"></path><rect x="8" y="12.2" width="18" height="1.6" fill="#ff5a36"></rect><rect x="8" y="15.2" width="18" height="1.6" fill="#ff5a36"></rect><rect x="8" y="18.2" width="18" height="1.6" fill="#ff5a36"></rect></svg>';

const str = (v) => (typeof v === 'string' ? v : '');
/** Texte limité à `n` caractères (points de code entiers, pas d'unités UTF-16 coupées). */
const clip = (s, n) => Array.from(str(s)).slice(0, n).join('');
const initialOf = (name) => (Array.from(str(name).trim())[0] || '?').toUpperCase();

/** Copie des raisons d'un billet qui ne vaut plus, affichée à l'écran de saisie du code. Vide si la raison est inconnue. */
export function referralReasonText(reason) {
  switch (reason) {
    case 'expired': return 'Ce billet a expiré. Demande à la personne qui t’invite un nouveau billet.';
    case 'used': return 'Ce billet a déjà été utilisé : chaque billet ouvre un seul compte.';
    case 'revoked': return 'Ce billet a été annulé. Demande un nouveau lien à la personne qui t’invite.';
    case 'unknown': return 'Ce lien ne correspond à aucun billet. Vérifie-le, ou demande un nouveau lien.';
    default: return '';
  }
}

/** Identifiant public du parrain : `Nom#TAG` (le serveur l'envoie tel quel, ou null). Sans handle : aperçu `Nom#····`. */
export function inviterHandle(inv) {
  const name = clip(inv && inv.name, NAME_TEXT_MAX);
  const h = inv && typeof inv.handle === 'string' ? inv.handle : '';
  if (h.includes('#')) return clip(h, 80);
  if (h) return name + '#' + clip(h, 16);
  return name + '#····';
}

/** Aperçu du handle pendant la saisie : `Nom#····` tant que le serveur n'a pas attribué le vrai tag. */
export function previewHandle(name) {
  return (clip(str(name).trim().replace(/\s+/g, ''), NAME_MAX) || 'Toi') + '#····';
}

/** Instant en millisecondes : chaîne ISO, ou nombre (chaîne numérique aussi ; moins de 1e11 = secondes). NaN si illisible. */
function toEpochMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return toEpochMs(Number(v.trim()));
  return Date.parse(String(v));
}

/** Date d'échéance lisible (« 3 nov. »), ou '' si elle est absente ou illisible. */
export function expiryText(v) {
  const ms = toEpochMs(v);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/** Score du mot de passe (0 à 4) : longueur, mélange de types, signes. Indicatif, comme dans la maquette. */
export function strengthScore(p) {
  if (!p) return 0;
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if ((/[A-Z]/.test(p) && /[a-z]/.test(p)) || /\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 16) score++;
  return score;
}

/** Données du billet telles que les écrans les lisent : tout passe ici, rien n'est lu brut ailleurs. */
function normalizeTicket(t) {
  const c = t && typeof t === 'object' ? t : {};
  const inv = c.inviter && typeof c.inviter === 'object' ? c.inviter : {};
  const num = Number(c.number);
  return {
    name: clip(inv.name, NAME_TEXT_MAX),
    handle: inviterHandle(inv),
    avatar: typeof inv.avatar === 'string' ? inv.avatar : null,
    message: clip(c.message, MESSAGE_MAX),
    picks: (Array.isArray(c.picks) ? c.picks : []).filter((p) => p && typeof p === 'object').slice(0, PICKS_MAX).map((p) => ({
      name: clip(p.name, 120), poster: safeImageUrl(p.poster), background: safeImageUrl(p.background),
    })),
    number: Number.isInteger(num) && num >= 0 ? String(num).padStart(4, '0') : '····',
    expiresAt: c.expiresAt,
  };
}

const wordmark = () => '<span class="rf-wordmark">' + LOGO + '<span>last<span class="rf-accent">stream</span></span></span>';

/** Avatar du parrain (ou de l'utilisateur) : même rendu que les profils, initiale sur la couleur de repli. */
function avatarHTML(name, avatar, cls) {
  return '<span class="rf-av ' + cls + '"' + avatarAttrs(avatar || null, AVATAR_COLOR) + ' aria-hidden="true">' + esc(initialOf(name)) + '</span>';
}

/** Fond de l'écran : la première image https du billet (fond, puis affiche), sinon le dégradé de la page. */
function backdropHTML(picks, cls) {
  const src = (picks.find((p) => p.background) || {}).background || (picks.find((p) => p.poster) || {}).poster || '';
  return '<div class="rf-backdrop ' + cls + '" aria-hidden="true">' +
    (src ? '<img class="rf-backdrop-img" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-rf-img="backdrop">' : '') + '</div>';
}

/** Trois affiches en éventail. Sans adresse https, la carte affiche le titre sur un dégradé. */
function fanHTML(picks) {
  const slots = ['rf-fan-a', 'rf-fan-b', 'rf-fan-c'];
  return picks.map((p, i) => '<figure class="rf-poster ' + slots[i] + (p.poster ? '' : ' rf-poster--plain') + '">' +
    (p.poster
      ? '<img src="' + esc(p.poster) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-rf-img="poster">'
      : '<span class="rf-poster-name">' + esc(p.name) + '</span>') +
    '</figure>').join('');
}

/** Poussière qui monte (positions fixes, délais échelonnés). */
function dustHTML() {
  let out = '';
  for (let i = 0; i < DUST; i++) {
    const size = 2 + (i % 3);
    out += '<span class="rf-dust" style="left:' + (55 + ((i * 37) % 40)) + '%;top:' + (55 + ((i * 53) % 35)) + '%;width:' + size + 'px;height:' + size + 'px;animation-delay:' + ((i * 0.41) % 7).toFixed(2) + 's"></span>';
  }
  return out;
}

/** Face du billet d'arrivée : admis, numéro, invité par, rang et séance. */
function ticketFace(c) {
  return '<div class="rf-ticket-top"><span>ADMIS · UNE PLACE</span><span>N° ' + esc(c.number) + '</span></div>' +
    '<div class="rf-ticket-mid"><span class="rf-logo-big">last<span>stream</span></span>' +
    '<span class="rf-ticket-by">Invité·e par ' + esc(c.handle) + '</span></div>' +
    '<div class="rf-ticket-bot"><span>SALLE ∞</span><span>RANG G</span><span>SÉANCE QUAND TU VEUX</span></div>' +
    '<span class="rf-stub" aria-hidden="true"></span><span class="rf-shine" aria-hidden="true"></span>';
}

/** Remplace le contenu de l'écran, pose le focus sur le titre et branche les actions. Un résultat d'API arrivé après coup est ignoré. */
function paint(ctx, html, bind) {
  ctx.seq += 1;
  ctx.root.innerHTML = html;
  const page = ctx.root.querySelector('.rf-page');
  if (page) {
    // Image qui ne charge pas : affiche repli (dégradé + titre) ou retire le fond. Les erreurs d'image ne remontent pas, d'où la capture.
    page.addEventListener('error', onImgError, true);
    if (bind) bind(page);
  }
  const title = ctx.root.querySelector('#rf-title');
  if (title) title.focus({ preventScroll: true });
  hydrateAvatars(ctx.root).catch(() => undefined);
}

function onImgError(ev) {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.rfImg === 'poster') {
    const span = document.createElement('span');
    span.className = 'rf-poster-name';
    span.textContent = img.alt;
    if (img.parentElement) img.parentElement.classList.add('rf-poster--plain');
    img.replaceWith(span);
  } else if (img.dataset.rfImg === 'backdrop') img.remove();
}

/** Écran 1 « Ta place est réservée » : rideaux, billet 3D, mot du parrain, éventail d'affiches, « Créer mon compte ». */
function showArrival(ctx) {
  const c = ctx.ticket;
  const left = expiryText(c.expiresAt);
  const html = '<section class="rf-page rf-page--arrival" aria-label="Billet de parrainage">' +
    backdropHTML(c.picks, 'rf-backdrop--arrival') +
    '<div class="rf-beam rf-beam--a" aria-hidden="true"></div><div class="rf-beam rf-beam--b" aria-hidden="true"></div>' +
    dustHTML() +
    '<header class="rf-top">' + wordmark() + '</header>' +
    '<div class="rf-stage">' +
      '<div class="rf-copy">' +
        '<p class="rf-kicker rf-up rf-d1">' + icon(18, TICKET_BODY) + '<span>Billet de parrainage</span></p>' +
        '<h1 id="rf-title" class="rf-h1 rf-up rf-d2" tabindex="-1">Ta place est réservée.</h1>' +
        '<div class="rf-note rf-up rf-d3">' + avatarHTML(c.name, c.avatar, 'rf-av--note') +
          '<div><p class="rf-note-who"><strong>' + esc(c.handle) + '</strong> t’offre un de ses 4 billets</p>' +
          (c.message ? '<p class="rf-note-msg">« ' + esc(c.message) + ' »</p>' : '') + '</div></div>' +
        '<div class="rf-actions rf-up rf-d4">' +
          '<button type="button" class="rf-cta" data-rf-create><span>Créer mon compte</span>' + ARROW + '</button>' +
          '<button type="button" class="rf-link" data-auth-mode="login">J’ai déjà un compte</button>' +
        '</div>' +
        '<p class="rf-fine rf-up rf-d5">Sur invitation uniquement' + (left ? ' · billet valable jusqu’au ' + esc(left) : '') + '</p>' +
      '</div>' +
      '<div class="rf-visual">' +
        '<div class="rf-ticket-wrap rf-in"><div class="rf-ticket rf-float">' + ticketFace(c) + '</div></div>' +
        (c.picks.length
          ? '<p class="rf-fan-title rf-up rf-d4">Ses coups de cœur, rien que pour toi</p><div class="rf-fan">' + fanHTML(c.picks) + '</div>'
          : '') +
      '</div>' +
    '</div>' +
    '<div class="rf-curtain rf-curtain--l" aria-hidden="true"></div><div class="rf-curtain rf-curtain--r" aria-hidden="true"></div>' +
  '</section>';
  paint(ctx, html, (page) => {
    page.querySelector('[data-rf-create]').addEventListener('click', () => showAccount(ctx));
  });
}

/** Écran 2 « Crée ton compte » : billet en miniature, nom de profil avec aperçu du handle, mot de passe avec jauge, case ami. */
function showAccount(ctx) {
  const c = ctx.ticket;
  const who = c.name || 'ton parrain';
  const html = '<section class="rf-page rf-page--account" aria-label="Créer mon compte">' +
    '<div class="rf-bar"><button type="button" class="rf-back" data-rf-back aria-label="Retour">' + icon(20, '<path d="M15 6l-6 6 6 6"></path>') + '</button></div>' +
    '<div class="rf-column">' +
      '<div class="rf-mini rf-drop"><div class="rf-mini-text"><span>BILLET N° ' + esc(c.number) + ' · ADMIS</span><strong>Offert par ' + esc(c.handle) + '</strong></div>' +
        '<span class="rf-mini-stub" aria-hidden="true"></span><span class="rf-shine" aria-hidden="true"></span></div>' +
      '<h1 id="rf-title" class="rf-h1 rf-h1--form rf-up rf-d1" tabindex="-1">Crée ton compte</h1>' +
      '<p class="rf-sub rf-up rf-d1">Ton propre compte, ton foyer, et 4 billets à offrir à ton tour.</p>' +
      '<form id="rf-form" class="rf-form" data-level="0" novalidate>' +
        '<div class="rf-field rf-up rf-d2"><label for="rf-name">Nom de profil</label>' +
          '<div class="rf-name-row"><span class="rf-av rf-av--form" data-rf-initial aria-hidden="true">?</span>' +
          '<input id="rf-name" class="rf-input" name="username" type="text" minlength="' + NAME_MIN + '" maxlength="' + NAME_MAX + '" autocomplete="username" autocapitalize="none" spellcheck="false" required aria-describedby="rf-handle"></div>' +
          '<p id="rf-handle" class="rf-handle">Identifiant pour tes amis : <strong data-rf-handle>' + esc(previewHandle('')) + '</strong></p></div>' +
        '<div class="rf-field rf-up rf-d3"><label for="rf-pwd">Mot de passe</label>' +
          '<input id="rf-pwd" class="rf-input" name="password" type="password" minlength="' + PWD_MIN + '" autocomplete="new-password" placeholder="8 caractères minimum, une phrase de préférence" required aria-describedby="rf-strength">' +
          '<div class="rf-gauge" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' +
          '<p id="rf-strength" class="rf-strength" data-rf-strength aria-live="polite">' + esc(STRENGTH[0]) + '</p></div>' +
        '<label class="rf-check rf-up rf-d4"><input type="checkbox" name="autoFriend" checked><span>Devenir ami avec ' + esc(who) + ' dès mon arrivée</span></label>' +
        '<button type="submit" class="rf-cta rf-cta--block rf-up rf-d5" data-rf-submit><span class="rf-cta-label">Valider mon billet</span>' + ARROW + '</button>' +
        '<p id="rf-msg" class="rf-msg" role="alert" hidden></p>' +
      '</form>' +
    '</div></section>';
  paint(ctx, html, (page) => bindAccount(ctx, page));
}

function bindAccount(ctx, page) {
  const form = page.querySelector('#rf-form');
  const name = page.querySelector('#rf-name');
  const pwd = page.querySelector('#rf-pwd');
  page.querySelector('[data-rf-back]').addEventListener('click', () => { if (!ctx.busy) showArrival(ctx); });
  name.addEventListener('input', () => {
    page.querySelector('[data-rf-handle]').textContent = previewHandle(name.value);
    page.querySelector('[data-rf-initial]').textContent = initialOf(name.value);
  });
  pwd.addEventListener('input', () => paintStrength(page, pwd.value));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitAccount(ctx, page);
  });
}

/** Jauge du mot de passe : segments, couleur du niveau (data-level sur le formulaire) et libellé qui ne change qu'au palier. */
function paintStrength(page, value) {
  const score = strengthScore(value);
  page.querySelector('#rf-form').dataset.level = String(score);
  page.querySelectorAll('.rf-gauge span').forEach((s, i) => s.classList.toggle('is-on', i < score));
  const label = page.querySelector('[data-rf-strength]');
  if (label.dataset.level !== String(score)) {
    label.dataset.level = String(score);
    label.textContent = STRENGTH[score];
  }
}

/** Nom saisi, normalisé comme envoyé : sans espaces autour, en minuscules. */
const normalizeName = (s) => str(s).trim().toLowerCase();

/** Erreur de saisie locale (avant tout envoi) : champ à reprendre et message. Les règles du serveur (`register`) restent la référence. */
function validate(v) {
  const len = Array.from(v.username).length;
  if (len < NAME_MIN || len > NAME_MAX || !NAME_RE.test(v.username)) {
    return { field: '#rf-name', text: 'Nom : 3 à 32 caractères (a-z, 0-9, _ . -).' };
  }
  if (Array.from(v.password).length < PWD_MIN) return { field: '#rf-pwd', text: 'Mot de passe : 8 caractères minimum.' };
  return null;
}

function setMsg(page, text) {
  const m = page.querySelector('#rf-msg');
  if (!m) return;
  m.textContent = text;
  m.hidden = !text;
}

/** Envoi en cours : bouton et retour figés (un retour d'écran pendant l'envoi laisserait un compte créé sans écran de suite). */
function setBusy(page, busy) {
  const btn = page.querySelector('[data-rf-submit]');
  const back = page.querySelector('[data-rf-back]');
  if (back) back.disabled = busy;
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
  btn.querySelector('.rf-cta-label').textContent = busy ? 'Création de ton compte…' : 'Valider mon billet';
}

/** Envoi du formulaire : création du compte avec le billet (`create`), puis bienvenue, ou message / retour à la saisie du code. */
async function submitAccount(ctx, page) {
  if (ctx.busy) return;
  const v = {
    username: normalizeName(page.querySelector('#rf-name').value),
    password: page.querySelector('#rf-pwd').value,
    autoFriend: page.querySelector('input[name="autoFriend"]').checked,
  };
  const bad = validate(v);
  setMsg(page, bad ? bad.text : '');
  if (bad) {
    page.querySelector(bad.field).focus();
    return;
  }
  const seq = ctx.seq;
  ctx.busy = true;
  setBusy(page, true);
  let handle;
  try {
    handle = await ctx.create(v);
  } catch (err) {
    ctx.busy = false;
    if (seq !== ctx.seq) return;
    setBusy(page, false);
    const code = err && err.code;
    if (GONE_REASON.has(code)) {
      ctx.onGone(GONE_REASON.get(code));
      return;
    }
    setMsg(page, ctx.message(err));
    page.querySelector('[data-rf-submit]').focus();
    return;
  }
  ctx.busy = false;
  if (seq !== ctx.seq) return;
  showWelcome(ctx, { name: v.username, autoFriend: v.autoFriend, handle: typeof handle === 'string' ? handle : '' });
}

/** Écran 3 « Tu es dans la salle » : billet déchiré, identifiant ami, carte du parrain, teaser des 4 billets. */
function showWelcome(ctx, who) {
  const c = ctx.ticket;
  const name = who.name || 'toi';
  const handle = who.handle || previewHandle(name);
  const html = '<section class="rf-page rf-page--welcome" aria-label="Bienvenue">' +
    backdropHTML(c.picks, 'rf-backdrop--welcome') +
    '<div class="rf-column rf-column--center">' +
      '<div class="rf-torn rf-up"><div class="rf-torn-main"><span class="rf-torn-no">BILLET N° ' + esc(c.number) + '</span>' +
        '<span class="rf-logo-big rf-logo-sm">last<span>stream</span></span><span class="rf-torn-ok">VALIDÉ · BIENVENUE</span></div>' +
        '<div class="rf-torn-stub rf-tear" aria-hidden="true"><span>ADMIS</span></div></div>' +
      '<h1 id="rf-title" class="rf-h1 rf-h1--welcome rf-up rf-d1" tabindex="-1">Tu es dans la salle, ' + esc(name) + '</h1>' +
      '<p class="rf-lead rf-up rf-d2">Ton compte est prêt. Ton identifiant ami : <strong class="rf-mono">' + esc(handle) + '</strong></p>' +
      '<div class="rf-friend rf-up rf-d3">' + avatarHTML(c.name, c.avatar, 'rf-av--friend') +
        '<div><strong>' + esc(c.handle) + ' · ' + (who.autoFriend ? 'ton ami' : 'ton parrain') + '</strong>' +
        '<span>' + (who.autoFriend ? 'Ami ajouté dès ton arrivée' : 'Ton billet est validé') + '</span></div></div>' +
      '<div class="rf-next rf-up rf-d4"><span class="rf-next-tickets" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
        '<div><strong>À ton tour : 4 billets</strong><span>Invite tes proches depuis Parrainage</span></div></div>' +
      '<button type="button" class="rf-cta rf-cta--block rf-up rf-d5" data-rf-enter><span>Découvrir l’accueil</span>' + ARROW + '</button>' +
    '</div></section>';
  paint(ctx, html, (page) => {
    page.querySelector('[data-rf-enter]').addEventListener('click', () => ctx.onEnter());
  });
}

/**
 * Affiche « Ta place est réservée » dans `root` et enchaîne les écrans. Options :
 * - `ticket` : réponse de la vérification du billet (valide, avec `inviter` objet) ;
 * - `create({username, password, autoFriend})` : crée le compte, résout avec le handle connu (ou '') ;
 * - `message(err)` : texte d'une erreur de création ; `onGone(code)` : le billet ne vaut plus (code `expired`, `used`…, ou '') ;
 * - `onEnter()` : l'utilisateur quitte la bienvenue, l'app prend la main.
 */
export function mountReferral(root, opts) {
  const ctx = {
    root,
    ticket: normalizeTicket(opts.ticket),
    create: opts.create,
    message: opts.message || (() => 'Une erreur est survenue.'),
    onGone: opts.onGone,
    onEnter: opts.onEnter,
    busy: false,
    seq: 0,
  };
  showArrival(ctx);
}
