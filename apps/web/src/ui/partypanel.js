/* Panneau « Watch party » du lecteur : création du salon, participants (rôle d'hôte, muet, exclusion), chat, réactions rapides.
 * La synchronisation de la lecture est dans src/party (contrôleur) ; ici, seulement l'interface. */
import { isKidProfile } from '../data/auth';
import { partyVisibilityChoices, partyBridge } from '../party/bridge';
import { endReasonText, joinLinkOf } from '../party/join';
import { CONTROL_OPTIONS, eventText, formatTimecode, initialsOf, isPlaybackEvent, REACTION_OPTIONS, STAGE_EMOJIS, syncText, WAIT_LATE_OPTIONS } from '../party/lobbyModel';
import { partyReactLimit } from '../party/reactLimit';
import { CHAT_MAX_CHARS, DEFAULT_SETTINGS, PARTY_WAIT_MAX_MS, partyErrorText } from '../party/protocol';
import { UserApiError } from '../data/userApi';
import { toast } from './dom.js';
import { LI } from '../player/icons.js';
import { requestWake } from '../player/idle';
import { shareBase } from './invites.js';
import { esc } from './util.js';
import { avatarAttrs } from './avatar-art.js';
import { friendPickerHTML, friendsListHTML, invitedPids, inviteInto } from './partyfriends.js';
import { safeTmdbImage } from './safeImg.js';
import { handlePartyCreateError } from './partyerrors.js';

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
/** Menu « … » du salon (participants, lien, réglages) déplié : l'état vit ici, le panneau est reconstruit à chaque rendu. */
let menuOpen = false;
let unread = 0;
let replaying = false;
/** Au prochain rendu, défiler tout en bas (après un envoi ou à l'ouverture du chat). */
let stickBottom = false;
let renderQueued = false;
/** Bandeau des participants (haut gauche du lecteur) et bandeau d'événement (haut centre) ; événements lisibles du salon pour le chat. */
let band = null;
let eventEl = null;
let eventTimer = 0;
let sysLines = [];
/** Compte à rebours, débit et synchro (1 s), abonnement au bridge et écouteurs du panneau : défaits par unmountPartyPanel. */
let tickTimer = 0;
let offBridge = null;
let listenersAc = null;

const CLOSE_BTN = '<button type="button" class="wp-close" data-wp-close aria-label="Fermer le panneau">' + LI.close + '</button>';
const fmtRate =(bps) => (bps / 1048576).toFixed(1).replace('.', ',') + ' Mo/s';
const guestCount = (c) => c.participants.filter((p) => p.guest).length;

/** Ligne compacte du partage : débit montant et nombre d’invités (secondaire). Texte seulement, jamais d’URL. */
function rateHTML() {
  const c = partyBridge.client;
  const n = c ? guestCount(c) : 0;
  const guests = '<span data-wp-guests>' + n + '</span> invité' + (n > 1 ? 's' : '');
  if (partyBridge.relayRefused()) {
    return '<span class="wp-rate-warn" title="Ce lien ne peut pas être partagé depuis le navigateur : les invités ne reçoivent pas la vidéo.">Partage bloqué</span> · ' + guests;
  }
  if (partyBridge.relayUnavailable()) {
    return '<span class="wp-rate-warn" title="Cette source (torrent ou lien protégé) ne peut pas être envoyée aux invités par lien : choisis une source débridée ou un lien direct.">Partage impossible avec cette source</span> · ' + guests;
  }
  const s = partyBridge.relayStats();
  // Rien n'est envoyé et personne n'est invité par lien : on dit seulement ce qu'est la watch party (pas de flux partagé).
  if (!s && n === 0) return 'Chacun lit avec sa propre source';
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
  return '<section class="wp-invite wp-card"><h4 class="wp-sub">Lien d’invitation</h4>' +
    (lastInviteUrl ? '<input type="text" class="wp-invite-link" data-wp-invite-link readonly value="' + esc(lastInviteUrl) + '" aria-label="Lien d’invitation">' : '') +
    '<div class="wp-invite-btns"><button type="button" class="wp-btn is-pri' + (inviteCopied ? ' is-done' : '') + '" data-wp-invite>' +
    (inviteCopied ? 'Copié' : 'Copier le lien d’invitation') + '</button>' +
    '<button type="button" class="wp-btn" data-wp-newlink title="L’ancien lien cesse de fonctionner ; les invités déjà dans le salon restent">Nouveau lien</button></div>' +
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

/** Avatar rond : l’illustration si elle est en cache (sinon hydratée par avatar-art), sur la couleur du participant ; l’initiale par-dessus. */
const avatarHTML = (p) => '<span class="wp-av' + (avatarIsLight(p.avatarColor) ? ' is-light' : '') + '"' + avatarAttrs(p.avatar, p.avatarColor) +
  ' aria-hidden="true"><span class="wp-av-ini">' + esc(initialsOf(p.username, !!p.guest)) + '</span></span>';

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

/**
 * Horodatage d’une ligne : la position du film (« 1:12:34 ») quand le salon la fournit, sinon l’heure locale. L’élément
 * garde la classe `wp-time`.
 */
export function stampHTML(l) {
  if (l && typeof l.pos === 'number' && Number.isFinite(l.pos)) {
    return '<time class="wp-time is-film" title="Position dans le film">' + esc(formatTimecode(l.pos)) + '</time>';
  }
  return timeHTML(l && l.at);
}

/** Lignes du chat : messages (avatar, pseudo, horodatage film) et événements du salon (`sys`). `people` : participants pour les avatars. */
export function chatHTML(lines, you, people = []) {
  if (!lines.length) return '<p class="wp-empty">Aucun message pour l’instant.</p>';
  return lines.map((l) => {
    if (l.sys) return '<p class="wp-sys">' + esc(l.text) + '</p>';
    const mine = you && l.from === you.username;
    const who = people.find((p) => p.username === l.from) || { username: l.from };
    return '<p class="wp-line' + (mine ? ' is-mine' : '') + '" data-wp-line="' + esc(l.id) + '">' + avatarHTML(who) +
      '<span class="wp-body"><b>' + esc(mine ? 'Moi' : l.from) + '</b> ' + stampHTML(l) + '<span class="wp-text">' + esc(l.text) + '</span></span>' +
      (mine ? '' : '<button type="button" class="wp-flag" data-wp-report="' + esc(l.id) + '" aria-label="Signaler ce message" title="Signaler">⚑</button>') + '</p>';
  }).join('');
}

/** Chat affiché : l’historique du salon et les événements lisibles, dans l’ordre du temps. */
function chatLines(c) {
  if (!sysLines.length) return c.chat;
  return [...c.chat, ...sysLines].sort((a, b) => (a.at || 0) - (b.at || 0));
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

/** Invitation ciblée d'un ami (réservée aux comptes : ni profil enfant, ni invité). */
function friendsHTML(c) {
  if (isKidProfile() || !c.room || (c.you && c.you.guest)) return '';
  return '<section class="wp-sec" data-wp-friends><h4 class="wp-sub">Inviter des amis</h4>' + friendsListHTML('wp-friend') + '</section>';
}

/** Réglages du salon (hôte) : trois groupes de choix, comme le salon d’attente. */
function settingsHTML(c) {
  const s = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  const group = (name, label, options) => '<div class="wp-set"><span class="wp-set-l">' + label + '</span><div class="wp-seg" role="radiogroup" aria-label="' + label + '">' +
    options.map(([v, t]) => '<button type="button" role="radio" aria-checked="' + (s[name] === v ? 'true' : 'false') + '" class="' + (s[name] === v ? 'on' : '') + '" data-wp-set="' + name + '" data-value="' + v + '">' + esc(t) + '</button>').join('') + '</div></div>';
  return '<details class="wp-more-box" data-wp-settings><summary>Réglages du salon</summary>' +
    group('control', 'Qui contrôle la lecture', CONTROL_OPTIONS) + group('waitLate', 'Attendre les retardataires', WAIT_LATE_OPTIONS) + group('reactions', 'Réactions à l’écran', REACTION_OPTIONS) + '</details>';
}

function createHTML() {
  const kid = isKidProfile();
  const choices = partyVisibilityChoices(kid);
  const a = getAdapter();
  const ready = !!(a && a.ready);
  const name = a && a.req && a.req.name ? String(a.req.name) : 'Ce titre';
  const poster = a ? safeTmdbImage(a.poster, 'w185') : null;
  const kind = a && a.req && a.req.type === 'tv' ? 'Série' : 'Film';
  const opt = (value, label, hint, on) => '<label class="wp-vopt"><input type="radio" name="vis" value="' + value + '"' + (on ? ' checked' : '') + '><span><b>' + esc(label) + '</b><i>' + esc(hint) + '</i></span></label>';
  const friends = friendPickerHTML();
  return '<div class="wp-cbar"><h3 class="wp-title">Watch party</h3>' + CLOSE_BTN + '</div>' +
    '<form class="wp-cform" data-wp-create><div class="wp-cbody">' +
    '<div class="wp-card wp-title-card">' + (poster ? '<span class="wp-poster-sm"><img src="' + esc(poster) + '" alt=""></span>' : '<span class="wp-poster-sm is-empty" aria-hidden="true"></span>') +
    '<span class="wp-title-t"><span class="wp-lb">En cours de lecture</span><b>' + esc(name) + '</b><span class="wp-sub-t">' + kind + ' · chacun lit avec sa propre source</span></span></div>' +
    '<fieldset class="wp-fs"><legend class="wp-lb">Qui peut rejoindre</legend><div class="wp-vopts">' +
    opt('private', 'Privé', kid ? 'Profil enfant : salon privé uniquement' : 'Amis invités', true) +
    (choices.includes('public') ? opt('public', 'Public', 'Listé dans « Watch parties »', false) : '') + '</div></fieldset>' +
    (friends ? '<div class="wp-sec"><div class="wp-lb">Inviter des amis</div>' + friends + '</div>' : '') +
    '</div><div class="wp-cfoot">' +
    '<p class="wp-msg" data-wp-msg role="status">' + (ready ? '' : 'Attends que la lecture démarre pour créer le salon.') + '</p>' +
    '<button type="submit" class="wp-btn is-pri is-lg"' + (ready ? '' : ' disabled') + '>Créer le salon</button>' +
    '<p class="wp-fine">Un lien d’invitation est copié à la création. Chacun lit avec sa propre source : aucun flux vidéo n’est partagé.</p></div></form>';
}

function roomHTML(c) {
  const you = c.you;
  const host = !!(you && you.host);
  const inviter = host || createdHere;
  const status = c.status === 'open' ? '' : '<p class="wp-status" role="status">' + (c.status === 'closed' ? 'Déconnecté du salon.' : 'Connexion au salon… reprise automatique.') + '</p>';
  const room = c.room;
  const wait = c.waiting && Array.isArray(c.waiting.who) && c.waiting.who.length ? c.waiting : null;
  const hostName = (c.participants.find((p) => p.host) || {}).username;
  const menu =
    '<section class="wp-menu" id="wp-menu" data-wp-menubox aria-label="Réglages du salon"' + (menuOpen ? '' : ' hidden') + '>' +
    '<div class="wp-sec"><h4 class="wp-sub">Participants · ' + c.participants.length + '</h4><ul class="wp-users" data-wp-users>' + participantsHTML(c.participants, you, host, partyBridge.guestVerdicts(), wait ? wait.who : []) + '</ul></div>' +
    (inviter ? inviteHTML() : '') + friendsHTML(c) + (host ? settingsHTML(c) : '') +
    (host ? '' : '<p class="wp-note">La lecture est partagée : pause, reprise et sauts valent pour tout le salon. Seul l’hôte change d’épisode.</p>') +
    '<div class="wp-actions">' + (inviter ? '' : '<button type="button" class="wp-btn" data-wp-copy>Copier le lien</button>') +
    '<button type="button" class="wp-btn" data-wp-leave>Quitter</button>' +
    (host ? '<button type="button" class="wp-btn is-danger" data-wp-end>Terminer pour tous</button>' : '') + '</div>' +
    '</section>';
  const muted = !!(you && you.muted);
  const hostPerson = c.participants.find((p) => p.host);
  return '<div class="wp-head">' + (hostPerson ? avatarHTML(hostPerson).replace('class="wp-av', 'class="wp-av wp-head-av') : '') +
    '<div class="wp-head-t"><h3 class="wp-title">' + esc(hostName ? 'Salon de ' + hostName : 'Salon') + '</h3>' +
    '<p class="wp-film">' + esc(room ? room.title : '') + '</p></div>' +
    '<button type="button" class="wp-head-btn wp-head-menu" data-wp-menu aria-label="Réglages du salon" aria-expanded="' + (menuOpen ? 'true' : 'false') + '" aria-controls="wp-menu">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>' + CLOSE_BTN + '</div>' +
    '<div class="wp-subrow"><span class="wp-vis">' + (room && room.visibility === 'public' ? 'Public' : 'Privé') + '</span><span class="wp-hint">Chacun lit avec sa propre source</span>' +
    (inviter ? '<button type="button" class="wp-head-btn wp-head-invite" data-wp-open-invite>Inviter</button>' : '') + '</div>' + status +
    menu +
    '<div class="wp-wait" data-wp-wait' + (wait ? '' : ' hidden') + '>' + waitInnerHTML(wait) + '</div>' +
    '<div class="wp-chatsec">' + chatHeadHTML() +
    '<div class="wp-chat-body" id="wp-chat-body" data-wp-chat-body' + (chatOpen ? '' : ' hidden') + '>' +
    '<div class="wp-chat" data-wp-chat role="log" aria-live="polite">' + chatHTML(chatLines(c), you, c.participants) + '</div>' +
    '<div class="wp-foot">' +
    '<div class="wp-react" role="group" aria-label="Réactions">' + STAGE_EMOJIS.map((e) => '<button type="button" data-wp-react="' + e + '" aria-label="Réaction ' + e + '">' + e + '</button>').join('') + '</div>' +
    '<form class="wp-send" data-wp-send><input type="text" name="text" maxlength="' + CHAT_MAX_CHARS + '" autocomplete="off" aria-label="Message" placeholder="' + (muted ? 'Tu es muet' : 'Écrire… (Entrée pour envoyer)') + '"' + (muted ? ' disabled' : '') + ' value="' + esc(chatDraft) + '">' +
    '<span class="wp-chars" data-wp-chars>' + chatDraft.length + '/' + CHAT_MAX_CHARS + '</span>' +
    '<button type="submit" class="btn btn-primary btn-sm" aria-label="Envoyer"' + (muted ? ' disabled' : '') + '>Envoyer</button></form></div>' +
    '</div></div>';
}

function render() {
  if (!panel) return;
  panel.hidden = !open;
  rootEl.classList.toggle('has-party-panel', open);
  renderBand();
  if (!open) return;
  const c = partyBridge.client;
  const typing = panel.contains(document.activeElement) && document.activeElement.name === 'text';
  if (typing) chatDraft = document.activeElement.value;
  const chatBox = panel.querySelector('[data-wp-chat]');
  const keepScroll = stickBottom || (chatBox ? chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40 : true);
  stickBottom = false;
  panel.innerHTML = (c && c.status !== 'idle' ? roomHTML(c) : createHTML()) +
    (partyBridge.endReason ? '<p class="wp-msg" role="alert">' + esc(endReasonText(partyBridge.endReason)) + '</p>' : '') +
    (partyBridge.lastError ? '<p class="wp-msg" role="alert">' + esc(partyBridge.lastError) + '</p>' : '');
  const box = panel.querySelector('[data-wp-chat]');
  if (box && keepScroll) box.scrollTop = box.scrollHeight;
  if (typing) {
    const input = panel.querySelector('input[name="text"]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

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

/** Déplie ou replie le menu « … ». `focusSel` : élément du menu à focaliser ; sinon `refocus` rend le focus au bouton « … » à la fermeture. */
function setMenu(on, refocus, focusSel) {
  menuOpen = on;
  render();
  if (!panel) return;
  if (on && focusSel) {
    const el = panel.querySelector(focusSel);
    if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus(); }
  } else if (refocus) {
    const b = panel.querySelector('[data-wp-menu]');
    if (b) b.focus();
  }
}

/** Échap replie le menu « … » (et rend le focus à son bouton) sans fermer le lecteur. */
function onKeyDown(e) {
  if (e.key !== 'Escape' || !menuOpen) return;
  e.stopPropagation();
  e.preventDefault();
  setMenu(false, true);
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
  if (input && counter) counter.textContent = input.value.length + '/' + CHAT_MAX_CHARS;
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

/** Réaction signée : l’avatar de son auteur à côté de l’emoji, qui monte puis s’efface. Réglage « discrètes » : plus petite ; « off » : rien. */
function floatReaction(c, r) {
  if (!floats) return;
  const mode = (c.settings && c.settings.reactions) || 'float';
  if (mode === 'off') return;
  const by = r.by || r.user;
  const who = (c.participants || []).find((p) => p.username === by) || { username: by };
  const s = document.createElement('span');
  s.className = 'wp-float ps-float' + (mode === 'discreet' ? ' is-discreet' : '');
  s.style.left = 8 + Math.random() * 80 + '%';
  s.title = by;
  s.innerHTML = avatarHTML(who).replace('class="wp-av', 'class="wp-av ps-float-av') + '<span class="ps-float-e"></span>';
  s.querySelector('.ps-float-e').textContent = r.emoji;
  floats.appendChild(s);
  setTimeout(() => s.remove(), 3200);
}

/** Bandeau d’événement (« Hugo a reculé de 10 s · pour tout le monde »), quelques secondes ; le texte passe par textContent. */
function showEvent(c, ev) {
  if (!eventEl || !isPlaybackEvent(ev.kind)) return;
  const who = (c.participants || []).find((p) => p.username === ev.by) || { username: ev.by };
  eventEl.innerHTML = avatarHTML(who) + '<span class="ps-event-t"></span>';
  eventEl.querySelector('.ps-event-t').textContent = eventText(ev) + ' · pour tout le monde';
  eventEl.hidden = false;
  requestWake(eventEl);
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { eventEl.hidden = true; }, 4000);
}

/** Événement du salon : bandeau pour la lecture, et ligne discrète dans le chat. */
function onEvent(c, ev) {
  showEvent(c, ev);
  const text = eventText(ev);
  if (!text) return;
  sysLines.push({ sys: true, id: 'sys-' + Date.now() + '-' + sysLines.length, text, at: Date.now() });
  if (sysLines.length > 100) sysLines.shift();
  renderSoon();
}

/** Bandeau des participants (haut gauche) : avatars, « N en salle », écart de synchronisation, micro bientôt, masquer le chat. */
function renderBand() {
  if (!band) return;
  const c = partyBridge.client;
  const live = !!c && c.status !== 'idle' && c.status !== 'closed' && !!c.room;
  band.hidden = !live;
  if (eventEl && !live) eventEl.hidden = true;
  if (!live) return;
  const list = c.participants || [];
  const shown = list.slice(0, 4);
  const more = list.length - shown.length;
  const sync = syncText(partyBridge.controller ? partyBridge.controller.drift : null);
  band.innerHTML = '<div class="ps-avs" aria-hidden="true">' + shown.map((p) => avatarHTML(p).replace('class="wp-av', 'class="wp-av ps-av')).join('') +
    (more > 0 ? '<span class="wp-av ps-av ps-more">+' + more + '</span>' : '') + '</div>' +
    '<div class="ps-info"><div class="ps-n">' + list.length + ' en salle</div><div class="ps-sync' + (sync.ok ? '' : ' is-off') + '" data-ps-sync role="status">' + esc(sync.text) + '</div></div>' +
    '<button type="button" class="ps-btn" disabled aria-label="Micro (bientôt disponible)" title="Micro : bientôt">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg></button>' +
    '<button type="button" class="ps-btn" data-ps-chat aria-pressed="' + (open ? 'true' : 'false') + '" aria-label="' + (open ? 'Masquer la discussion' : 'Afficher la discussion') + '" title="' + (open ? 'Masquer la discussion' : 'Afficher la discussion') + '">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>';
}

/** Met à jour seulement la ligne de synchronisation (chaque seconde). */
function updateSync() {
  if (!band || band.hidden) return;
  const el = band.querySelector('[data-ps-sync]');
  if (!el) return;
  const sync = syncText(partyBridge.controller ? partyBridge.controller.drift : null);
  if (el.textContent !== sync.text) el.textContent = sync.text;
  // Passage à « désynchronisé » : réaffiche le bandeau (une fois par bascule, pas à chaque seconde).
  if (!sync.ok && !el.classList.contains('is-off')) requestWake(band);
  el.classList.toggle('is-off', !sync.ok);
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
  sysLines = [];
  invitedPids.clear();
  lastInviteUrl = '';
  createdHere = false;
  inviteCopied = false;
  chatOpen = true;
  menuOpen = false;
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
  c.on('react', (r) => floatReaction(c, r));
  c.on('event', (ev) => onEvent(c, ev));
  c.on('settings', () => renderSoon());
  c.on('participants', () => renderSoon());
  c.on('host', (user) => { toast(user + ' est maintenant l’hôte'); render(); });
  c.on('muted', () => render());
  c.on('reported', (r) => { if (r.against) toast('Signalement reçu : ' + r.against); else toast('Message signalé, merci'); });
  c.on('error', (code) => { const t = partyErrorText(code); if (t) toast(t); });
  c.on('end', (reason) => { toast(endReasonText(reason)); render(); });
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
  band = document.createElement('div');
  band.className = 'ps-band';
  band.hidden = true;
  eventEl = document.createElement('div');
  eventEl.className = 'ps-event';
  eventEl.setAttribute('role', 'status');
  eventEl.hidden = true;
  root.appendChild(band);
  root.appendChild(eventEl);
  root.appendChild(floats);
  root.appendChild(panel);
  listenersAc = new AbortController();
  const { signal } = listenersAc;
  offBridge = partyBridge.onChange(() => { attach(); render(); });
  partyBridge.onCreated = () => { togglePartyPanel(true); void inviteAfterCreate(); };
  panel.addEventListener('click', onClick, { signal });
  panel.addEventListener('submit', onSubmit, { signal });
  panel.addEventListener('input', onInput, { signal });
  panel.addEventListener('keydown', onKeyDown, { signal });
  band.addEventListener('click', onBandClick, { signal });
  tickTimer = setInterval(() => { updateRelayLine(); updateCountdown(); updateSync(); }, 1000);
}

/**
 * Démontage du panneau : arrête le compte à rebours et les minuteries d'affichage, retire les écouteurs, l'abonnement au
 * bridge et les éléments du DOM. Sans effet si rien n'est monté ; un nouveau `mountPartyPanel` repart de zéro.
 */
export function unmountPartyPanel() {
  if (!rootEl) return;
  clearInterval(tickTimer);
  tickTimer = 0;
  clearTimeout(copiedTimer);
  copiedTimer = 0;
  clearTimeout(eventTimer);
  eventTimer = 0;
  listenersAc.abort();
  listenersAc = null;
  offBridge();
  offBridge = null;
  partyBridge.onCreated = null;
  for (const el of [band, eventEl, floats, panel]) el.remove();
  rootEl.classList.remove('has-party-panel');
  rootEl = null;
  panel = null;
  floats = null;
  band = null;
  eventEl = null;
  open = false;
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
    const text = f.elements.text.value.slice(0, CHAT_MAX_CHARS);
    const pos = partyBridge.position();
    if (c && (pos === null ? c.sendChat(text) : c.sendChat(text, pos))) { chatDraft = ''; f.elements.text.value = ''; stickBottom = true; updateChars(); }
    return;
  }
  if (f.matches('[data-wp-create]')) {
    const a = getAdapter();
    const msg = f.querySelector('[data-wp-msg]');
    if (!a || !a.ready) return;
    const vis = (f.querySelector('input[name="vis"]:checked') || {}).value === 'public' ? 'public' : 'private';
    const pids = isKidProfile() ? [] : [...f.querySelectorAll('input[name="friend"]:checked')].map((i) => i.value);
    f.querySelector('[type=submit]').disabled = true;
    try {
      const room = await partyBridge.create(a, vis);
      await inviteAfterCreate();
      if (pids.length && room) void inviteChosen(room.id, pids);
    } catch (err) {
      f.querySelector('[type=submit]').disabled = false;
      void handlePartyCreateError(err, { retry: () => { const cur = document.querySelector('[data-wp-create]'); if (cur instanceof HTMLFormElement) cur.requestSubmit(); }, say: (t) => { if (msg) msg.textContent = t; } });
    }
  }
}

/** Amis cochés à la création : invités dans le salon (un seul toast pour le lot). */
async function inviteChosen(roomId, pids) {
  // À la suite et arrêt au premier échec : un refus (trop d'invitations, etc.) ne donne qu'un seul message.
  let n = 0;
  for (const pid of pids) {
    if (!(await inviteInto(roomId, pid))) break;
    n += 1;
  }
  if (n) toast(n === 1 ? 'Invitation envoyée' : n + ' invitations envoyées');
  render();
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

/** Bandeau : « Masquer / Afficher la discussion » (le micro est désactivé, bientôt). */
function onBandClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (t && t.closest('[data-ps-chat]')) togglePartyPanel();
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  e.stopPropagation();
  const c = partyBridge.client;
  if (t.closest('[data-wp-close]')) { togglePartyPanel(false); return; }
  if (t.closest('[data-wp-menu]')) { setMenu(!menuOpen, true); return; }
  if (t.closest('[data-wp-open-invite]')) { setMenu(true, false, '[data-wp-invite]'); return; }
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
  if (react && c) {
    // Une réaction de salon par seconde (LAST-1615) : au-delà, ignorée sans erreur.
    if (!partyReactLimit.ready()) return;
    const pos = partyBridge.position();
    const sent = pos === null ? c.sendReact(react.dataset.wpReact) : c.sendReact(react.dataset.wpReact, pos);
    if (sent) partyReactLimit.sent();
    return;
  }
  const set = t.closest('[data-wp-set]');
  if (set && c) { c.sendSettings({ [set.dataset.wpSet]: set.dataset.value }); return; }
  const friend = t.closest('[data-wp-friend]');
  if (friend && c && c.room) {
    friend.disabled = true;
    void inviteInto(c.room.id, friend.dataset.wpFriend).then((ok) => { if (ok) toast('Invitation envoyée'); render(); });
    return;
  }
  const mute = t.closest('[data-wp-mute]');
  if (mute && c) { c.mute(mute.dataset.wpMute, mute.dataset.muted !== '1'); return; }
  const host = t.closest('[data-wp-host]');
  if (host && c) { if (window.confirm('Céder le rôle d’hôte à ' + host.dataset.wpHost + ' ?')) c.transfer(host.dataset.wpHost); return; }
  const kick = t.closest('[data-wp-kick]');
  if (kick && c) { if (window.confirm('Exclure ' + kick.dataset.wpKick + ' du salon ?')) c.kick(kick.dataset.wpKick); return; }
  const rep = t.closest('[data-wp-report]');
  if (rep && c) { c.report(rep.dataset.wpReport, 'chat'); }
}
