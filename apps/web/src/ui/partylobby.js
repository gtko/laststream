/* Salon d'attente d'une watch party (Social v3, lot F6) : plein écran avant le départ. Bandeau du titre, participants (avatar,
 * état prêt, qualité, recherche de source), tuile « Inviter », réglages de l'hôte, vote du titre, discussion, puis départ avec
 * compte à rebours ; à zéro, chacun lance la lecture avec SA source (voir partyBridge.launchRoom).
 * Possède aussi les points d'entrée partagés `inviteToParty` et `openPartyLobby` (socialHooks.js).
 * Tout texte venu d'un participant passe par esc() ; l'interface est entièrement accessible au clavier. */
import { auth, isKidProfile, isServerMode, onAuthChange } from '../data/auth';
import { tmdb } from '../data/lt';
import { onPartyInvite, subscribe as socialSubscribe } from '../data/socialStore';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { partyBridge } from '../party/bridge';
import { endReasonText, joinLinkOf } from '../party/join';
import {
  buildSourceRows, CONTROL_OPTIONS, countdownLeft, eventText, hostSourceLine, initialsOf, launchText, LOBBY_EMOJIS, noSourceInRoomLanguage, prepView,
  REACTION_OPTIONS, readySummary, readyText, SOURCE_BADGE_TEXT, sourceLanguageWarning, sourceSearchText, startWithoutText, voteShare, WAIT_LATE_OPTIONS,
} from '../party/lobbyModel';
import { bestSource, chooseSource, roomLangOf, sourceLabel } from '../party/sourceChoice';
import { badSources, sourceKey as badSourceKey } from '../player/memory';
import { sourceKeyOf } from '../sources/info';
import { webCompatContext } from '../sources/load';
import { webCompatOf } from '../sources/webCompat';
import { CHAT_MAX_CHARS, COUNTDOWN_DEFAULT_SEC, VOTE_MAX_OPTIONS, partyErrorText } from '../party/protocol';
import { loadSources, pollSources } from '../sources/load';
import { avatarAttrs } from './avatar-art.js';
import { openPartyCreate } from './partyCreate.js';
import { friendsListHTML, invitedPids, inviteInto } from './partyfriends.js';
import { handlePartyCreateError } from './partyerrors.js';
import { cssUrl, safeTmdbImage } from './safeImg.js';
import { toast } from './dom.js';
import { shareBase } from './invites.js';
import { registerSocialHook } from './socialHooks.js';
import { togglePartyPanel } from './partypanel.js';
import { pushLayer } from './backStack.js';
import { copyToClipboard, esc } from './util.js';

const MAX_PARTICIPANTS_FALLBACK = 20;
const GUEST_SLOTS = 4;
const SEARCH_POLL_MAX = 8;
const SEARCH_POLL_MS = 2000;
/** Écart toléré entre l'échéance du compte à rebours et l'instant où `countdown: null` arrive (horloges, réseau). */
const COUNTDOWN_TOLERANCE_MS = 1000;
/** Délai avant d'envoyer au salon un choix de source (flèches enchaînées : seul le dernier part). */
const DECLARE_DELAY_MS = 300;

const ICON = {
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  plus: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/** Vue du salon d'attente (null : fermé). */
let root = null;
let client = null;
let offs = [];
let tab = 'chat';
let linkCopied = false;
let copiedTimer = 0;
let linkBusy = false;
let renderQueued = false;
let countTimer = 0;
let launched = false;
/** Compte à rebours vu dans ce salon : échéance (heure du serveur) tant qu'il court, et drapeau pour retenir la lecture au départ. */
let countdownDue = null;
let countdownSeen = false;
let declareTimer = 0;
let myVote = '';
let lastVoteOptions = [];
let feed = [];
let prep = { phase: 'idle', quality: '' };
let prepRun = 0;
/** Sources du participant : liste reçue (progressive), choix explicite (clé stable), source retenue, libellé déjà annoncé au salon et ordre des lignes déjà affichées (elles ne bougent plus). */
const freshSources = () => ({ views: [], loaded: null, searching: false, explicit: '', selected: null, declared: '', order: [] });
let src = freshSources();
let picker = null;
let socialOff = null;
let opener = null;
/** Retire le salon d'attente de la pile du bouton retour (voir backStack.js). */
let releaseBack = null;
/** Ouverture en cours : une seconde ouverture pendant l'attente du serveur rend la première sans effet. */
let openSeq = 0;
/** Lien d'invitation que la copie automatique n'a pas pu poser dans le presse-papiers : affiché dans un champ à copier à la main. */
let manualLink = '';

const isHost = () => !!(client && client.isHost);
const myName = () => (client && client.you ? client.you.username : '');
const sNow = () => (client ? client.serverNow() : Date.now());

// ---------- Rendu ----------
const avatar = (p, size) => '<span class="pl-av' + (size ? ' is-' + size : '') + '"' + avatarAttrs(p.avatar, p.avatarColor) + ' aria-hidden="true"><span class="pl-av-ini">' +
  esc(initialsOf(p.username, !!p.guest)) + '</span></span>';

function participantCard(p) {
  const me = p.username === myName();
  const v = prepView(p.guest ? { ...p, ready: true, status: p.status === 'buffering' ? 'buffering' : 'ready' } : p);
  const tags = (p.host ? '<span class="pl-tag is-host">· hôte</span>' : '') + (p.guest ? '<span class="pl-tag">· invité</span>' : '');
  const stateIcon = v.state === 'ready' ? ICON.check : '<span class="pl-spin" aria-hidden="true"></span>';
  const tools = isHost() && !me && !p.host
    ? '<span class="pl-card-tools"><button type="button" class="pl-mini" data-pl-host="' + esc(p.username) + '">Céder l’hôte</button>' +
      '<button type="button" class="pl-mini is-danger" data-pl-kick="' + esc(p.username) + '">Exclure</button></span>'
    : '';
  return '<li class="pl-card' + (p.host ? ' is-host' : '') + '">' + avatar(p, 'lg') +
    '<span class="pl-card-name">' + esc(p.username) + (me ? ' <span class="pl-tag">(toi)</span>' : '') + tags + '</span>' +
    '<span class="pl-state is-' + v.state + '">' + stateIcon + '<span>' + esc(v.label) + '</span></span>' + tools + '</li>';
}

function seg(name, label, options, current, host) {
  return '<div class="pl-set"><div class="pl-lb" id="pl-set-' + name + '">' + esc(label) + '</div>' +
    '<div class="pl-seg" role="radiogroup" aria-labelledby="pl-set-' + name + '">' +
    options.map(([value, text]) => '<button type="button" role="radio" class="' + (value === current ? 'on' : '') + '" aria-checked="' + (value === current ? 'true' : 'false') + '"' +
      ' data-pl-set="' + name + '" data-value="' + value + '" tabindex="' + (value === current ? '0' : '-1') + '"' + (host ? '' : ' disabled') + '>' + esc(text) + '</button>').join('') +
    '</div></div>';
}

function linkBoxHTML() {
  if (!isHost()) return '<div class="pl-link is-empty"><span class="pl-link-note">Les réglages et le départ sont à l’hôte.</span></div>';
  const guests = client.participants.filter((p) => p.guest).length;
  const slots = Math.max(0, GUEST_SLOTS - guests);
  let shown = 'lien d’invitation';
  try { shown = new URL(shareBase()).host + '/…'; } catch { /* base relative : libellé générique */ }
  return '<div class="pl-link">' + ICON.link + '<span class="pl-link-t">' + esc(shown) + '</span>' +
    '<span class="pl-link-note">sans compte : ' + slots + ' place' + (slots > 1 ? 's' : '') + ', 12 h</span>' +
    '<button type="button" class="pl-btn is-sec is-sm" data-pl-copy>' + (linkCopied ? 'Copié' : 'Copier') + '</button></div>' +
    (manualLink ? '<input type="text" class="pl-link-manual" data-pl-manual readonly value="' + esc(manualLink) + '" aria-label="Lien d’invitation à copier">' : '');
}

function footerHTML(sum) {
  const left = countdownLeft(client.countdownAt, sNow());
  if (!isHost()) {
    return linkBoxHTML() + (left !== null ? '' : '<p class="pl-wait" role="status">En attente du départ par ' + esc(client.room ? client.room.host : 'l’hôte') + '…</p>');
  }
  const waiting = sum.waiting;
  const counting = left !== null;
  const without = waiting.length > 0 && !counting
    ? '<button type="button" class="pl-btn is-sec is-lg" data-pl-start-now>' + esc(startWithoutText(waiting)) + '</button>' : '';
  return linkBoxHTML() + without +
    '<button type="button" class="pl-btn is-pri is-lg is-xl" data-pl-start' + (waiting.length > 0 || counting ? ' disabled' : '') +
    (waiting.length > 0 ? ' title="En attente de ' + esc(waiting.join(', ')) + '"' : '') + '>' + ICON.play + esc(counting ? 'Départ dans ' + left + ' s' : launchText(COUNTDOWN_DEFAULT_SEC)) + '</button>';
}

function mainHTML() {
  const room = client.room;
  const list = client.participants;
  const sum = readySummary(list.map((p) => (p.guest ? { ...p, ready: true, status: 'ready' } : p)));
  const max = room && room.maxParticipants ? room.maxParticipants : MAX_PARTICIPANTS_FALLBACK;
  const host = isHost();
  const poster = room && room.poster ? cssUrl(safeTmdbImage(room.poster, 'w780')) : '';
  const media = room ? room.media : null;
  const ep = media && media.type === 'series' && media.season != null ? ' · S' + media.season + ' É' + media.episode : '';
  const status = client.status === 'open' ? '' : '<p class="pl-conn" role="status">' + (client.status === 'closed' ? 'Déconnecté du salon.' : 'Connexion au salon… reprise automatique.') + '</p>';
  const cards = list.map(participantCard).join('');
  const invite = '<li class="pl-card-wrap"><button type="button" class="pl-card is-invite" data-pl-invite-tile aria-label="Inviter des amis"><span class="pl-invite-plus">' + ICON.plus + '</span><span class="pl-card-name">Inviter</span></button></li>';
  const s = client.settings;
  return '<header class="pl-hero"' + (poster ? ' style="--pl-poster:' + poster.replace(/"/g, '&quot;') + '"' : '') + '>' +
    '<div class="pl-hero-top"><button type="button" class="pl-ico" data-pl-leave aria-label="Quitter le salon">' + ICON.back + '</button>' +
    '<span class="pl-pill"><span class="pl-dot" aria-hidden="true"></span>Salon de ' + esc(room ? room.host : '…') + ' · ' + (room && room.visibility === 'public' ? 'public' : 'privé') + '</span>' +
    '<span class="pl-grow"></span>' + (host ? '<button type="button" class="pl-btn is-sec is-glass" data-pl-change>Changer de titre</button>' : '') + '</div>' +
    '<div class="pl-hero-bot"><div class="pl-lb is-soft">Watch party · salon d’attente</div>' +
    '<h1 class="pl-title" id="pl-title" tabindex="-1">' + esc(room ? room.title : 'Salon') + esc(ep) + '</h1>' +
    '<p class="pl-sub">Chacun lit avec sa propre source' + (room && room.language ? ' · ' + esc(String(room.language).toUpperCase()) + ' conseillé par l’hôte' : '') + '</p></div></header>' +
    '<section class="pl-body">' + status +
    '<div class="pl-row"><div class="pl-lb pl-grow">Participants · ' + list.length + ' / ' + max + '</div><span class="pl-ready" aria-live="polite">' + esc(readyText(sum)) + '</span></div>' +
    '<ul class="pl-grid" aria-label="Participants">' + cards + invite + '</ul>' + prepNoteHTML() + sourcesHTML() +
    '<div class="pl-sets">' + seg('control', 'Qui contrôle la lecture', CONTROL_OPTIONS, s.control, host) +
    seg('waitLate', 'Attendre les retardataires', WAIT_LATE_OPTIONS, s.waitLate, host) +
    seg('reactions', 'Réactions à l’écran', REACTION_OPTIONS, s.reactions, host) + '</div>' +
    '<div class="pl-foot">' + footerHTML(sum) + '</div></section>' + countdownHTML();
}

const roomLang = () => (client && client.room ? roomLangOf(client.room.language, '') : null);
/** Libellé de la version lue par l'hôte (son « prêt » porte la source) ; null pour l'hôte lui-même. */
const hostLabelOf = () => {
  if (!client || isHost()) return null;
  const h = client.participants.find((p) => p.host);
  return h && h.quality ? h.quality : null;
};

/** Identifiants opaques des lignes de sources : la clé d'une source peut contenir un lien (jeton de débrideur), le DOM ne reçoit que « s1 », « s2 »… */
const rowIds = new Map();
const rowKeys = new Map();
function rowIdOf(key) {
  let id = rowIds.get(key);
  if (!id) { id = 's' + (rowIds.size + 1); rowIds.set(key, id); rowKeys.set(id, key); }
  return id;
}

/** Fournisseur d'une ligne (« Lumpi ») et doublons regroupés (« +2 fournisseurs », essayés en premier si la source échoue). */
function sourceProviderHTML(r) {
  if (!r.provider && !r.others) return '';
  const more = r.others > 0 ? ' <span class="pl-src-more" title="Même fichier chez ' + r.others + ' autre' + (r.others > 1 ? 's' : '') + ' fournisseur' + (r.others > 1 ? 's' : '') + ' : essayé' + (r.others > 1 ? 's' : '') + ' en premier si celui-ci échoue">+' + r.others + '</span>' : '';
  return '<span class="pl-src-prov">' + esc(r.provider || 'Fournisseur inconnu') + more + '</span>';
}

/** « Ma source » : les sources trouvées (langue, qualité), celle qui sera lancée au départ, et ce qui la rapproche de l'hôte. */
function sourcesHTML() {
  if (prep.phase === 'idle') return '';
  const lang = roomLang();
  const hostLabel = hostLabelOf();
  const ctx = webCompatContext();
  const rows = buildSourceRows(src.views, {
    selectedKey: src.selected ? sourceKeyOf(src.selected) : '', hostLabel, roomLanguage: lang, order: src.order,
    compat: (v) => { const w = webCompatOf(v, ctx); return w.level === 'ok' ? null : w.reason; },
  });
  const found = src.views.filter((v) => v.playable).length;
  if (!rows.length && !src.searching) return '';
  const hostLine = hostSourceLine(hostLabel);
  const roomName = client.room && client.room.language ? String(client.room.language).toUpperCase() : '';
  const warn = sourceLanguageWarning(src.selected, lang, roomName);
  const banner = !src.searching && noSourceInRoomLanguage(src.views, lang)
    ? '<p class="pl-src-banner" role="status"><span>Aucune source en ' + esc(roomName || 'cette langue') + ' pour l’instant.</span> <button type="button" class="pl-link-btn" data-pl-retry>Réessayer la recherche</button></p>'
    : '';
  const focusable = rows.some((r) => r.selected) ? '' : rows[0] && rowIdOf(rows[0].key);
  const list = rows.map((r) => '<button type="button" role="radio" class="pl-src-row' + (r.selected ? ' on' : '') + '" aria-checked="' + (r.selected ? 'true' : 'false') + '"' +
    ' data-pl-source data-key="' + rowIdOf(r.key) + '" tabindex="' + (r.selected || rowIdOf(r.key) === focusable ? '0' : '-1') + '">' +
    '<span class="pl-src-dot" aria-hidden="true"></span><span class="pl-src-main"><b>' + esc(r.label) + '</b>' + (r.meta ? '<span class="pl-src-meta">' + esc(r.meta) + '</span>' : '') + sourceProviderHTML(r) +
    (r.detail ? '<span class="pl-src-detail">' + esc(r.detail) + '</span>' : '') +
    (r.release ? '<span class="pl-src-file" title="' + esc(r.release) + '">' + esc(r.release) + '</span>' : '') +
    (r.warn ? '<span class="pl-src-compat">' + esc(r.warn) + '</span>' : '') + '</span>' +
    (r.badge ? '<span class="pl-src-badge is-' + r.badge + '">' + esc(SOURCE_BADGE_TEXT[r.badge]) + '</span>' : '') + '</button>').join('');
  return '<section class="pl-src" aria-labelledby="pl-src-t"><div class="pl-row"><div class="pl-lb pl-grow" id="pl-src-t">Ma source</div>' +
    '<span class="pl-src-status" role="status">' + esc(sourceSearchText(found, src.searching)) + '</span></div>' +
    (hostLine ? '<p class="pl-src-host">' + esc(hostLine) + '</p>' : '') + banner +
    '<div class="pl-src-list" role="radiogroup" aria-labelledby="pl-src-t">' + list + '</div>' +
    (warn ? '<p class="pl-src-warn" role="alert">' + esc(warn) + '</p>' : '') + '</section>';
}

function prepNoteHTML() {
  if (prep.phase === 'none') {
    return '<p class="pl-note" role="status">Aucune source trouvée pour ce titre sur cet appareil. <button type="button" class="pl-link-btn" data-pl-retry>Réessayer</button></p>';
  }
  return '';
}

function countdownHTML() {
  const left = countdownLeft(client.countdownAt, sNow());
  if (left === null) return '';
  return '<div class="pl-count" role="status" aria-live="assertive"><div class="pl-count-n">' + left + '</div><div class="pl-count-t">La lecture démarre…</div></div>';
}

// ---------- Discussion ----------
function chatItem(line) {
  const author = client.participants.find((p) => p.username === line.from) || { username: line.from };
  const mine = line.from === myName();
  return '<div class="pl-msg' + (mine ? ' is-mine' : '') + '" data-pl-line="' + esc(line.id) + '">' + avatar(author) +
    '<div><b>' + esc(mine ? 'Moi' : line.from) + '</b>' + (author.guest ? ' <span class="pl-tag">invité</span>' : '') + '<div class="pl-msg-t">' + esc(line.text) + '</div></div></div>';
}

function voteHTML() {
  const options = client.vote;
  if (!options) return '';
  const host = isHost();
  return '<div class="pl-vote" role="group" aria-label="Vote du titre"><div class="pl-vote-h">' + esc((client.room ? client.room.host : 'L’hôte') + ' propose de voter le film') + '</div>' +
    options.map((o) => {
      const share = voteShare(o, options);
      return '<button type="button" class="pl-vote-o' + (o.id === myVote ? ' is-mine' : '') + '" data-pl-vote="' + esc(o.id) + '" aria-pressed="' + (o.id === myVote ? 'true' : 'false') + '">' +
        '<span class="pl-vote-bar" style="width:' + share + '%"></span><span class="pl-vote-t">' + esc(o.title) + '</span><b>' + o.votes + '</b></button>';
    }).join('') + (host ? '<button type="button" class="pl-btn is-sec is-sm" data-pl-vote-close>Clore le vote</button>' : '') + '</div>';
}

function feedHTML() {
  const items = feed.map((it) => (it.kind === 'sys' ? '<div class="pl-sys">' + esc(it.text) + '</div>' : chatItem(it.line))).join('');
  return (items || '<p class="pl-empty">Aucun message pour l’instant.</p>') + voteHTML();
}

function sideBodyHTML() {
  return tab === 'friends' ? friendsListHTML('pl-friend') : feedHTML();
}

function paintSide() {
  if (!root) return;
  const body = root.querySelector('[data-pl-feed]');
  if (!body) return;
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML = sideBodyHTML();
  // Seulement si le fil était déjà en bas : remonter dans la discussion ne doit pas être annulé à chaque rafraîchissement.
  if (stick) body.scrollTop = body.scrollHeight;
  root.querySelectorAll('[data-pl-tab]').forEach((b) => {
    const on = b.dataset.plTab === tab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  const chatOnly = root.querySelectorAll('[data-pl-chatonly]');
  chatOnly.forEach((el) => { el.hidden = tab !== 'chat'; });
}

function paintMain() {
  if (!root || !client) return;
  const main = root.querySelector('[data-pl-main]');
  if (!main) return;
  const keep = main.contains(document.activeElement) ? focusKey(document.activeElement) : '';
  const scroll = main.scrollTop;
  main.innerHTML = mainHTML();
  main.scrollTop = scroll;
  if (keep) restoreFocus(main, keep);
}

/** Repère stable d'un contrôle du salon, pour lui rendre le focus après un nouveau rendu. */
function focusKey(el) {
  for (const a of ['plSource', 'plSet', 'plStart', 'plStartNow', 'plCopy', 'plInviteTile', 'plChange', 'plLeave', 'plRetry']) {
    if (el.dataset && a in el.dataset) return '[data-' + a.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ']' + (a === 'plSet' ? '[data-value="' + el.dataset.value + '"]' : a === 'plSource' ? '[data-key="' + String(el.dataset.key).replace(/["\\]/g, '\\$&') + '"]' : '');
  }
  return '';
}
function restoreFocus(main, sel) {
  const target = main.querySelector(sel);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function render() {
  if (!root || !client) return;
  paintMain();
  paintSide();
}

function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; render(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
}

// ---------- Fil de discussion ----------
const pushSys = (text) => { feed.push({ kind: 'sys', text, at: Date.now() }); feed = feed.slice(-200); };

function seedFeed() {
  feed = client.chat.map((line) => ({ kind: 'chat', line, at: line.at }));
}

// ---------- Préparation (recherche de source) ----------
/**
 * Source retenue : le choix explicite du participant, sinon la version de l'hôte, sinon la meilleure dans la langue du salon (sans
 * source dans cette langue, la meilleure : l'avertissement le dit). Se déclare prêt avec ce libellé dès qu'une source existe.
 */
function applyChoice(opts = {}) {
  const c = client;
  if (!c || !c.room) return;
  const choice = currentChoice();
  const view = choice.view || bestSource(eligibleViews(src.views));
  src.selected = view;
  if (!view) return;
  const label = sourceLabel(view).slice(0, 40);
  prep = { phase: 'ready', quality: label };
  // Un choix explicite de même libellé que la présélection est tout de même annoncé (l'hôte aligne les autres sur sa source).
  if (opts.defer) { declareSoon(); return; }
  if (src.declared === label) return;
  src.declared = label;
  c.sendReady(true, label);
  c.sendStatus('ready');
}

/** Sources choisies d'office : celles que le navigateur lit (comme player/session.js), sans les mémorisées en échec ; toute la liste si rien ne reste. */
function eligibleViews(views) {
  const req = roomRequest();
  const bad = req ? badSources(req.key + ':' + (req.season ?? '') + ':' + (req.episode ?? '')) : new Map();
  const good = views.filter((v) => !bad.has(badSourceKey(v)));
  const usable = good.length ? good : views;
  const ctx = webCompatContext();
  const compatible = ctx.web ? usable.filter((v) => webCompatOf(v, ctx).level === 'ok') : usable;
  return compatible.length ? compatible : views;
}

/** Choix courant : l'explicite du participant (même hors sources compatibles), sinon la présélection parmi les sources compatibles. */
function currentChoice() {
  const c = client;
  const explicit = src.explicit ? src.views.find((v) => sourceKeyOf(v) === src.explicit) : null;
  return chooseSource(explicit ? src.views : eligibleViews(src.views), { explicit, fingerprint: c.room.fingerprint, hostLabel: hostLabelOf(), roomLanguage: roomLang() });
}

/** Annonce au salon le dernier choix, 300 ms après la dernière sélection (une flèche enchaînée ne sature pas la limite de débit). */
function declareSoon() {
  clearTimeout(declareTimer);
  declareTimer = setTimeout(() => {
    declareTimer = 0;
    if (!client) return;
    applyChoice();
    if (isHost() && src.selected) partyBridge.announceSource(src.selected);
  }, DECLARE_DELAY_MS);
}

/** Choix explicite d'une source : il prime sur la présélection ; l'hôte l'annonce tout de suite pour que les autres s'alignent. */
function chooseSourceKey(id) {
  const key = rowKeys.get(id);
  const view = key ? src.views.find((v) => sourceKeyOf(v) === key) : null;
  if (!view || !client) return;
  src.explicit = key;
  applyChoice({ defer: true });
  renderSoon();
}

/** Cherche les sources du titre et rend la liste au fur et à mesure ; se déclare prêt dès qu'une source est retenue. */
async function prepare() {
  const run = ++prepRun;
  const c = client;
  if (!c || !c.room) return;
  const alive = () => run === prepRun && client === c && root;
  prep = { phase: 'searching', quality: '' };
  src = { ...freshSources(), explicit: src.explicit, order: src.order, searching: true };
  c.sendReady(false, null);
  c.sendStatus('searching');
  const req = roomRequest();
  if (!req) { src.searching = false; prep = { phase: 'none', quality: '' }; renderSoon(); return; }
  const take = (loaded) => { src.loaded = loaded; src.views = loaded.views; applyChoice(); renderSoon(); };
  try {
    let loaded = await loadSources(req);
    if (!alive()) return;
    take(loaded);
    for (let i = 0; i < SEARCH_POLL_MAX && loaded.pending.length && alive(); i++) {
      await new Promise((resolve) => setTimeout(resolve, SEARCH_POLL_MS));
      if (!alive()) return;
      loaded = await pollSources(req, loaded);
      if (!alive()) return;
      take(loaded);
    }
  } catch { /* recherche interrompue : la liste déjà reçue reste */ }
  if (!alive()) return;
  src.searching = false;
  if (!src.selected) prep = { phase: 'none', quality: '' };
  renderSoon();
}

function roomRequest() {
  const room = client && client.room;
  if (!room || room.media.tmdbId == null) return null;
  const type = room.media.type === 'series' ? 'tv' : 'movie';
  return { type, id: String(room.media.tmdbId), name: room.title, season: type === 'tv' ? room.media.season ?? 1 : null, episode: type === 'tv' ? room.media.episode ?? 1 : null, key: type + ':' + room.media.tmdbId };
}

// ---------- Départ ----------
function tickCountdown() {
  if (!root || !client) return;
  const left = countdownLeft(client.countdownAt, sNow());
  if (left === null) return;
  if (left <= 0) { launch(true); return; }
  renderSoon();
}

function syncCountdownTimer() {
  const counting = client && client.countdownAt !== null;
  if (counting) { countdownDue = client.countdownAt; countdownSeen = true; }
  if (counting && !countTimer) countTimer = setInterval(tickCountdown, 250);
  if (!counting && countTimer) { clearInterval(countTimer); countTimer = 0; }
}

/**
 * Fin du compte à rebours (ou salon déjà en lecture) : le salon d'attente se ferme et chacun lance sa lecture. `hold` : vrai après un
 * compte à rebours vu dans ce salon (la lecture attend les sources), faux à l'arrivée en cours de film.
 */
function launch(hold) {
  if (launched || !client) return;
  launched = true;
  clearTimeout(declareTimer);
  declareTimer = 0;
  // La source retenue est lancée telle quelle, sans seconde recherche ; sans liste, le départ cherche comme avant.
  let choice = src.selected && src.loaded ? { view: src.selected, loaded: src.loaded } : null;
  // Sans choix explicite et sans source dans la langue du salon alors que la recherche continue : la recherche reprend, avec son attente.
  if (choice && !src.explicit && (src.searching || src.loaded.pending.length) && currentChoice().motif === 'languageFallback') choice = null;
  closeLobby(true);
  togglePartyPanel(true);
  partyBridge.launchRoom(choice, { hold: !!hold }).catch((err) => {
    toast(err && err.code === 'media_unsupported' ? 'Ce salon ne peut pas être lu depuis cette application.' : 'Lancement de la lecture impossible.');
  });
}

// ---------- Liaison avec le salon ----------
function bind(c) {
  const on = (event, fn) => { offs.push(c.on(event, fn)); };
  on('welcome', () => {
    seedFeed();
    if (c.state && c.state.playing) { launch(false); return; }
    // Reconnexion : un choix existant est conservé et redéclaré, la recherche ne repart pas.
    if (src.selected && src.explicit) { src.declared = ''; applyChoice(); } else void prepare();
    syncCountdownTimer();
    renderSoon();
  });
  on('participants', () => { applyChoice(); renderSoon(); });
  on('source', () => { applyChoice(); renderSoon(); });
  on('settings', () => renderSoon());
  on('countdown', (at) => {
    if (at === null) {
      const due = countdownDue;
      countdownDue = null;
      // Le serveur envoie `countdown: null` à l'expiration, puis `state` en lecture : l'un ou l'autre peut manquer (alarme devancée par
      // le pas de 250 ms, participant qui arrive avant l'alarme). Échéance atteinte : le départ a lieu ; annulé avant : rien ne part.
      if ((c.state && c.state.playing) || (due !== null && sNow() >= due - COUNTDOWN_TOLERANCE_MS)) { launch(true); return; }
      countdownSeen = false;
    }
    syncCountdownTimer();
    if (at !== null) pushSys('Départ dans quelques secondes…');
    renderSoon();
  });
  on('state', (st) => { if (st && st.playing && c.countdownAt === null && c.status === 'open') launch(countdownSeen); });
  on('chat', (line) => { if (!feed.some((f) => f.kind === 'chat' && f.line.id === line.id)) feed.push({ kind: 'chat', line, at: line.at }); renderSoon(); });
  on('removed', ({ messageId }) => { feed = feed.filter((f) => !(f.kind === 'chat' && f.line.id === messageId)); renderSoon(); });
  on('event', (ev) => {
    if (ev.kind === 'join') {
      const who = c.participants.find((p) => p.username === ev.by);
      pushSys(ev.by + (who && who.guest ? ' a rejoint par le lien' : ' a rejoint le salon'));
    } else if (ev.kind === 'leave') pushSys(eventText(ev));
    renderSoon();
  });
  on('vote', (options) => {
    if (options) lastVoteOptions = options;
    if (!options) myVote = '';
    renderSoon();
  });
  on('media', ({ media }) => {
    // Vote clos : le salon change de titre. Le titre vient des options du vote ; la recherche de source repart.
    const won = lastVoteOptions.find((o) => o.tmdbId === media.tmdbId && (o.type === media.type));
    if (c.room && won) c.room = { ...c.room, title: won.title, poster: null };
    pushSys('Le titre est maintenant « ' + (won ? won.title : c.room ? c.room.title : '…') + ' »');
    src = freshSources(); // nouveau titre ou épisode : le choix de source ne vaut plus
    void prepare();
    renderSoon();
  });
  on('host', () => renderSoon());
  on('status', () => {
    // Connexion fermée ailleurs (lecteur fermé, autre salon rejoint) : le salon d'attente ne reste pas ouvert sur un salon quitté.
    if (c.status === 'closed' && partyBridge.client !== c) { closeLobby(true); return; }
    renderSoon();
  });
  on('error', (code) => { const t = partyErrorText(code); if (t) toast(t); });
  on('end', (reason) => {
    toast(endReasonText(reason));
    closeLobby(false);
  });
}

function unbind() {
  offs.forEach((off) => off());
  offs = [];
}

// ---------- Ouverture et fermeture ----------
const shellHTML = () =>
  '<div class="pl-main" data-pl-main></div>' +
  '<aside class="pl-side" aria-label="Discussion du salon">' +
  '<div role="tablist" class="pl-tabs" aria-label="Discussion et invitations">' +
  '<button type="button" role="tab" id="pl-tab-chat" data-pl-tab="chat" aria-selected="true" aria-controls="pl-panel">Discussion</button>' +
  '<button type="button" role="tab" id="pl-tab-friends" data-pl-tab="friends" aria-selected="false" aria-controls="pl-panel" tabindex="-1">Inviter des amis</button></div>' +
  '<div class="pl-feed" id="pl-panel" role="tabpanel" data-pl-feed tabindex="0" aria-live="polite"></div>' +
  '<div class="pl-emojis" data-pl-chatonly role="group" aria-label="Réactions rapides">' +
  LOBBY_EMOJIS.map((e) => '<button type="button" data-pl-emoji="' + e + '" aria-label="Envoyer ' + e + '">' + e + '</button>').join('') + '</div>' +
  '<form class="pl-send" data-pl-chatonly data-pl-send autocomplete="off"><label for="pl-input" class="sr-only">Message au salon</label>' +
  '<input id="pl-input" name="text" maxlength="' + CHAT_MAX_CHARS + '" placeholder="Écrire au salon…" autocomplete="off">' +
  '<button type="submit" class="pl-send-b" aria-label="Envoyer">' + ICON.send + '</button></form></aside>' +
  '<div class="pl-live sr-only" role="status" aria-live="polite" data-pl-live></div>';

function mount() {
  root = document.createElement('div');
  root.className = 'pl';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'pl-title');
  // Visible aussi par-dessus le lecteur ouvert en grand (invitation acceptée pendant une lecture).
  root.setAttribute('data-over-player', '');
  root.innerHTML = shellHTML();
  document.body.appendChild(root);
  releaseBack = pushLayer(onBack);
  document.body.classList.add('has-party-lobby');
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKey);
  socialOff = socialSubscribe(() => { if (tab === 'friends') paintSide(); });
}

/** Bouton retour (Android, navigateur) : quitte le salon d'attente, comme « Quitter », au lieu de changer la page du dessous. */
function onBack() {
  releaseBack = null;
  if (!root) return;
  if (isHost() && !window.confirm('Fermer le salon d’attente pour tout le monde ?')) { releaseBack = pushLayer(onBack); return; }
  const host = isHost();
  closeLobby(false);
  toast(host ? 'Salon fermé' : 'Tu as quitté le salon');
}

function closeLobby(keepClient) {
  if (releaseBack) { releaseBack(); releaseBack = null; }
  manualLink = '';
  clearTimeout(declareTimer);
  declareTimer = 0;
  clearInterval(countTimer);
  countTimer = 0;
  prepRun += 1;
  unbind();
  closePicker();
  if (socialOff) { socialOff(); socialOff = null; }
  if (root) { root.remove(); root = null; }
  document.body.classList.remove('has-party-lobby');
  partyBridge.lobby = false;
  if (!keepClient) { client = null; partyBridge.leave(); }
  else client = null;
  if (opener && opener.isConnected && !keepClient) opener.focus({ preventScroll: true });
  opener = null;
}

/** Une lecture d'un autre titre restée ouverte sous le salon d'attente est mise en pause (son son couvrirait le salon). */
function pauseOtherPlayback() {
  const a = partyBridge.adapter ? partyBridge.adapter() : null;
  try { if (a && a.ready && a.engine && !a.engine.state().paused) a.engine.pause(); } catch { /* moteur pas prêt */ }
}

/** Ouvre le salon d'attente d'une watch party (connexion au salon si besoin). Rien pour un profil enfant ou hors compte. */
export async function openLobby(partyId, from) {
  if (isKidProfile() || !isServerMode()) return;
  const seq = ++openSeq;
  if (root) closeLobby(true);
  launched = false;
  countdownDue = null;
  countdownSeen = false;
  tab = 'chat';
  myVote = '';
  lastVoteOptions = [];
  invitedPids.clear();
  rowIds.clear();
  rowKeys.clear();
  prep = { phase: 'idle', quality: '' };
  src = freshSources();
  opener = from instanceof HTMLElement ? from : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const current = partyBridge.client;
  let other = false;
  if (current && current.room && current.room.id === partyId && current.status !== 'closed') partyBridge.lobby = true;
  else {
    other = true;
    try {
      await partyBridge.connect(partyId, userStore.currentProfile().id, true);
    } catch (err) {
      if (seq !== openSeq) return;
      partyBridge.lobby = false;
      toast(err instanceof UserApiError && err.code === 'room_full' ? 'Le salon est complet.' : 'Impossible de rejoindre le salon.');
      return;
    }
  }
  // Une autre ouverture a pris la suite pendant l'attente (double activation) : elle seule monte le salon d'attente.
  if (seq !== openSeq) return;
  client = partyBridge.client;
  if (!client) { partyBridge.lobby = false; return; }
  mount();
  // Lecture d'un autre titre restée ouverte dessous (elle n'appartient plus à aucun salon) : en pause.
  if (other) pauseOtherPlayback();
  bind(client);
  // Une connexion déjà ouverte a reçu sa bienvenue : le salon d'attente démarre sans la réécouter.
  if (client.you) {
    seedFeed();
    if (client.state && client.state.playing && client.countdownAt === null) { launch(false); return; }
    void prepare();
    syncCountdownTimer();
  }
  render();
  const title = root.querySelector('#pl-title');
  if (title) title.focus({ preventScroll: true });
}

// ---------- Création depuis une fiche ----------
/**
 * Crée le salon d'attente d'un titre (hôte) puis l'ouvre. `req` : cible de lecture (type, id, name, season, episode) ;
 * `invite` : amis (pid) à inviter tout de suite. Un échec donne un message humain ; profil verrouillé : saisie du PIN puis nouvel essai.
 */
export async function createLobbyFor(req, poster, visibility, from, invite = []) {
  try {
    const room = await partyBridge.createLobby(req, poster || null, visibility);
    await openLobby(room.id, from);
    if (invite.length && (await partyBridge.waitForHost())) await inviteMany(room.id, invite);
  } catch (err) {
    void handlePartyCreateError(err, { retry: () => { void createLobbyFor(req, poster, visibility, from, invite); } });
  }
}

/** Invite plusieurs amis dans un salon dont on est membre ; un seul message récapitulatif. */
export async function inviteMany(roomId, pids) {
  if (!pids || !pids.length) return;
  const done = await Promise.all(pids.map((pid) => inviteInto(roomId, pid)));
  const n = done.filter(Boolean).length;
  if (n) toast(n === 1 ? 'Invitation envoyée' : n + ' invitations envoyées');
}

// ---------- Invitation d'un ami ----------
/** Création de salon lancée par `inviteToParty`, tant qu'elle n'a pas abouti. */
let creating = null;
/** Point d'entrée partagé : invite `pid` dans ma watch party active, ou en crée une sur le titre en cours de lecture. */
export async function inviteToParty(pid) {
  if (isKidProfile() || !isServerMode()) return;
  // Une création de salon est en cours (plusieurs amis choisis, double clic) : on l'attend au lieu d'en créer un second.
  if (creating) await creating.catch(() => undefined);
  let c = partyBridge.client;
  if (!(c && c.room && partyBridge.isActive())) {
    const a = partyBridge.adapter ? partyBridge.adapter() : null;
    if (!partyBridge.available()) {
      toast('Connecte-toi à ton compte Laststream pour lancer une watch party.');
      return;
    }
    if (!a || !a.ready) {
      openPartyCreate(pid, createLobbyFor);
      return;
    }
    const run = (async () => {
      await partyBridge.create(a, 'private');
      return partyBridge.waitForHost();
    })();
    creating = run;
    let ready;
    try {
      ready = await run;
    } catch (err) {
      void handlePartyCreateError(err, { retry: () => { void inviteToParty(pid); } });
      return;
    } finally {
      if (creating === run) creating = null;
    }
    if (!ready) { toast('Salon créé, mais la connexion a échoué.'); return; }
    c = partyBridge.client;
  }
  if (!c || !c.room) return;
  if (await inviteInto(c.room.id, pid)) toast('Invitation envoyée');
}

// ---------- Vote du titre (sélecteur de l'hôte) ----------
function openPicker() {
  if (!root || picker || !isHost()) return;
  const room = client.room;
  const first = room && room.media.tmdbId != null ? [{ type: room.media.type, tmdbId: room.media.tmdbId, title: room.title }] : [];
  picker = { options: first, results: [], query: '', busy: false, seq: 0 };
  const el = document.createElement('div');
  el.className = 'pl-pick';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'pl-pick-t');
  el.innerHTML = '<div class="pl-pick-box"><h2 id="pl-pick-t">Changer de titre</h2>' +
    '<p class="pl-note">Choisis 2 à ' + VOTE_MAX_OPTIONS + ' titres : le salon vote, le plus voté est lu.</p>' +
    '<form data-pl-pick-form role="search"><label for="pl-pick-q" class="sr-only">Chercher un film ou une série</label>' +
    '<input id="pl-pick-q" type="search" placeholder="Chercher un film ou une série…" autocomplete="off"><button type="submit" class="pl-btn is-sec">Chercher</button></form>' +
    '<ul class="pl-pick-res" data-pl-pick-res aria-label="Résultats"></ul>' +
    '<div class="pl-lb">Options du vote</div><ul class="pl-pick-sel" data-pl-pick-sel></ul>' +
    '<div class="pl-pick-act"><button type="button" class="pl-btn is-sec" data-pl-pick-cancel>Annuler</button>' +
    '<button type="button" class="pl-btn is-pri" data-pl-pick-go>Lancer le vote</button></div></div>';
  root.appendChild(el);
  picker.el = el;
  paintPicker();
  el.querySelector('#pl-pick-q').focus();
}

function closePicker() {
  if (!picker) return;
  picker.el.remove();
  picker = null;
  const b = root && root.querySelector('[data-pl-change]');
  if (b) b.focus({ preventScroll: true });
}

function paintPicker() {
  if (!picker) return;
  const res = picker.el.querySelector('[data-pl-pick-res]');
  res.innerHTML = picker.results.length
    ? picker.results.map((r, i) => '<li><button type="button" class="pl-pick-r" data-pl-pick-add="' + i + '"' + (picker.options.length >= VOTE_MAX_OPTIONS ? ' disabled' : '') + '>' +
      '<span>' + esc(r.title) + '</span><span class="pl-tag">' + (r.type === 'series' ? 'Série' : 'Film') + (r.year ? ' · ' + esc(r.year) : '') + '</span></button></li>').join('')
    : '<li class="pl-empty">' + (picker.busy ? 'Recherche…' : picker.query ? 'Aucun résultat.' : '') + '</li>';
  picker.el.querySelector('[data-pl-pick-sel]').innerHTML = picker.options.map((o, i) =>
    '<li><span>' + esc(o.title) + '</span><button type="button" class="pl-mini" data-pl-pick-del="' + i + '" aria-label="Retirer ' + esc(o.title) + '">Retirer</button></li>').join('');
  picker.el.querySelector('[data-pl-pick-go]').disabled = picker.options.length < 2;
}

async function pickerSearch(query) {
  if (!picker) return;
  const q = query.trim();
  picker.query = q;
  const seq = ++picker.seq;
  if (!q) { picker.results = []; paintPicker(); return; }
  picker.busy = true;
  paintPicker();
  let rows = [];
  try {
    const out = await tmdb('search/multi', { query: q, page: 1 });
    rows = Array.isArray(out && out.results) ? out.results : [];
  } catch { rows = []; }
  if (!picker || seq !== picker.seq) return;
  picker.busy = false;
  picker.results = rows.filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && Number.isInteger(r.id) && (r.title || r.name)).slice(0, 8).map((r) => ({
    type: r.media_type === 'tv' ? 'series' : 'movie', tmdbId: r.id, title: String(r.title || r.name), year: String(r.release_date || r.first_air_date || '').slice(0, 4),
  }));
  paintPicker();
}

// ---------- Événements ----------
async function copyInvite() {
  if (linkBusy || !isHost()) return;
  linkBusy = true;
  try {
    const inv = await partyBridge.createInvite(false);
    const url = joinLinkOf(shareBase(), inv.roomId, inv.token);
    if (await copyToClipboard(url)) {
      manualLink = '';
      linkCopied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { linkCopied = false; renderSoon(); }, 2000);
      toast('Lien d’invitation copié');
    } else {
      // Le lien reste affiché dans un champ sélectionnable : un toast ne se copie pas.
      manualLink = url;
      toast('Copie automatique impossible : le lien est affiché, copie-le à la main.', { ms: 6000 });
    }
  } catch {
    toast('Invitation impossible pour le moment.');
  }
  linkBusy = false;
  renderSoon();
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !client) return;
  if (t.closest('[data-pl-leave]')) {
    if (isHost() ? window.confirm('Fermer le salon d’attente pour tout le monde ?') : true) {
      const host = isHost();
      closeLobby(false);
      if (host) toast('Salon fermé'); else toast('Tu as quitté le salon');
    }
    return;
  }
  const tabBtn = t.closest('[data-pl-tab]');
  if (tabBtn) { tab = tabBtn.dataset.plTab; paintSide(); return; }
  if (t.closest('[data-pl-invite-tile]')) { tab = 'friends'; paintSide(); const b = root.querySelector('#pl-tab-friends'); if (b) b.focus(); return; }
  if (t.closest('[data-pl-copy]')) { void copyInvite(); return; }
  const source = t.closest('[data-pl-source]');
  if (source) { chooseSourceKey(source.dataset.key); return; }
  if (t.closest('[data-pl-retry]')) { void prepare(); renderSoon(); return; }
  if (t.closest('[data-pl-start]')) { client.startPlayback(COUNTDOWN_DEFAULT_SEC); return; }
  if (t.closest('[data-pl-start-now]')) { client.startPlayback(1); return; }
  if (t.closest('[data-pl-change]')) { openPicker(); return; }
  const set = t.closest('[data-pl-set]');
  if (set && isHost()) { client.sendSettings({ [set.dataset.plSet]: set.dataset.value }); return; }
  const emoji = t.closest('[data-pl-emoji]');
  if (emoji) { client.sendReact(emoji.dataset.plEmoji, partyBridge.position()); return; }
  const vote = t.closest('[data-pl-vote]');
  if (vote) { myVote = vote.dataset.plVote; client.castVote(myVote); renderSoon(); return; }
  if (t.closest('[data-pl-vote-close]')) { client.closeVote(); return; }
  const friend = t.closest('[data-pl-friend]');
  if (friend) {
    const pid = friend.dataset.plFriend;
    friend.disabled = true;
    void inviteInto(client.room.id, pid).then(() => paintSide());
    return;
  }
  const kick = t.closest('[data-pl-kick]');
  if (kick) { if (window.confirm('Exclure ' + kick.dataset.plKick + ' du salon ?')) client.kick(kick.dataset.plKick); return; }
  const host = t.closest('[data-pl-host]');
  if (host) { if (window.confirm('Céder le rôle d’hôte à ' + host.dataset.plHost + ' ?')) client.transfer(host.dataset.plHost); return; }
  // Sélecteur de titre
  if (t.closest('[data-pl-pick-cancel]')) { closePicker(); return; }
  const add = t.closest('[data-pl-pick-add]');
  if (add && picker) {
    const r = picker.results[Number(add.dataset.plPickAdd)];
    if (r && picker.options.length < VOTE_MAX_OPTIONS && !picker.options.some((o) => o.tmdbId === r.tmdbId && o.type === r.type)) picker.options.push({ type: r.type, tmdbId: r.tmdbId, title: r.title });
    paintPicker();
    return;
  }
  const del = t.closest('[data-pl-pick-del]');
  if (del && picker) { picker.options.splice(Number(del.dataset.plPickDel), 1); paintPicker(); return; }
  if (t.closest('[data-pl-pick-go]') && picker) {
    const options = picker.options.map((o) => ({ type: o.type, tmdbId: o.tmdbId, title: o.title }));
    if (options.length >= 2 && client.openVote(options)) { closePicker(); tab = 'chat'; paintSide(); }
  }
}

function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !client) return;
  e.preventDefault();
  if (f.matches('[data-pl-send]')) {
    const input = f.elements.text;
    if (client.sendChat(input.value, partyBridge.position())) input.value = '';
    return;
  }
  if (f.matches('[data-pl-pick-form]')) void pickerSearch(f.querySelector('input').value);
}

/** Flèches dans un groupe de boutons radio (réglages) ou d'onglets ; Échap ferme le sélecteur de titre. */
function onKey(e) {
  // Les raccourcis de la page et du lecteur restés dessous (retour, navigation aux flèches, lecture) ne s'appliquent pas ici.
  e.stopPropagation();
  if (e.key === 'Escape' && picker) { closePicker(); return; }
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (!vertical && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target instanceof Element ? e.target : null;
  const group = t && t.closest('[role="radiogroup"], [role="tablist"]');
  if (!group || !t || (vertical && group.getAttribute('role') !== 'radiogroup')) return;
  // Touche maintenue : une seule sélection (chaque flèche clique la ligne et peut envoyer des messages au salon).
  if (e.repeat) { e.preventDefault(); return; }
  const items = [...group.querySelectorAll('[role="radio"]:not(:disabled), [role="tab"]')];
  const i = items.indexOf(t);
  if (i < 0) return;
  e.preventDefault();
  const next = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
  next.focus();
  next.click();
}

// ---------- Invitations reçues ----------
let inviteOff = null;
function listenInvites() {
  if (inviteOff) return;
  inviteOff = onPartyInvite((ev) => {
    if (isKidProfile()) return;
    toast(ev.from.handle.full + ' t’invite à rejoindre « ' + ev.title + ' »', { ms: 9000, action: { label: 'Rejoindre', run: () => { void openLobby(ev.partyId); } } });
  });
}

registerSocialHook('inviteToParty', (pid) => { void inviteToParty(pid); });
registerSocialHook('openPartyLobby', (partyId) => { void openLobby(partyId); });
listenInvites();

// Changement de profil (adulte vers adulte compris) : le salon d'attente du profil quitté est fermé et sa connexion coupée.
let lobbyPid = auth.profile ? auth.profile.id : '';
onAuthChange(() => {
  const pid = auth.profile ? auth.profile.id : '';
  if (pid === lobbyPid) return;
  lobbyPid = pid;
  if (root || partyBridge.client) closeLobby(false);
});

/** Pour les tests : état interne du salon d'attente. */
export const isLobbyOpen = () => root !== null;
