/* Barre latérale des amis (Social v2, docs/social-v2-contract.md, section UI) : panneau fixe à droite (320 px), tiroir plein
 * écran sous 768 px. Trois vues : « list » (en-tête, ajout d’ami, inviter, groupes), « friend » (fiche d’un ami) et
 * « conversation » (point d’extension : setConversationRenderer, la discussion arrive au lot suivant). Les données viennent
 * du store (socialStore) : ce module affiche et lance les actions. Tout texte venant du serveur ou de l’utilisateur passe
 * par esc() ou par textContent. Hooks pour les lots suivants : setWatchWithHandler, setConversationRenderer. */
import { auth, onAuthChange } from '../data/auth';
import * as store from '../data/socialStore';
import { getFriendHistory, getFriendLibrary, validateHandle } from '../data/socialV2Api';
import { posterPathOf, posterUrlOf } from '../data/serverUserStore';
import { UserApiError } from '../data/userApi';
import { userStore } from '../data/userStore';
import { partyBridge } from '../party/bridge';
import { joinLinkOf } from '../party/join';
import { register, toItem } from './catalog.js';
import { toast } from './dom.js';
import { ICON } from './icons.js';
import { copyInvite, linkOf, refreshInvites, shareBase, shareInvite, usableInvite } from './invites.js';
import { openPartyDialog } from './partylaunch.js';
import { copyLink } from './partypanel.js';
import { paintSocialBadges, socialAvailable } from './socialButton.js';
import { playDirect } from './sources-ui.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

const STATUS_OPTIONS = [['online', 'En ligne'], ['away', 'Absent'], ['dnd', 'Ne pas déranger'], ['invisible', 'Invisible']];
const SEEN_LABEL = { online: 'En ligne', away: 'Absent', dnd: 'Ne pas déranger', offline: 'Hors ligne' };
/** Ordre d’affichage des groupes ; chaque personne n’est que dans un groupe. */
const GROUPS = [['requests', 'Demandes'], ['watching', 'En train de regarder'], ['online', 'En ligne'], ['account', 'Profils du compte'], ['offline', 'Hors ligne']];
const ADD_ERRORS = {
  invalid_handle: 'Pseudo invalide : écris Nom#TAG (2 à 20 caractères, puis # et 4 caractères).',
  handle_not_found: 'Aucun profil avec ce pseudo exact.',
  already_friends: 'Vous êtes déjà amis.',
  already_requested: 'Une demande est déjà en attente.',
  self: 'Tu ne peux pas t’ajouter toi-même.',
  friend_limit_reached: 'Limite d’amis atteinte.',
  rate_limited: 'Trop de tentatives, réessaie dans un instant.',
};

// ---------- Textes, formats et sécurité d’affichage ----------

/** Message lisible d’une erreur de l’API sociale v2 (les codes inconnus restent visibles pour le diagnostic). */
export function socialErrorMessage(err) {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  if (err.status === 0 || err.code === 'network') return 'Serveur injoignable pour le moment.';
  return ADD_ERRORS[err.code] || 'Erreur (' + err.code + ').';
}

const pad = (n) => String(n).padStart(2, '0');

/** « S01E03 » pour une série avec saison et épisode ; chaîne vide sinon. */
export function episodeCode(w) {
  return w && w.type === 'series' && w.season != null && w.episode != null ? 'S' + pad(w.season) + 'E' + pad(w.episode) : '';
}

/** Durée d’une position en secondes : « 34:12 », ou « 1:02:03 » à partir d’une heure. */
export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

/** Position estimée à `now` : le relevé vieillit tant que la lecture n’est pas en pause (plafonnée à la durée). */
export function livePos(w, now = Date.now()) {
  const base = Number(w.pos) || 0;
  if (w.paused) return base;
  const p = base + Math.max(0, now - (w.at || now)) / 1000;
  return w.duration ? Math.min(p, Number(w.duration)) : p;
}

/** « S01E03 · 34:12 » (ou « 1:02:03 » pour un film), suffixe « en pause » si la lecture est arrêtée. */
export function watchLine(w) {
  return [episodeCode(w), clock(livePos(w)), w.paused ? 'en pause' : ''].filter(Boolean).join(' · ');
}

/** Couleur d’avatar : seulement une couleur hexadécimale, sinon une couleur neutre (aucun texte serveur dans le style). */
const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');
const nameOf = (p) => (p && p.handle && p.handle.full) || '?';
const initialOf = (p) => (Array.from((p && p.handle && p.handle.name) || '?')[0] || '?').toUpperCase();
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'fr');

/** Affiche d’une source : URL https telle quelle, chemin TMDB converti ; sinon rien. */
function posterSrc(p) {
  if (typeof p !== 'string') return '';
  if (/^https:\/\//.test(p)) return p;
  return p.startsWith('/') ? posterUrlOf(p) || '' : '';
}

/** Chemin d’affiche attendu par les tuiles, depuis une URL TMDB ou un chemin. */
const pathOf = (p) => (p ? posterPathOf(p) || (p.startsWith('/') ? p : '') : '');

const avatarHTML = (p, cls = 'ss-av') =>
  '<span class="' + cls + '" style="background:' + colorOf(p.avatarColor) + '" aria-hidden="true">' + esc(initialOf(p)) + '</span>';

// ---------- Machine d’états et hooks ----------

let root = null;
let mounted = false;
/** Vue courante : { name: 'list' } | { name: 'friend', pid } | { name: 'conversation', pid }. */
let view = { name: 'list' };
let lastOpener = null;
let watchHandler = null;
let conversationRenderer = null;
/** Groupes repliés ; « Hors ligne » l’est par défaut. */
const collapsed = new Set(['offline']);
let loadError = false;
let extrasSeq = 0;
let started = false;
let startedPid = null;

/** Hook du lot « Regarder avec lui » : appelé avec la fiche de l’ami (FriendView) quand il regarde un titre. */
export function setWatchWithHandler(fn) {
  watchHandler = typeof fn === 'function' ? fn : null;
}

/** Hook du lot « Discussion » : `fn({ el, pid, friend })` remplit `el` ; `null` remet le texte provisoire. */
export function setConversationRenderer(fn) {
  conversationRenderer = typeof fn === 'function' ? fn : null;
}

const $ = (sel) => (root ? root.querySelector(sel) : null);
export const isSidebarOpen = () => !!root && !root.hidden;
const findFriend = (pid, s = store.getState()) =>
  s.friends.find((f) => f.pid === pid) || s.household.find((f) => f.pid === pid) || null;

/** Exécute une action du store : toast du résultat, ou du message d’erreur. */
async function run(fn, ok) {
  try {
    const r = await Promise.resolve().then(fn);
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
    return r;
  } catch (err) {
    toast(socialErrorMessage(err));
    return undefined;
  }
}

async function copyText(text, ok) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(ok);
      return true;
    }
  } catch { /* repli ci-dessous */ }
  toast('Copie impossible : sélectionne le texte et copie-le');
  return false;
}

function focusTitle() {
  const t = $('#ss-title');
  if (t) t.focus({ preventScroll: true });
}

/** Clé de focus (data-fk) de l’élément actif dans `box`, pour le retrouver après un nouvel affichage. */
function focusKeyIn(box) {
  const a = document.activeElement;
  return a && box.contains(a) ? a.getAttribute('data-fk') : null;
}

function restoreFocusIn(box, key) {
  if (!key) return;
  const el = Array.from(box.querySelectorAll('[data-fk]')).find((x) => x.getAttribute('data-fk') === key);
  if (el) el.focus({ preventScroll: true });
}

function syncOpeners(open) {
  document.querySelectorAll('[data-soc-open]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
}

// ---------- Rendu : en-tête, ajout, invitation, groupes ----------

function shellHTML() {
  return '<div class="ss-bar">' +
    '<button type="button" class="ss-ibtn" id="ss-back" data-ss-act="back" aria-label="Retour à la liste des amis" hidden>' + ICON.back + '</button>' +
    '<h2 class="ss-title" id="ss-title" tabindex="-1">Amis</h2>' +
    '<button type="button" class="ss-ibtn" data-ss-act="close" aria-label="Fermer la liste des amis">' + ICON.close + '</button>' +
    '</div>' +
    '<div class="ss-body">' +
    '<div id="ss-home">' +
    '<section class="ss-me" aria-label="Mon profil">' +
    '<span class="ss-av ss-av-l" id="ss-me-av" aria-hidden="true">?</span>' +
    '<div class="ss-me-id">' +
    '<button type="button" class="ss-handle" id="ss-me-handle" data-ss-act="copy-handle" title="Copier mon Nom#TAG">…</button>' +
    '<label class="ss-label" for="ss-status">Mon statut</label>' +
    '<select class="ss-select" id="ss-status" data-ss-status>' +
    STATUS_OPTIONS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') +
    '</select></div></section>' +
    '<form class="ss-sec" id="ss-add" autocomplete="off">' +
    '<label class="ss-label" for="ss-add-in">Ajouter un ami (Nom#TAG)</label>' +
    '<div class="ss-add-row"><input class="ss-input" id="ss-add-in" name="handle" type="text" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="Pseudo#ABCD">' +
    '<button type="submit" class="ss-btn ss-btn-primary">Envoyer</button></div>' +
    '<p class="ss-msg" id="ss-add-msg" role="status" aria-live="polite"></p></form>' +
    '<section class="ss-sec ss-invite" aria-labelledby="ss-inv-t"><h3 class="ss-sec-t" id="ss-inv-t">Inviter quelqu’un</h3>' +
    '<p class="ss-hint">Chaque lien ne sert qu’une fois : ton filleul devient automatiquement ton ami.</p>' +
    '<div id="ss-inv-slot"></div></section>' +
    '<div id="ss-groups"></div>' +
    '</div>' +
    '<div id="ss-friend" hidden><div id="ss-friend-head"></div>' +
    '<section class="ss-sec"><h3 class="ss-sec-t">Bibliothèque</h3><div id="ss-lib"></div></section>' +
    '<section class="ss-sec"><h3 class="ss-sec-t">Récemment regardé</h3><div id="ss-hist"></div></section></div>' +
    '<div id="ss-conv" hidden></div>' +
    '</div>';
}

/** Ligne d’un ami (groupes) : bouton qui ouvre sa fiche. */
function friendRowHTML(f) {
  const pid = esc(f.pid);
  const w = f.watching;
  const poster = w ? posterSrc(w.poster) : '';
  const lead = poster ? '<img class="ss-thumb" src="' + esc(poster) + '" alt="" loading="lazy">' : avatarHTML(f);
  const meta = w
    ? '<span class="ss-sub">' + esc(w.title) + '</span><span class="ss-sub ss-clock">' + esc(watchLine(w)) + '</span>'
    : '<span class="ss-sub"><i class="ss-dot is-' + esc(f.status) + '" aria-hidden="true"></i>' + esc(SEEN_LABEL[f.status] || '') + '</span>';
  return '<li class="ss-item"><button type="button" class="ss-row" data-ss-act="open" data-pid="' + pid + '" data-fk="open:' + pid + '">' +
    lead + '<span class="ss-row-t"><span class="ss-name">' + esc(nameOf(f)) + '</span>' + meta + '</span></button></li>';
}

/** Demande reçue (accepter, refuser) ou envoyée (annuler). */
function requestRowHTML(r, incoming) {
  const pid = esc(r.pid);
  const acts = incoming
    ? '<button type="button" class="ss-btn ss-btn-primary" data-ss-act="accept" data-pid="' + pid + '" data-fk="accept:' + pid + '">Accepter</button>' +
      '<button type="button" class="ss-btn" data-ss-act="decline" data-kind="in" data-pid="' + pid + '" data-fk="decline-in:' + pid + '">Refuser</button>'
    : '<button type="button" class="ss-btn" data-ss-act="decline" data-kind="out" data-pid="' + pid + '" data-fk="decline-out:' + pid + '">Annuler</button>';
  return '<li class="ss-item ss-req"><div class="ss-row ss-row-static">' + avatarHTML(r) +
    '<span class="ss-row-t"><span class="ss-name">' + esc(nameOf(r)) + '</span>' +
    '<span class="ss-sub">' + (incoming ? 'veut devenir ton ami' : 'demande envoyée') + '</span></span></div>' +
    '<div class="ss-acts">' + acts + '</div></li>';
}

function groupHTML(id, title, items) {
  const folded = collapsed.has(id);
  return '<section class="ss-group" data-group="' + id + '">' +
    '<h3 class="ss-group-h"><button type="button" class="ss-fold" data-ss-act="fold" data-gid="' + id + '" data-fk="fold:' + id + '"' +
    ' aria-expanded="' + (folded ? 'false' : 'true') + '" aria-controls="ss-g-' + id + '">' +
    '<span class="ss-chev" aria-hidden="true">' + ICON.chev + '</span><span class="ss-group-t">' + esc(title) + '</span>' +
    '<em class="ss-count">' + items.length + '</em></button></h3>' +
    '<ul class="ss-list" id="ss-g-' + id + '"' + (folded ? ' hidden' : '') + '>' + items.join('') + '</ul></section>';
}

/** Groupes de la liste : demandes, en train de regarder, en ligne, profils du compte, hors ligne. */
export function groupsHTML(s) {
  const rows = { requests: [], watching: [], online: [], account: [], offline: [] };
  s.incoming.forEach((r) => rows.requests.push(requestRowHTML(r, true)));
  s.outgoing.forEach((r) => rows.requests.push(requestRowHTML(r, false)));
  [...s.friends, ...s.household].sort(byName).forEach((f) => {
    const g = f.watching ? 'watching' : f.household ? 'account' : f.status === 'offline' ? 'offline' : 'online';
    rows[g].push(friendRowHTML(f));
  });
  const any = s.friends.length || s.household.length || s.incoming.length || s.outgoing.length;
  if (!any) return '<p class="ss-empty">Pas encore d’ami. Ajoute quelqu’un avec son Nom#TAG, ou invite-le ci-dessous.</p>';
  return GROUPS.filter(([id]) => rows[id].length).map(([id, title]) => groupHTML(id, title, rows[id])).join('');
}

function paintMe(s) {
  const av = $('#ss-me-av');
  if (av) {
    av.setAttribute('style', 'background:' + colorOf(s.me && s.me.avatarColor));
    av.textContent = s.me ? initialOf(s.me) : '?';
  }
  const h = $('#ss-me-handle');
  if (h) h.textContent = s.me ? nameOf(s.me) : '…';
  const sel = $('#ss-status');
  if (sel && document.activeElement !== sel && s.status) sel.value = s.status;
}

function paintGroups(s) {
  const box = $('#ss-groups');
  if (!box) return;
  const keep = focusKeyIn(box);
  if (!s.me && loadError) {
    box.innerHTML = '<p class="ss-empty" role="alert">Amis indisponibles : le serveur ne répond pas. ' +
      '<button type="button" class="ss-link" data-ss-act="reload">Réessayer</button></p>';
    return;
  }
  if (!s.me) {
    box.innerHTML = '<p class="ss-empty" role="status">Chargement…</p>';
    return;
  }
  box.innerHTML = groupsHTML(s);
  restoreFocusIn(box, keep);
}

function friendHeadHTML(f) {
  const pid = esc(f.pid);
  const w = f.watching;
  const meta = w ? esc(w.title) + ' · ' + esc(watchLine(w)) : esc(SEEN_LABEL[f.status] || '');
  return '<div class="ss-card-top">' + avatarHTML(f, 'ss-av ss-av-l') +
    '<div class="ss-card-id"><p class="ss-card-name">' + esc(nameOf(f)) + '</p>' +
    '<p class="ss-sub">' + meta + '</p>' + (f.household ? '<p class="ss-sub">Profil de ce compte</p>' : '') + '</div></div>' +
    '<div class="ss-acts ss-acts-main">' +
    '<button type="button" class="ss-btn ss-btn-primary" data-ss-act="message" data-pid="' + pid + '" data-fk="message:' + pid + '">Message</button>' +
    (w ? '<button type="button" class="ss-btn" data-ss-act="watch" data-pid="' + pid + '" data-fk="watch:' + pid + '">Regarder avec lui</button>' : '') +
    '<button type="button" class="ss-btn" data-ss-act="party" data-pid="' + pid + '" data-fk="party:' + pid + '">Inviter au salon</button>' +
    (f.household ? '' : '<button type="button" class="ss-btn ss-btn-danger" data-ss-act="remove" data-pid="' + pid + '" data-fk="remove:' + pid + '">Retirer</button>') +
    '</div>';
}

function paintFriendHead(s) {
  const box = $('#ss-friend-head');
  const f = findFriend(view.pid, s);
  if (!box || !f) return;
  const keep = focusKeyIn(box);
  box.innerHTML = friendHeadHTML(f);
  restoreFocusIn(box, keep);
}

function paintInvite(inv) {
  const box = $('#ss-inv-slot');
  if (!box) return;
  if (inv === 'error') {
    box.innerHTML = '<p class="ss-hint" role="alert">Invitations indisponibles. <button type="button" class="ss-link" data-ss-act="inv-reload">Réessayer</button></p>';
    return;
  }
  if (!inv) {
    box.innerHTML = '<p class="ss-hint" role="status">Aucun lien disponible pour le moment.</p>';
    return;
  }
  const id = esc(inv.id);
  box.innerHTML = '<input class="ss-input ss-link-in" type="text" readonly value="' + esc(linkOf(inv)) + '" aria-label="Lien d’invitation">' +
    '<div class="ss-acts"><button type="button" class="ss-btn ss-btn-primary" data-ss-act="copy-invite" data-id="' + id + '" data-fk="copy-invite:' + id + '">Copier le lien</button>' +
    '<button type="button" class="ss-btn" data-ss-act="share-invite" data-id="' + id + '" data-fk="share-invite:' + id + '">Partager</button></div>';
}

/** Charge le bloc « Inviter quelqu’un » (liens de parrainage du compte, via invites.js). */
async function loadInvite() {
  const slot = $('#ss-inv-slot');
  if (!slot) return;
  slot.innerHTML = '<p class="ss-hint" role="status">Chargement…</p>';
  let d;
  try {
    d = await refreshInvites();
  } catch {
    d = 'error';
  }
  paintInvite(d === 'error' ? 'error' : usableInvite());
}

// ---------- Fiche ami : bibliothèque et historique ----------

/** Fiche d’une tuile de bibliothèque (même forme qu’un titre du catalogue, enregistré dans state.byKey). */
function itemOf(x) {
  const type = x.type === 'series' ? 'tv' : 'movie';
  const raw = { id: x.tmdbId, poster_path: pathOf(x.poster) };
  raw[type === 'tv' ? 'name' : 'title'] = x.title;
  return register(toItem(raw, type));
}

function libTileHTML(x) {
  const it = itemOf(x);
  const k = esc(it.key);
  const have = userStore.inLibrary(it.key);
  return '<div class="ss-tile">' + posterCard(it) +
    '<div class="ss-tile-acts"><button type="button" class="ss-btn ss-btn-sm" data-ss-act="lib-play" data-key="' + k + '" data-fk="lib-play:' + k + '">Lire</button>' +
    '<button type="button" class="ss-btn ss-btn-sm" data-ss-act="lib-save" data-key="' + k + '" data-fk="lib-save:' + k + '"' + (have ? ' disabled' : '') +
    ' aria-label="' + (have ? 'Déjà dans ma bibliothèque' : 'Ajouter à ma bibliothèque') + '">' + (have ? 'Ajouté' : 'Ajouter') + '</button></div></div>';
}

function paintLib(status, items = []) {
  const box = $('#ss-lib');
  if (!box) return;
  if (status === 'loading') {
    box.innerHTML = '<p class="ss-empty" role="status">Chargement…</p>';
    return;
  }
  if (status === 'error') {
    box.innerHTML = '<p class="ss-empty" role="alert">Bibliothèque indisponible. <button type="button" class="ss-link" data-ss-act="lib-retry">Réessayer</button></p>';
    return;
  }
  const shown = items.filter((x) => x.tmdbId != null);
  if (!shown.length) {
    const f = findFriend(view.pid);
    box.innerHTML = '<p class="ss-empty">' + esc(f ? nameOf(f) : 'Cet ami') + ' n’a rien partagé pour l’instant.</p>';
    return;
  }
  box.innerHTML = '<div class="ss-lib-grid">' + shown.map(libTileHTML).join('') + '</div>';
  observeTiles(box);
}

function histHTML(items) {
  if (!items.length) return '<p class="ss-empty">Rien de récent.</p>';
  return '<ul class="ss-list ss-hist">' + items.map((h) => {
    const meta = [episodeCode(h), h.watched ? 'Vu' : clock(h.pos)].filter(Boolean).join(' · ');
    return '<li class="ss-hrow"><span class="ss-name">' + esc(h.title || 'Sans titre') + '</span><span class="ss-sub">' + esc(meta) + '</span></li>';
  }).join('') + '</ul>';
}

function paintHist(status, items = []) {
  const box = $('#ss-hist');
  if (!box) return;
  if (status === 'loading') box.innerHTML = '<p class="ss-empty" role="status">Chargement…</p>';
  else if (status === 'error') box.innerHTML = '<p class="ss-empty" role="alert">Historique indisponible. <button type="button" class="ss-link" data-ss-act="lib-retry">Réessayer</button></p>';
  else box.innerHTML = histHTML(items);
}

/** Charge bibliothèque et historique de l’ami affiché ; une réponse périmée (autre ami, fiche fermée) est ignorée. */
function loadFriendExtras(pid) {
  const seq = ++extrasSeq;
  paintLib('loading');
  paintHist('loading');
  Promise.resolve().then(() => getFriendLibrary(pid)).then(
    (res) => { if (seq === extrasSeq) paintLib('ok', (res && res.items) || []); },
    () => { if (seq === extrasSeq) paintLib('error'); },
  );
  Promise.resolve().then(() => getFriendHistory(pid, 20)).then(
    (res) => { if (seq === extrasSeq) paintHist('ok', (res && res.items) || []); },
    () => { if (seq === extrasSeq) paintHist('error'); },
  );
}

/** Cible de lecture directe : un film, ou l’épisode en cours / le premier d’une série (comme la page amis d’origine). */
function requestOf(key) {
  const it = state.byKey.get(key);
  if (!it) return null;
  let season = null;
  let episode = null;
  if (it.type === 'tv') {
    const cont = userStore.continueWatching().find((e) => e.type === 'tv' && e.id === it.id && e.season != null);
    season = cont ? cont.season : 1;
    episode = cont ? cont.episode : 1;
  }
  return { type: it.type, id: String(it.id), name: it.name, season, episode, key };
}

// ---------- Vues ----------

/** Affiche la vue courante (titres, bascule des zones, en-tête de la fiche). */
function paintView() {
  if (!root) return;
  const s = store.getState();
  const home = view.name === 'list';
  $('#ss-home').hidden = !home;
  $('#ss-friend').hidden = view.name !== 'friend';
  $('#ss-conv').hidden = view.name !== 'conversation';
  $('#ss-back').hidden = home;
  const f = view.pid ? findFriend(view.pid, s) : null;
  $('#ss-title').textContent = home ? 'Amis' : f ? nameOf(f) : 'Discussion';
  if (home) {
    paintMe(s);
    paintGroups(s);
  } else if (view.name === 'friend' && f) {
    paintFriendHead(s);
  }
}

function goList() {
  view = { name: 'list' };
  paintView();
  focusTitle();
}

/** Discussion : le hook fournit le contenu ; sans hook, un texte provisoire. */
function paintConversation() {
  const box = $('#ss-conv');
  if (!box) return;
  const f = findFriend(view.pid);
  box.innerHTML = '';
  if (conversationRenderer) {
    try {
      conversationRenderer({ el: box, pid: view.pid, friend: f });
    } catch {
      toast('Discussion indisponible pour le moment.');
    }
    return;
  }
  box.innerHTML = '<div class="ss-placeholder"><p class="ss-sub">Discussion</p>' +
    '<p class="ss-hint">La messagerie avec ' + esc(f ? nameOf(f) : 'ce profil') + ' arrive bientôt.</p></div>';
}

// ---------- Ouverture, fermeture, cycle de vie ----------

/** Ouvre la barre latérale (sans effet si le social n’est pas disponible). */
export function openSidebar() {
  if (!root || !socialAvailable() || isSidebarOpen()) return;
  const prev = document.activeElement;
  lastOpener = prev instanceof HTMLElement && !root.contains(prev) ? prev : null;
  root.hidden = false;
  syncOpeners(true);
  view = { name: 'list' };
  paintView();
  ensureLoaded();
  loadInvite();
  focusTitle();
}

export function closeSidebar() {
  if (!root) return;
  const inside = root.contains(document.activeElement);
  const wasOpen = isSidebarOpen();
  root.hidden = true;
  view = { name: 'list' };
  syncOpeners(false);
  if (wasOpen && inside && lastOpener && lastOpener.isConnected) lastOpener.focus({ preventScroll: true });
  lastOpener = null;
  if (wasOpen && location.hash === '#/friends') history.replaceState(null, '', location.pathname + location.search);
}

export function toggleSidebar() {
  if (isSidebarOpen()) closeSidebar();
  else openSidebar();
}

/** Ouvre la fiche d’un ami (la barre s’ouvre si besoin). */
export function openFriendCard(pid) {
  if (!root || !socialAvailable()) return;
  openSidebar();
  if (!findFriend(pid)) {
    toast('Ce profil n’est plus dans tes amis.');
    return;
  }
  view = { name: 'friend', pid };
  paintView();
  loadFriendExtras(pid);
  focusTitle();
}

/** Ouvre la discussion avec un ami (contenu fourni par setConversationRenderer). */
export function openConversation(pid) {
  if (!root || !socialAvailable()) return;
  openSidebar();
  view = { name: 'conversation', pid };
  paintView();
  paintConversation();
  focusTitle();
}

/** Charge profil, amis et conversations si le store n’a pas encore le profil (ou si la liste a échoué). */
function ensureLoaded() {
  if (store.getState().me && !loadError) return;
  Promise.resolve().then(() => store.refresh()).then(
    () => { loadError = false; },
    () => { loadError = true; },
  ).then(() => { if (isSidebarOpen() && view.name === 'list') paintGroups(store.getState()); });
}

function onStore(s) {
  paintSocialBadges(s);
  if (!isSidebarOpen()) return;
  if (view.name === 'friend') {
    if (!findFriend(view.pid, s)) goList();
    else paintFriendHead(s);
  } else if (view.name === 'list') {
    paintMe(s);
    paintGroups(s);
  }
}

/** Réalise le branchement au profil actif : le social tourne pour le profil adulte connecté, et s’arrête sinon. */
function syncSocial() {
  const on = socialAvailable();
  const pid = on && auth.profile ? auth.profile.id : null;
  if (started && (!on || pid !== startedPid)) {
    store.stop();
    started = false;
    startedPid = null;
  }
  if (on && !started) {
    store.start();
    started = true;
    startedPid = pid;
  }
  if (!on && isSidebarOpen()) closeSidebar();
  paintSocialBadges();
}

/**
 * Monte la barre dans #social-sidebar (une fois, à l’amorçage), branche le store et le changement de profil. Ouvre la barre si
 * l’adresse est #/friends. Sans conteneur (tests, pages sans coque) : sans effet.
 */
export function mountSocialSidebar() {
  const el = document.getElementById('social-sidebar');
  if (!el || mounted) return;
  mounted = true;
  root = el;
  root.innerHTML = shellHTML();
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKey);
  document.addEventListener('click', onOpenerClick);
  store.subscribe(onStore);
  onAuthChange(syncSocial);
  syncSocial();
  if (location.hash === '#/friends') openSidebar();
}

// ---------- Actions ----------

function onOpenerClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-soc-open]') : null;
  if (!t) return;
  e.preventDefault();
  if (isSidebarOpen()) {
    closeSidebar();
    return;
  }
  openSidebar();
  if (isSidebarOpen()) lastOpener = t;
}

async function addFriend(form) {
  const input = form.elements.namedItem('handle');
  const msg = $('#ss-add-msg');
  const h = validateHandle(input.value);
  if (!h) {
    msg.textContent = ADD_ERRORS.invalid_handle;
    msg.dataset.tone = 'error';
    return;
  }
  msg.textContent = 'Envoi…';
  msg.dataset.tone = '';
  try {
    const out = await store.sendRequest(h.full);
    input.value = '';
    msg.textContent = 'friend' in out ? h.full + ' est maintenant ton ami.' : 'Demande envoyée à ' + h.full + '.';
  } catch (err) {
    msg.textContent = socialErrorMessage(err);
    msg.dataset.tone = 'error';
  }
}

async function inviteToRoom(btn, f) {
  if (!partyBridge.isActive()) {
    openPartyDialog(btn);
    return;
  }
  if (!partyBridge.isHost()) {
    if (partyBridge.room) await copyLink(partyBridge.room.id);
    return;
  }
  try {
    const inv = await partyBridge.createInvite(false);
    await copyText(joinLinkOf(shareBase(), inv.roomId, inv.token), 'Lien d’invitation copié' + (f ? ' : envoie-le à ' + nameOf(f) : ''));
  } catch {
    toast('Invitation impossible pour le moment.');
  }
}

function watchWith(f) {
  if (typeof watchHandler !== 'function') {
    toast('« Regarder avec lui » arrive bientôt.');
    return;
  }
  try {
    watchHandler(f);
  } catch {
    toast('Impossible de lancer la lecture.');
  }
}

function saveToLibrary(btn) {
  const it = state.byKey.get(btn.dataset.key);
  if (!it) return;
  userStore.addToLibrary({ id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: it.year || '' });
  btn.disabled = true;
  btn.textContent = 'Ajouté';
  toast('Ajouté à ta bibliothèque');
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-ss-act]') : null;
  if (!t || !root.contains(t)) return;
  const act = t.dataset.ssAct;
  const pid = t.dataset.pid;
  switch (act) {
    case 'close': closeSidebar(); break;
    case 'back': goList(); break;
    case 'reload':
      loadError = false;
      ensureLoaded();
      paintGroups(store.getState());
      break;
    case 'fold': {
      const gid = t.dataset.gid;
      if (collapsed.has(gid)) collapsed.delete(gid);
      else collapsed.add(gid);
      paintGroups(store.getState());
      break;
    }
    case 'open': openFriendCard(pid); break;
    case 'accept':
      run(() => store.accept(pid), (f) => nameOf(f) + ' est maintenant ton ami.');
      break;
    case 'decline':
      run(() => store.decline(pid), t.dataset.kind === 'in' ? 'Demande refusée' : 'Demande annulée');
      break;
    case 'message': openConversation(pid); break;
    case 'watch': watchWith(findFriend(pid)); break;
    case 'party': inviteToRoom(t, findFriend(pid)); break;
    case 'remove': {
      const f = findFriend(pid);
      if (!f || !window.confirm('Retirer ' + nameOf(f) + ' de tes amis ?')) break;
      run(() => store.removeFriend(pid), nameOf(f) + ' a été retiré.');
      break;
    }
    case 'lib-play': {
      const req = requestOf(t.dataset.key);
      if (req) playDirect(req, t);
      break;
    }
    case 'lib-save': saveToLibrary(t); break;
    case 'lib-retry': loadFriendExtras(view.pid); break;
    case 'copy-handle':
      if (store.getState().me) copyText(nameOf(store.getState().me), 'Pseudo copié');
      break;
    case 'inv-reload': loadInvite(); break;
    case 'copy-invite': copyInvite(t.dataset.id); break;
    case 'share-invite': shareInvite(t.dataset.id); break;
    default: break;
  }
}

function onChange(e) {
  const sel = e.target instanceof HTMLSelectElement && e.target.matches('[data-ss-status]') ? e.target : null;
  if (!sel) return;
  run(() => store.setStatus(sel.value), 'Statut mis à jour').then((r) => {
    if (r === undefined) paintMe(store.getState());
  });
}

function onSubmit(e) {
  if (!(e.target instanceof HTMLFormElement) || e.target.id !== 'ss-add') return;
  e.preventDefault();
  addFriend(e.target);
}

/** Écouteurs : Échap ferme la fiche (retour à la liste) puis la barre ; flèches haut/bas passent d’une action à l’autre. */
function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (view.name !== 'list') goList();
    else closeSidebar();
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target instanceof HTMLButtonElement) {
    e.preventDefault();
    moveFocus(e.key === 'ArrowDown' ? 1 : -1);
  }
}

/** Focus sur l’action suivante (dir = 1) ou précédente (dir = -1), dans l’ordre du document ; boucle en fin de liste. */
function moveFocus(dir) {
  const items = Array.from(root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])'))
    .filter((el) => !el.closest('[hidden]'));
  const n = items.length;
  if (!n) return;
  const i = items.indexOf(document.activeElement);
  const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
  items[next].focus();
}
