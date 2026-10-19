/* Panneau « Watch party » du lecteur : création du salon, participants (rôle d'hôte, muet, exclusion), chat, réactions rapides.
 * La synchronisation de la lecture est dans src/party (contrôleur) ; ici, seulement l'interface. */
import { isKidProfile } from '../data/auth';
import { partyVisibilityChoices, partyBridge } from '../party/bridge';
import { joinLinkOf } from '../party/join';
import { CHAT_MAX, PARTY_WAIT_MAX_MS, partyErrorText, REACTIONS } from '../party/protocol';
import { UserApiError } from '../data/userApi';
import { toast } from './dom.js';
import { shareBase } from './invites.js';
import { esc } from './util.js';
import { avatarAttrs } from './avatar-art.js';

let rootEl = null;
let panel = null;
let floats = null;
let getAdapter = () => null;
let attached = null;
let open = false;
let chatDraft = '';
/** Dernier lien d'invitation créé pour le salon affiché (le jeton ne vit que dans ce panneau). */
let lastInviteUrl = '';
/** Salon créé depuis ce panneau : son créateur est l'hôte, même avant la bienvenue du serveur. */
let createdHere = false;
/** Dernier bloc de compatibilité affiché (évite de le reconstruire à chaque seconde). */
let compatShown = '';
/** « Copié » affiché sur le bouton d’invitation pendant un instant : l’état vit ici, le panneau est reconstruit à chaque rendu. */
let inviteCopied = false;
let copiedTimer = 0;
/** Chat repliable (ouvert par défaut), messages des autres reçus pendant qu'il est replié, et historique de connexion en cours. */
let chatOpen = true;
let unread = 0;
let replaying = false;
/** Au prochain rendu, défiler tout en bas (après un envoi ou à l'ouverture du chat). */
let stickBottom = false;
let renderQueued = false;

const fmtRate = (bps) => (bps / 1048576).toFixed(1).replace('.', ',') + ' Mo/s';
const guestCount = (c) => c.participants.filter((p) => p.guest).length;

/** Ligne compacte du partage : débit montant et nombre d’invités (secondaire). Texte seulement, jamais d’URL. */
function rateHTML() {
  const c = partyBridge.client;
  const n = c ? guestCount(c) : 0;
  const guests = '<span data-wp-guests>' + n + '</span> invité' + (n > 1 ? 's' : '');
  if (partyBridge.relayRefused()) {
    return '<span class="wp-rate-warn" title="Ce lien ne peut pas être partagé depuis le navigateur : les invités ne reçoivent pas la vidéo.">Partage bloqué</span> · ' + guests;
  }
  const s = partyBridge.relayStats();
  return (s ? '↑ ' + fmtRate(s.rateBps) : 'Partage inactif') + ' · ' + guests;
}

/** Avertissement de compatibilité des invités, en bandeau discret, avec la bascule ; vide si tous les invités annoncés peuvent tout lire. */
function compatHTML() {
  const warn = partyBridge.guestWarning();
  return warn
    ? '<div class="wp-banner" role="status"><span>' + esc(warn) + '</span>' +
      '<button type="button" class="wp-link" data-wp-compat>Passer à une source compatible</button></div>'
    : '';
}

function inviteHTML() {
  const compat = compatHTML();
  compatShown = compat;
  return '<section class="wp-invite">' +
    (lastInviteUrl ? '<input type="text" class="wp-invite-link" data-wp-invite-link readonly value="' + esc(lastInviteUrl) + '" aria-label="Lien d’invitation">' : '') +
    '<div class="wp-invite-btns"><button type="button" class="btn btn-ghost btn-sm' + (inviteCopied ? ' is-done' : '') + '" data-wp-invite>' +
    (inviteCopied ? 'Copié' : 'Copier le lien d’invitation') + '</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-wp-newlink title="L’ancien lien cesse de fonctionner ; les invités déjà dans le salon restent">Nouveau lien</button></div>' +
    '<p class="wp-rate" data-wp-relay title="Chaque invité consomme ~ le débit du fichier en envoi depuis votre connexion.">' + rateHTML() + '</p>' +
    '<div class="wp-compat" data-wp-compatbox>' + compat + '</div></section>';
}

/** Lien d'un salon (ouvre la page de connexion au salon). */
export const roomLink = (id) => shareBase().replace(/\/+$/, '') + '/#/party/' + encodeURIComponent(id);

/** États de la pastille d’un participant, avec leur libellé (infobulle et nom accessible). */
const STATE_TEXT = new Map([['ready', 'Prêt'], ['buffering', 'Tampon'], ['no-audio', 'Sans son'], ['unplayable', 'Illisible']]);

/**
 * État affiché : `p.state` si le salon le fournit (tampon, etc.), sinon le verdict de compatibilité d’un invité (sans son,
 * illisible), sinon « prêt ». Un verdict n’existe que pendant le partage aux invités.
 */
export function participantState(p, verdicts = new Map()) {
  if (p.state && STATE_TEXT.has(p.state)) return p.state;
  const v = verdicts.get(p.username);
  return v === 'unplayable' || v === 'no-audio' ? v : 'ready';
}

/** Vrai si la couleur d’avatar est claire : l’initiale y est sombre (le blanc y contrasterait trop peu). Couleur absente : repli d’avatarAttrs. */
export function avatarIsLight(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  const hex = m ? m[1] : '94a3b8';
  const full = hex.length === 3 ? [...hex].map((ch) => ch + ch).join('') : hex;
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  // Contraste avec le blanc contre contraste avec une encre sombre (luminance ≈ 0,0045) : on garde le meilleur.
  return (lum + 0.05) / 0.0545 > 1.05 / (lum + 0.05);
}

/** Initiale du pseudo (un caractère, en majuscule). */
const initialOf = (name) => {
  const ch = Array.from(String(name ?? '').trim())[0];
  return ch ? ch.toLocaleUpperCase('fr') : '?';
};

/** Avatar rond : l’illustration si elle est en cache (sinon hydratée par avatar-art), sur la couleur du participant ; l’initiale par-dessus. */
const avatarHTML = (p) => '<span class="wp-av' + (avatarIsLight(p.avatarColor) ? ' is-light' : '') + '"' + avatarAttrs(p.avatar, p.avatarColor) +
  ' aria-hidden="true"><span class="wp-av-ini">' + esc(initialOf(p.username)) + '</span></span>';

/** Liste des participants. `waitWho` : pseudos retardés par le tampon (pastille « Tampon », prime sur le reste). */
export function participantsHTML(list, you, youHost, verdicts = new Map(), waitWho = []) {
  return list.map((p) => {
    const me = you && p.username === you.username;
    const tools = youHost && !me
      ? '<span class="wp-tools"><button type="button" class="wp-mini" data-wp-mute="' + esc(p.username) + '" data-muted="' + (p.muted ? '1' : '0') + '">' + (p.muted ? 'Rétablir' : 'Muet') + '</button>' +
        '<button type="button" class="wp-mini" data-wp-host="' + esc(p.username) + '" title="Céder le rôle d’hôte">Hôte</button>' +
        '<button type="button" class="wp-mini wp-danger" data-wp-kick="' + esc(p.username) + '">Exclure</button></span>'
      : '';
    const state = waitWho.includes(p.username) ? 'buffering' : participantState(p, verdicts);
    const label = STATE_TEXT.get(state);
    return '<li class="wp-user">' + avatarHTML(p) + '<span class="wp-name">' + esc(p.username) + (me ? ' (toi)' : '') + '</span>' +
      (p.host ? '<em class="wp-badge">Hôte</em>' : '') + (p.muted ? '<em class="wp-badge wp-badge-muted">Muet</em>' : '') +
      '<span class="wp-state is-' + state + '" role="img" aria-label="' + label + '" title="' + label + '"></span>' + tools + '</li>';
  }).join('');
}

/** Heure locale HH:MM d’un message ; vide si l’horodatage est absent ou invalide. */
export function timeHTML(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return '<time class="wp-time" datetime="' + esc(d.toISOString()) + '">' + hh + ':' + mm + '</time>';
}

export function chatHTML(lines, you) {
  if (!lines.length) return '<p class="wp-empty">Aucun message pour l’instant.</p>';
  return lines.map((l) => {
    const mine = you && l.from === you.username;
    return '<p class="wp-line' + (mine ? ' is-mine' : '') + '" data-wp-line="' + esc(l.id) + '">' + timeHTML(l.at) +
      '<b>' + esc(l.from) + '</b> <span>' + esc(l.text) + '</span>' +
      (mine ? '' : '<button type="button" class="wp-flag" data-wp-report="' + esc(l.id) + '" aria-label="Signaler ce message" title="Signaler">⚑</button>') + '</p>';
  }).join('');
}

/** Bandeau d’attente de tampon : retardataires (« Léa, Tom »), spinner et compte à rebours. Vide hors attente. */
function waitInnerHTML(w) {
  if (!w) return '';
  return '<span class="wp-spin" aria-hidden="true"></span>' +
    '<span class="wp-wait-txt" role="status">En attente de <b>' + esc(w.who.join(', ')) + '</b>…</span>' +
    '<span class="wp-countdown" aria-hidden="true" data-wp-countdown>' + countdownText(w) + '</span>';
}

/** Temps restant (ms) avant la reprise sans les retardataires : début serveur + délai, borné à [0, délai]. */
function remainingMs(w) {
  const max = Number.isFinite(w.maxMs) && w.maxMs > 0 ? w.maxMs : PARTY_WAIT_MAX_MS;
  const c = partyBridge.client;
  const now = c && typeof c.serverNow === 'function' ? c.serverNow() : Date.now();
  const left = w.since + max - now;
  return Number.isFinite(left) ? Math.min(max, Math.max(0, left)) : max;
}

const countdownText = (w) => Math.ceil(remainingMs(w) / 1000) + ' s';

/** En-tête du chat : titre repliable, badge « nouveaux messages » quand il est replié. */
function chatHeadHTML() {
  const badge = !chatOpen && unread > 0 ? '<span class="wp-unread" data-wp-unread>' + (unread > 1 ? unread + ' nouveaux messages' : '1 nouveau message') + '</span>' : '';
  return '<button type="button" class="wp-sub wp-chat-toggle" data-wp-chat-toggle aria-expanded="' + (chatOpen ? 'true' : 'false') + '" aria-controls="wp-chat-body">' +
    'Chat' + badge + '<span class="wp-caret" aria-hidden="true">' + (chatOpen ? '▾' : '▸') + '</span></button>';
}

function createHTML() {
  const kid = isKidProfile();
  const choices = partyVisibilityChoices(kid);
  const a = getAdapter();
  const ready = !!(a && a.ready);
  return '<h3 class="wp-title">Watch party</h3>' +
    '<p class="wp-note">Regarde en même temps que tes amis. Chacun lit avec sa propre source : aucun lien de lecture n’est partagé.</p>' +
    '<form class="wp-form" data-wp-create><fieldset class="wp-fs"><legend>Type de salon</legend>' +
    '<label class="wp-opt"><input type="radio" name="vis" value="private" checked><span><b>Privé</b> Accessible seulement avec le lien.</span></label>' +
    (choices.includes('public') ? '<label class="wp-opt"><input type="radio" name="vis" value="public"><span><b>Public</b> Listé dans « Watch parties ».</span></label>' : '') +
    '</fieldset>' +
    (kid ? '<p class="wp-note">Profil enfant : salon privé uniquement.</p>' : '') +
    '<p class="wp-msg" data-wp-msg role="status">' + (ready ? '' : 'Attends que la lecture démarre pour créer le salon.') + '</p>' +
    '<button type="submit" class="btn btn-primary"' + (ready ? '' : ' disabled') + '>Créer le salon</button></form>';
}

function roomHTML(c) {
  const you = c.you;
  const host = !!(you && you.host);
  const inviter = host || createdHere;
  const status = c.status === 'open' ? '' : '<p class="wp-status" role="status">' + (c.status === 'closed' ? 'Déconnecté du salon.' : 'Connexion au salon… reprise automatique.') + '</p>';
  const room = c.room;
  const wait = c.waiting && Array.isArray(c.waiting.who) && c.waiting.who.length ? c.waiting : null;
  return '<div class="wp-head"><h3 class="wp-title">' + esc(room ? room.title : 'Salon') + '</h3>' +
    '<span class="wp-vis">' + (room && room.visibility === 'public' ? 'Public' : 'Privé') + '</span></div>' + status +
    '<div class="wp-actions">' + (inviter ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-wp-copy>Copier le lien</button>') +
    '<button type="button" class="btn btn-ghost btn-sm" data-wp-leave>Quitter</button>' +
    (host ? '<button type="button" class="btn btn-ghost btn-sm wp-danger" data-wp-end>Terminer</button>' : '') + '</div>' +
    '<div class="wp-wait" data-wp-wait' + (wait ? '' : ' hidden') + '>' + waitInnerHTML(wait) + '</div>' +
    '<h4 class="wp-sub">Participants (' + c.participants.length + ')</h4><ul class="wp-users" data-wp-users>' + participantsHTML(c.participants, you, host, partyBridge.guestVerdicts(), wait ? wait.who : []) + '</ul>' +
    (inviter ? inviteHTML() : '') +
    (host ? '' : '<p class="wp-note">La lecture est partagée : pause, reprise et sauts valent pour tout le salon. Seul l’hôte change d’épisode.</p>') +
    '<div class="wp-chatsec">' + chatHeadHTML() +
    '<div class="wp-chat-body" id="wp-chat-body" data-wp-chat-body' + (chatOpen ? '' : ' hidden') + '>' +
    '<div class="wp-chat" data-wp-chat role="log" aria-live="polite">' + chatHTML(c.chat, you) + '</div>' +
    '<form class="wp-send" data-wp-send><input type="text" name="text" maxlength="' + CHAT_MAX + '" autocomplete="off" aria-label="Message" placeholder="' + (you && you.muted ? 'Tu es muet' : 'Écrire un message') + '"' + (you && you.muted ? ' disabled' : '') + ' value="' + esc(chatDraft) + '">' +
    '<span class="wp-chars" data-wp-chars>' + chatDraft.length + '/' + CHAT_MAX + '</span>' +
    '<button type="submit" class="btn btn-primary btn-sm"' + (you && you.muted ? ' disabled' : '') + '>Envoyer</button></form>' +
    '<div class="wp-react" role="group" aria-label="Réactions">' + REACTIONS.map((e) => '<button type="button" data-wp-react="' + e + '" aria-label="Réaction ' + e + '">' + e + '</button>').join('') + '</div>' +
    '</div></div>';
}

function render() {
  if (!panel) return;
  panel.hidden = !open;
  rootEl.classList.toggle('has-party-panel', open);
  if (!open) return;
  const c = partyBridge.client;
  const typing = panel.contains(document.activeElement) && document.activeElement.name === 'text';
  if (typing) chatDraft = document.activeElement.value;
  const chatBox = panel.querySelector('[data-wp-chat]');
  const keepScroll = stickBottom || (chatBox ? chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40 : true);
  stickBottom = false;
  panel.innerHTML = '<button type="button" class="wp-close" data-wp-close aria-label="Fermer le panneau">×</button>' + (c && c.status !== 'idle' ? roomHTML(c) : createHTML()) +
    (partyBridge.endReason ? '<p class="wp-msg" role="alert">' + esc(endText(partyBridge.endReason)) + '</p>' : '') +
    (partyBridge.lastError ? '<p class="wp-msg" role="alert">' + esc(partyBridge.lastError) + '</p>' : '');
  const box = panel.querySelector('[data-wp-chat]');
  if (box && keepScroll) box.scrollTop = box.scrollHeight;
  if (typing) {
    const input = panel.querySelector('input[name="text"]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

const endText = (r) => (r === 'kicked' ? 'Tu as été exclu du salon.' : r === 'ended' ? 'Le salon est terminé.' : r === 'replaced' ? 'Connexion reprise depuis un autre appareil.' : r === 'full' ? 'Le salon est complet.' : 'Salon fermé.');

/**
 * Rendu différé à la trame suivante : une rafale (historique de 50 lignes à la connexion, attente) ne reconstruit le
 * panneau qu’une fois.
 */
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; render(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Ligne de chat reçue : compte les messages des autres pendant que le chat est replié (pas l’historique de connexion). */
function onChatLine(c, line) {
  const me = c.you ? c.you.username : null;
  if (!replaying && !chatOpen && line.from !== me) unread += 1;
  renderSoon();
}

function toggleChat() {
  chatOpen = !chatOpen;
  if (chatOpen) { unread = 0; stickBottom = true; }
  render();
}

/** Compteur de caractères du champ d’envoi, sans reconstruire le panneau. */
function updateChars() {
  if (!panel) return;
  const input = panel.querySelector('input[name="text"]');
  const counter = panel.querySelector('[data-wp-chars]');
  if (input && counter) counter.textContent = input.value.length + '/' + CHAT_MAX;
}

/** Saisie dans le champ d’envoi : brouillon gardé entre deux rendus, compteur mis à jour. */
function onInput(e) {
  const f = e.target;
  if (!(f instanceof HTMLInputElement) || f.name !== 'text' || !f.closest('[data-wp-send]')) return;
  chatDraft = f.value;
  updateChars();
}

/** Rafraîchit le compte à rebours du bandeau d’attente (sans reconstruire le panneau). */
function updateCountdown() {
  if (!panel || !open) return;
  const el = panel.querySelector('[data-wp-countdown]');
  const w = partyBridge.client ? partyBridge.client.waiting : null;
  if (el && w) el.textContent = countdownText(w);
}

function floatReaction(emoji, user) {
  if (!floats) return;
  const s = document.createElement('span');
  s.className = 'wp-float';
  s.style.left = 8 + Math.random() * 80 + '%';
  s.textContent = emoji;
  s.title = user;
  floats.appendChild(s);
  setTimeout(() => s.remove(), 3200);
}

/** Rafraîchit seulement les compteurs (sans reconstruire le panneau) : débit montant, nombre d'invités et bandeau de compatibilité. */
function updateRelayLine() {
  if (!panel || !open) return;
  const relay = panel.querySelector('[data-wp-relay]');
  if (relay) relay.innerHTML = rateHTML();
  const box = panel.querySelector('[data-wp-compatbox]');
  const compat = compatHTML();
  if (box && compat !== compatShown) {
    compatShown = compat;
    box.innerHTML = compat;
  }
}

/** Retour « Copié » pendant 2 s, puis le libellé d’origine revient. */
function flashCopied() {
  inviteCopied = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    inviteCopied = false;
    render();
  }, 2000);
}

function attach() {
  const c = partyBridge.client;
  if (c === attached) return;
  attached = c;
  lastInviteUrl = '';
  createdHere = false;
  inviteCopied = false;
  chatOpen = true;
  unread = 0;
  stickBottom = false;
  if (!c) return;
  // Les lignes de l’historique suivent « welcome » de façon synchrone : elles ne comptent pas comme nouveaux messages.
  c.on('welcome', () => {
    replaying = true;
    setTimeout(() => { replaying = false; }, 0);
  });
  c.on('chat', (line) => onChatLine(c, line));
  c.on('wait', () => renderSoon());
  c.on('removed', () => render());
  c.on('linkRenewed', () => { void renewLinkAfterKick(); });
  c.on('react', (r) => floatReaction(r.emoji, r.user));
  c.on('host', (user) => { toast(user + ' est maintenant l’hôte'); render(); });
  c.on('muted', () => render());
  c.on('reported', (r) => { if (r.against) toast('Signalement reçu : ' + r.against); else toast('Message signalé, merci'); });
  c.on('error', (code) => toast(partyErrorText(code)));
  c.on('end', (reason) => { toast(endText(reason)); render(); });
}

/** Crée le panneau dans la racine du lecteur (une seule fois). `opts.adapter` : titre en cours de lecture. */
export function mountPartyPanel(root, opts) {
  if (rootEl) return;
  rootEl = root;
  getAdapter = opts.adapter;
  panel = document.createElement('aside');
  panel.className = 'lp-party';
  panel.setAttribute('aria-label', 'Watch party');
  panel.hidden = true;
  floats = document.createElement('div');
  floats.className = 'lp-party-floats';
  floats.setAttribute('aria-hidden', 'true');
  root.appendChild(floats);
  root.appendChild(panel);
  partyBridge.onChange(() => { attach(); render(); });
  partyBridge.onCreated = () => { togglePartyPanel(true); void inviteAfterCreate(); };
  panel.addEventListener('click', onClick);
  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('input', onInput);
  setInterval(() => { updateRelayLine(); updateCountdown(); }, 1000);
}

export function togglePartyPanel(force) {
  open = typeof force === 'boolean' ? force : !open;
  partyBridge.lastError = '';
  attach();
  render();
}

export const isPartyPanelOpen = () => open;

async function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  e.preventDefault();
  e.stopPropagation();
  if (f.matches('[data-wp-send]')) {
    const c = partyBridge.client;
    const text = f.elements.text.value.slice(0, CHAT_MAX);
    if (c && c.sendChat(text)) { chatDraft = ''; f.elements.text.value = ''; stickBottom = true; updateChars(); }
    return;
  }
  if (f.matches('[data-wp-create]')) {
    const a = getAdapter();
    const msg = f.querySelector('[data-wp-msg]');
    if (!a || !a.ready) return;
    const vis = (f.querySelector('input[name="vis"]:checked') || {}).value === 'public' ? 'public' : 'private';
    f.querySelector('[type=submit]').disabled = true;
    try {
      await partyBridge.create(a, vis);
      await inviteAfterCreate();
    } catch (err) {
      f.querySelector('[type=submit]').disabled = false;
      if (msg) msg.textContent = err instanceof UserApiError && err.code === 'too_many_rooms' ? 'Tu as déjà trois salons ouverts : termine-en un d’abord.'
        : err instanceof UserApiError && err.code === 'kid_profile' ? 'Un profil enfant ne crée que des salons privés.' : 'Création du salon impossible pour le moment.';
    }
  }
}

async function copyText(url, okText) {
  try {
    await navigator.clipboard.writeText(url);
    toast(okText);
    return true;
  } catch {
    toast('Copie impossible : ' + url, { ms: 6000 });
    return false;
  }
}

export function copyLink(id) {
  return copyText(roomLink(id), 'Lien du salon copié');
}

/**
 * Copie le lien d'invitation du salon (hôte seulement) et l'affiche dans le panneau. Un seul lien pour tous les invités ;
 * `rotate` (« Nouveau lien ») invalide l'ancien. Rend vrai si la copie a réussi. Lève une erreur si l'invitation échoue.
 */
async function inviteLink(rotate = false) {
  const inv = await partyBridge.createInvite(rotate);
  lastInviteUrl = joinLinkOf(shareBase(), inv.roomId, inv.token);
  return copyText(lastInviteUrl, rotate ? 'Nouveau lien copié : l’ancien ne fonctionne plus' : 'Lien d’invitation copié');
}

/**
 * Le salon a renouvelé le lien après l'exclusion d'un invité : l'ancien est mort. On affiche le nouveau dans le champ du panneau
 * sans le copier (pas de geste utilisateur ici : la copie échouerait et afficherait le lien dans un message).
 */
async function renewLinkAfterKick() {
  try {
    const inv = await partyBridge.createInvite(false);
    lastInviteUrl = joinLinkOf(shareBase(), inv.roomId, inv.token);
    toast('Lien renouvelé après exclusion');
  } catch {
    lastInviteUrl = '';
    toast('Lien renouvelé après exclusion : recopie-le avec « Copier le lien d’invitation ».', { ms: 6000 });
  }
  render();
}

/** Bascule sur la meilleure source compatible avec tous les invités (même position), ou le dit. */
let compatBusy = false;

/** Recherche (en-tête des sources, quelques secondes) puis bascule ; un clic pendant la recherche ne fait rien. */
async function switchCompatible() {
  if (compatBusy) return;
  compatBusy = true;
  toast('Recherche d’une source compatible…', { ms: 4000 });
  let r = { status: 'none' };
  try {
    r = await partyBridge.switchToCompatible();
  } catch {
    r = { status: 'none' };
  } finally {
    compatBusy = false;
  }
  if (r.status === 'switched') {
    toast('Lecture sur une source compatible avec tous les invités' + (r.audioUnverified ? ' (son non vérifié)' : ''), { ms: 6000 });
  } else {
    toast('Aucune source compatible avec tous les invités', { ms: 6000 });
  }
  render();
}

async function invite(rotate = false) {
  try {
    if (await inviteLink(rotate)) flashCopied();
  } catch (err) {
    toast(err instanceof UserApiError && err.code === 'not_host' ? 'Seul l’hôte peut inviter.' : 'Invitation impossible pour le moment.');
  }
  render();
}

/**
 * Après la création, le créateur est l'hôte : on copie son lien d'invitation, jamais le lien de salon (réservé aux comptes).
 * Attend la bienvenue du serveur, puis réessaie une fois. En cas d'échec, rien n'est copié et le bouton reste dans le panneau.
 */
async function inviteAfterCreate() {
  createdHere = true;
  render();
  if (await partyBridge.waitForHost()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (await inviteLink()) flashCopied();
        render();
        return;
      } catch {
        if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  toast('Salon créé. Lien d’invitation indisponible : utilise « Copier le lien d’invitation » dans le panneau.', { ms: 6000 });
  render();
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  e.stopPropagation();
  const c = partyBridge.client;
  if (t.closest('[data-wp-close]')) { togglePartyPanel(false); return; }
  if (t.closest('[data-wp-invite]') && c) { void invite(); return; }
  if (t.closest('[data-wp-newlink]') && c) { void invite(true); return; }
  if (t.closest('[data-wp-compat]') && c) { void switchCompatible(); return; }
  if (t.closest('[data-wp-copy]') && c && c.room) { copyLink(c.room.id); return; }
  if (t.closest('[data-wp-chat-toggle]')) { toggleChat(); return; }
  // Quitter ferme le panneau : sans salon, il n'affichait que le formulaire de création.
  if (t.closest('[data-wp-leave]')) { partyBridge.leave(); togglePartyPanel(false); toast('Tu as quitté le salon'); return; }
  if (t.closest('[data-wp-end]')) {
    if (window.confirm('Terminer le salon pour tous les participants ?')) partyBridge.end();
    return;
  }
  const react = t.closest('[data-wp-react]');
  if (react && c) { c.sendReact(react.dataset.wpReact); return; }
  const mute = t.closest('[data-wp-mute]');
  if (mute && c) { c.mute(mute.dataset.wpMute, mute.dataset.muted !== '1'); return; }
  const host = t.closest('[data-wp-host]');
  if (host && c) { if (window.confirm('Céder le rôle d’hôte à ' + host.dataset.wpHost + ' ?')) c.transfer(host.dataset.wpHost); return; }
  const kick = t.closest('[data-wp-kick]');
  if (kick && c) { if (window.confirm('Exclure ' + kick.dataset.wpKick + ' du salon ?')) c.kick(kick.dataset.wpKick); return; }
  const rep = t.closest('[data-wp-report]');
  if (rep && c) { c.report(rep.dataset.wpReport, 'chat'); }
}
