/* Barre latérale des amis (Social v3, maquettes « Sidebar amis », « Fiche d'un ami » et « Android : amis »). Panneau fixe à
 * droite (380 px) ; sous 768 px c'est la page « Amis » de la barre de navigation du bas. En-tête (moi, statut, réglages),
 * onglets Amis / Messages / Activité, ajout par Nom#TAG, groupes repliables avec carte riche « en train de regarder »,
 * demandes (amitié et « rejoindre »), pied « Inviter quelqu'un ». La fiche ami est dans socialCard.js. Les données viennent
 * du store (socialStore) ; tout texte du serveur ou de l'utilisateur passe par esc() ou textContent.
 * Hooks : setWatchWithHandler, setConversationRenderer (discussion v2), socialHooks (profil F2, messages F3, salon F6). */
import { auth, onAuthChange } from '../data/auth';
import * as store from '../data/socialStore';
import { validateHandle } from '../data/socialV2Api';
import { partyBridge } from '../party/bridge';
import { toast } from './dom.js';
import { copyInvite, refreshInvites, shareInvite, usableInvite } from './invites.js';
import { createFriendCard } from './socialCard.js';
import { activityHTML } from './socialActivity.js';
import {
  ADD_ERRORS, STATUS_OPTIONS, SEEN_LABEL, ago, avatarHTML, byName, clock, customStatusText, episodeCode, livePos, nameHTML, nameOf,
  posterBox, progressPct, shortName, socialErrorMessage, watchLine,
} from './socialFmt.js';
import { inviteToParty, openConversation as openConvHook, openProfileEditor, renderConversationList } from './socialHooks.js';
import { SI } from './socialIcons.js';
import { paintSocialBadges, socialAvailable } from './socialButton.js';
import { esc } from './util.js';

export { clock, episodeCode, livePos, socialErrorMessage, watchLine };

/** Ordre d'affichage des groupes ; chaque personne n'est que dans un groupe. */
const GROUPS = [['requests', 'Demandes'], ['watching', 'En train de regarder'], ['online', 'En ligne'], ['account', 'Profils du compte'], ['offline', 'Hors ligne']];
const TABS = [['friends', 'Amis'], ['messages', 'Messages'], ['activity', 'Activité']];
const PARTY_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- Rendu des lignes ----------

/** Sous-titre d'un ami qui ne regarde rien : statut personnalisé, sinon présence (avec l'ancienneté). */
function presenceText(f) {
  const cs = customStatusText(f.customStatus);
  if (cs && f.status !== 'offline') return cs;
  const base = SEEN_LABEL[f.status] || '';
  if (f.status === 'offline') return f.lastSeen ? base + ' · il y a ' + ago(f.lastSeen) : base;
  if (f.status === 'away' && f.lastSeen) return base + ' · ' + ago(f.lastSeen);
  return base;
}

/** Ligne glissante (mobile) : actions « Écrire » et « Inviter » révélées par un glissement vers la gauche. */
function swipeActs(pid) {
  return '<div class="ss-sw-acts">' +
    '<button type="button" class="ss-sw-b" tabindex="-1" data-ss-act="message" data-pid="' + pid + '">' + SI.chat + 'Écrire</button>' +
    '<button type="button" class="ss-sw-b is-pri" tabindex="-1" data-ss-act="party" data-pid="' + pid + '">' + SI.room + 'Inviter</button></div>';
}

/** Ligne d'un ami : bouton qui ouvre sa fiche. */
function friendRowHTML(f) {
  const pid = esc(f.pid);
  const w = f.watching;
  const sub = w
    ? '<span class="ss-sub">' + esc([w.title, episodeCode(w), clock(livePos(w))].filter(Boolean).join(' · ')) +
      (f.status === 'dnd' ? ' <em class="ss-dnd">· ne pas déranger</em>' : '') + '</span>'
    : '<span class="ss-sub">' + esc(presenceText(f)) + '</span>';
  return '<li class="ss-item ss-sw"><div class="ss-sw-in">' + '<button type="button" class="ss-row" data-ss-act="open" data-pid="' + pid + '" data-fk="open:' + pid + '">' +
    avatarHTML(f, 'ss-av-m', f.status) + '<span class="ss-row-t"><span class="ss-name">' + nameHTML(f) + '</span>' + sub + '</span>' +
    (w ? posterBox(w.poster, w.title, 'ss-poster-s') : '') + '</button></div>' + swipeActs(pid) + '</li>';
}

/** Carte riche d'un ami en ligne qui regarde un titre : progression, « Regarder avec … », écrire, plus d'actions. */
function watchCardHTML(f) {
  const pid = esc(f.pid);
  const w = f.watching;
  const pct = progressPct(w);
  const end = w.duration ? clock(w.duration) : '';
  return '<li class="ss-item"><div class="ss-wcard">' +
    '<button type="button" class="ss-wcard-top" data-ss-act="open" data-pid="' + pid + '" data-fk="open:' + pid + '">' +
    avatarHTML(f, 'ss-av-m', f.status) +
    '<span class="ss-row-t"><span class="ss-name">' + nameHTML(f) + '</span><span class="ss-sub ss-playing">' + SI.play +
    '<span class="ss-ell">' + esc(w.title) + '</span><span class="ss-m-only"> · ' + esc(clock(livePos(w))) + '</span></span></span>' +
    posterBox(w.poster, w.title, 'ss-poster-m') + '</button>' +
    '<p class="ss-prog"><span>' + esc([episodeCode(w), clock(livePos(w))].filter(Boolean).join(' · ')) + '</span>' +
    '<span class="ss-bar-t" aria-hidden="true"><i style="width:' + pct + '%"></i></span><span>' + esc(end) + '</span></p>' +
    '<div class="ss-wcard-acts"><button type="button" class="ss-btn2 ss-pri" data-ss-act="watch" data-pid="' + pid + '" data-fk="watch:' + pid + '">' + SI.play +
    'Regarder avec ' + esc(shortName(f)) + '</button>' +
    '<button type="button" class="ss-ico" data-ss-act="message" data-pid="' + pid + '" data-fk="msg:' + pid + '" aria-label="Écrire à ' + esc(shortName(f)) + '">' + SI.chat + '</button>' +
    '<button type="button" class="ss-ico ss-d-only" data-ss-act="open-menu" data-pid="' + pid + '" data-fk="more:' + pid + '" aria-label="Plus d’actions">' + SI.more + '</button>' +
    '</div></div></li>';
}

/** Demande reçue (accepter, refuser) ou envoyée (annuler). */
function requestRowHTML(r, incoming) {
  const pid = esc(r.pid);
  const acts = incoming
    ? '<button type="button" class="ss-ico ss-ico-pri" data-ss-act="accept" data-pid="' + pid + '" data-fk="accept:' + pid + '" aria-label="Accepter ' + esc(shortName(r)) + '">' + SI.check + '</button>' +
      '<button type="button" class="ss-ico" data-ss-act="decline" data-kind="in" data-pid="' + pid + '" data-fk="decline-in:' + pid + '" aria-label="Refuser ' + esc(shortName(r)) + '">' + SI.x + '</button>'
    : '<button type="button" class="ss-ico" data-ss-act="decline" data-kind="out" data-pid="' + pid + '" data-fk="decline-out:' + pid + '" aria-label="Annuler la demande à ' + esc(shortName(r)) + '">' + SI.x + '</button>';
  return '<li class="ss-item"><div class="ss-row ss-req">' + avatarHTML(r, 'ss-av-m') +
    '<span class="ss-row-t"><span class="ss-name">' + nameHTML(r) + '</span>' +
    '<span class="ss-sub">' + (incoming ? 'veut devenir ton ami' : 'demande envoyée') + '</span></span>' + acts + '</div></li>';
}

/** Demande de rejoindre ma watch party. */
function joinRowHTML(f) {
  const pid = esc(f.pid);
  return '<li class="ss-item"><div class="ss-row ss-req">' + avatarHTML(f, 'ss-av-m') +
    '<span class="ss-row-t"><span class="ss-name">' + nameHTML(f) + '</span><span class="ss-sub">demande à rejoindre ta watch party</span></span>' +
    '<button type="button" class="ss-ico ss-ico-pri" data-ss-act="join-accept" data-pid="' + pid + '" data-fk="join-ok:' + pid + '" aria-label="Accepter la demande de ' + esc(shortName(f)) + '">' + SI.check + '</button>' +
    '<button type="button" class="ss-ico" data-ss-act="join-decline" data-pid="' + pid + '" data-fk="join-no:' + pid + '" aria-label="Refuser la demande de ' + esc(shortName(f)) + '">' + SI.x + '</button></div></li>';
}

function groupHTML(id, title, items, collapsed) {
  const folded = collapsed.has(id);
  return '<section class="ss-group" data-group="' + id + '">' +
    '<h3 class="ss-hd"><button type="button" class="ss-fold" data-ss-act="fold" data-gid="' + id + '" data-fk="fold:' + id + '"' +
    ' aria-expanded="' + (folded ? 'false' : 'true') + '" aria-controls="ss-g-' + id + '">' +
    '<span class="ss-chev" aria-hidden="true">' + SI.chevRight + '</span><span class="ss-group-t">' + esc(title) + '</span>' +
    '<em class="ss-count' + (id === 'requests' ? ' is-hot' : '') + '">' + items.length + '</em></button></h3>' +
    '<ul class="ss-list" id="ss-g-' + id + '"' + (folded ? ' hidden' : '') + '>' + items.join('') + '</ul></section>';
}

/** Rang d'un ami dans son groupe : les favoris d'abord, puis par nom. */
const byRank = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || byName(a, b);
const matches = (p, q) => !q || (shortName(p) + ' ' + nameOf(p)).toLowerCase().includes(q);

/** Groupes de la liste : demandes, en train de regarder, en ligne, profils du compte, hors ligne. `q` : filtre par nom. */
export function groupsHTML(s, q = '', collapsed = new Set(['offline'])) {
  const rows = { requests: [], watching: [], online: [], account: [], offline: [] };
  const query = q.trim().toLowerCase();
  (s.joinRequests || []).filter((r) => matches(r, query)).forEach((r) => rows.requests.push(joinRowHTML(r)));
  s.incoming.filter((r) => matches(r, query)).forEach((r) => rows.requests.push(requestRowHTML(r, true)));
  s.outgoing.filter((r) => matches(r, query)).forEach((r) => rows.requests.push(requestRowHTML(r, false)));
  [...s.friends, ...s.household].filter((f) => matches(f, query)).sort(byRank).forEach((f) => {
    const g = f.watching ? 'watching' : f.household ? 'account' : f.status === 'offline' ? 'offline' : 'online';
    rows[g].push(g === 'watching' && (f.status === 'online' || f.status === 'away') ? watchCardHTML(f) : friendRowHTML(f));
  });
  const total = s.friends.length + s.household.length + s.incoming.length + s.outgoing.length + (s.joinRequests || []).length;
  if (!total) return '<p class="ss-empty">Pas encore d’ami. Ajoute quelqu’un avec son Nom#TAG, ou invite-le ci-dessous.</p>';
  const out = GROUPS.filter(([id]) => rows[id].length).map(([id, title]) => groupHTML(id, title, rows[id], query ? new Set() : collapsed)).join('');
  return out || '<p class="ss-empty">Aucun ami ne correspond à « ' + esc(q.trim()) + ' ».</p>';
}

// ---------- Coque ----------

function shellHTML() {
  return '<div class="ss-bar" id="ss-subbar" hidden>' +
    '<button type="button" class="ss-ico" id="ss-back" data-ss-act="back" aria-label="Retour à la liste des amis">' + SI.chevLeft + '</button>' +
    '<h2 class="ss-title" id="ss-title" tabindex="-1">Amis</h2>' +
    '<button type="button" class="ss-ico" data-ss-act="close" aria-label="Fermer la liste des amis">' + SI.close + '</button></div>' +
    '<div id="ss-home">' +
    '<div class="ss-mhead ss-m-only"><h2 class="ss-mtitle">Amis</h2>' +
    '<button type="button" class="ss-mbtn" data-ss-act="toggle-add" aria-label="Ajouter un ami">' + SI.addUser + '</button>' +
    '<button type="button" class="ss-mbtn ss-mclose" data-ss-act="close" aria-label="Fermer la liste des amis">' + SI.close + '</button></div>' +
    '<section class="ss-me" aria-label="Mon profil">' +
    '<span id="ss-me-av"></span>' +
    '<div class="ss-me-id">' +
    '<button type="button" class="ss-handle" id="ss-me-handle" data-ss-act="copy-handle" title="Copier mon Nom#TAG">…</button>' +
    '<button type="button" class="ss-stat" id="ss-status-btn" data-ss-act="status-menu" aria-haspopup="menu" aria-expanded="false"></button>' +
    '<div class="ss-menu ss-stat-menu" id="ss-status-menu" role="menu" aria-label="Mon statut" hidden>' +
    STATUS_OPTIONS.map(([v, l]) => '<button type="button" role="menuitemradio" aria-checked="false" class="ss-mi" data-ss-act="set-status" data-status="' + v + '">' + l + '</button>').join('') +
    '<div class="ss-mi-sep" role="separator"></div><button type="button" role="menuitem" class="ss-mi" data-ss-act="profile">Statut personnalisé…</button></div></div>' +
    '<button type="button" class="ss-ico ss-d-only" data-ss-act="profile" aria-label="Paramètres sociaux">' + SI.gear + '</button>' +
    '<button type="button" class="ss-ico ss-d-only" data-ss-act="close" aria-label="Fermer la liste des amis">' + SI.close + '</button>' +
    '<button type="button" class="ss-go ss-m-only" data-ss-act="profile" aria-label="Modifier mon profil social">' + SI.chevRight + '</button></section>' +
    '<div role="tablist" class="ss-tabs" aria-label="Amis, messages et activité">' + TABS.map(([id, label]) =>
      '<button type="button" role="tab" class="ss-tab" id="ss-tab-' + id + '" aria-selected="false" aria-controls="ss-p-' + id + '" tabindex="-1" data-ss-act="tab" data-tab="' + id + '">' +
      label + (id === 'messages' ? '<span class="ss-pill" id="ss-unread" hidden></span>' : '') + '</button>').join('') + '</div>' +
    '<div class="ss-panels">' +
    '<div class="ss-panel" id="ss-p-friends" role="tabpanel" aria-labelledby="ss-tab-friends">' +
    '<form class="ss-addf" id="ss-add" autocomplete="off"><label class="ss-sr" for="ss-add-in">Chercher un ami ou ajouter Nom#TAG</label>' +
    '<div class="ss-addrow"><div class="ss-addbox">' + SI.search + '<input id="ss-add-in" name="handle" type="text" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="Chercher ou ajouter Nom#TAG"></div>' +
    '<button type="submit" class="ss-ico ss-ico-add" aria-label="Ajouter un ami">' + SI.addUser + '</button></div>' +
    '<p class="ss-msg" id="ss-add-msg" role="status" aria-live="polite"></p></form>' +
    '<div id="ss-groups"></div></div>' +
    '<div class="ss-panel" id="ss-p-messages" role="tabpanel" aria-labelledby="ss-tab-messages" hidden></div>' +
    '<div class="ss-panel" id="ss-p-activity" role="tabpanel" aria-labelledby="ss-tab-activity" hidden></div></div>' +
    '<div class="ss-foot" id="ss-foot"><div id="ss-inv-slot" class="ss-inv"></div></div>' +
    '<button type="button" class="ss-fab ss-m-only" id="ss-fab" data-ss-act="share-invite" hidden>' + SI.link + '<span id="ss-fab-t">Inviter</span></button>' +
    '</div>' +
    '<div id="ss-friend" hidden></div>' +
    '<div id="ss-conv" hidden></div>';
}

// ---------- État du module ----------

let root = null;
let mounted = false;
/** Vue courante : { name: 'list' } | { name: 'friend', pid } | { name: 'conversation', pid }. */
let view = { name: 'list' };
let tab = 'friends';
let lastOpener = null;
let watchHandler = null;
let conversationRenderer = null;
/** Groupes repliés ; « Hors ligne » l'est par défaut. */
const collapsed = new Set(['offline']);
let loadError = false;
let started = false;
let startedPid = null;
let filterQ = '';
let cleanupMessages = null;
let activityStatus = 'ok';
let card = null;
let seenJoin = new Set();
let offJoinAnswer = null;

/** Hook du lot « Regarder avec lui » : appelé avec la fiche de l'ami (FriendView) quand il regarde un titre. */
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

/** Exécute une action du store : toast du résultat, ou du message d'erreur. */
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

/** Clé de focus (data-fk) de l'élément actif dans `box`, pour le retrouver après un nouvel affichage. */
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
  syncTabCurrent(open);
}

/** Mobile : l'onglet « Amis » de la barre du bas est l'onglet actif tant que la page Amis est ouverte (l'ancien reprend ensuite). */
function syncTabCurrent(open) {
  document.querySelectorAll('.tabbar .tab[data-soc-open]').forEach((amis) => {
    const bar = amis.closest('.tabbar');
    if (!bar) return;
    if (open && root && root.classList.contains('ss-tabbed')) {
      if (amis.dataset.ssWas === 'amis') return;
      bar.querySelectorAll('.tab.is-current').forEach((t) => { t.classList.remove('is-current'); t.dataset.ssWas = '1'; });
      amis.classList.add('is-current');
      amis.dataset.ssWas = 'amis';
    } else {
      if (amis.dataset.ssWas === 'amis') { amis.classList.remove('is-current'); delete amis.dataset.ssWas; }
      bar.querySelectorAll('.tab[data-ss-was="1"]').forEach((t) => { t.classList.add('is-current'); delete t.dataset.ssWas; });
    }
  });
}

/** Point d'entrée du focus : l'onglet courant sur la liste, le titre dans une sous-vue. */
function focusTop() {
  const el = view.name === 'list' ? $('.ss-tab[aria-selected="true"]') : $('#ss-title');
  if (el) el.focus({ preventScroll: true });
}

// ---------- Peinture ----------

function paintMe(s) {
  const me = s.me;
  const holder = $('#ss-me-av');
  if (holder) holder.innerHTML = avatarHTML({ ...(s.profile || {}), ...(me || {}), handle: me && me.handle }, 'ss-av-l', s.status === 'invisible' ? 'offline' : s.status);
  const h = $('#ss-me-handle');
  if (h) h.innerHTML = me ? nameHTML({ handle: me.handle }) + '<span class="ss-copy">' + SI.copy + '</span>' : '…';
  if (h) h.setAttribute('aria-label', me ? 'Copier mon identifiant ' + nameOf(me) : 'Mon identifiant');
  const st = $('#ss-status-btn');
  if (st) {
    const label = STATUS_OPTIONS.find(([v]) => v === s.status);
    const custom = s.profile ? customStatusText(s.profile.customStatus) : '';
    const color = s.status === 'invisible' ? 'offline' : s.status;
    st.innerHTML = '<i class="ss-pdot-i is-' + esc(color) + '" aria-hidden="true"></i><span class="ss-ell">' + esc(label ? label[1] : 'En ligne') +
      (custom ? ' · « ' + esc(custom) + ' »' : '') + '</span>' + SI.chevDown;
    st.setAttribute('aria-label', 'Mon statut : ' + (label ? label[1] : 'En ligne') + (custom ? ', ' + custom : ''));
  }
  $('#ss-status-menu')?.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.status === s.status)));
  const unread = $('#ss-unread');
  if (unread) {
    unread.textContent = s.unread > 99 ? '99+' : String(s.unread);
    unread.hidden = !(s.unread > 0);
  }
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
  box.innerHTML = groupsHTML(s, filterQ, collapsed);
  restoreFocusIn(box, keep);
}

function paintActivity(s) {
  const box = $('#ss-p-activity');
  if (!box) return;
  const keep = focusKeyIn(box);
  box.innerHTML = activityHTML(s.activity || [], activityStatus);
  restoreFocusIn(box, keep);
}

function loadActivityFeed() {
  activityStatus = (store.getState().activity || []).length ? 'ok' : 'loading';
  paintActivity(store.getState());
  Promise.resolve().then(() => store.loadActivity({ limit: 30 })).then(
    () => { activityStatus = 'ok'; },
    () => { activityStatus = 'error'; },
  ).then(() => { if (isSidebarOpen() && tab === 'activity') paintActivity(store.getState()); });
}

function leaveMessages() {
  if (cleanupMessages) {
    try { cleanupMessages(); } catch { /* le lot messages nettoie ce qu'il peut */ }
    cleanupMessages = null;
  }
}

function enterMessages() {
  const box = $('#ss-p-messages');
  if (!box) return;
  leaveMessages();
  box.innerHTML = '';
  try {
    const off = renderConversationList(box);
    cleanupMessages = typeof off === 'function' ? off : null;
  } catch {
    toast('Messages indisponibles pour le moment.');
  }
  if (!box.childElementCount) box.innerHTML = '<p class="ss-empty">Tes conversations apparaîtront ici.</p>';
}

/** Affiche l'onglet `id` (Amis, Messages, Activité). */
function setTab(id, focus = false) {
  if (tab === 'messages' && id !== 'messages') leaveMessages();
  tab = id;
  root.querySelectorAll('.ss-tab').forEach((b) => {
    const on = b.dataset.tab === id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  TABS.forEach(([t]) => { const p = $('#ss-p-' + t); if (p) p.hidden = t !== id; });
  const foot = $('#ss-foot');
  if (foot) foot.classList.toggle('is-off', id !== 'friends');
  const fab = $('#ss-fab');
  if (fab) fab.classList.toggle('is-off', id !== 'friends');
  if (id === 'messages') enterMessages();
  else if (id === 'activity') loadActivityFeed();
  else paintGroups(store.getState());
  if (focus) $('.ss-tab[aria-selected="true"]')?.focus({ preventScroll: true });
}

// ---------- Invitation ----------

const usableCount = (d) => (d && d !== 'error' ? d.invites.filter((i) => i.state !== 'used').length : 0);

function paintInvite(d) {
  const box = $('#ss-inv-slot');
  const fab = $('#ss-fab');
  if (!box) return;
  const head = '<div class="ss-inv-t"><b>Inviter quelqu’un</b>';
  if (d === 'error') {
    box.innerHTML = head + '<span role="alert">Invitations indisponibles. <button type="button" class="ss-link" data-ss-act="inv-reload">Réessayer</button></span></div>';
    if (fab) fab.hidden = true;
    return;
  }
  if (d === 'loading') {
    box.innerHTML = head + '<span role="status">Chargement…</span></div>';
    if (fab) fab.hidden = true;
    return;
  }
  const inv = usableInvite();
  if (!inv) {
    box.innerHTML = head + '<span role="status">Aucun lien disponible pour le moment.</span></div>';
    if (fab) fab.hidden = true;
    return;
  }
  const n = usableCount(d);
  const id = esc(inv.id);
  box.innerHTML = head + '<span>' + n + ' invitation' + (n > 1 ? 's' : '') + ' restante' + (n > 1 ? 's' : '') + '</span></div>' +
    '<button type="button" class="ss-btn2 ss-sec" data-ss-act="copy-invite" data-id="' + id + '" data-fk="copy-invite:' + id + '">' + SI.link + 'Copier un lien</button>';
  if (fab) {
    fab.hidden = false;
    fab.dataset.id = inv.id;
    const t = $('#ss-fab-t');
    if (t) t.textContent = 'Inviter · ' + n;
  }
}

/** Charge le pied « Inviter quelqu'un » (liens de parrainage du compte, via invites.js). */
async function loadInvite() {
  if (!$('#ss-inv-slot')) return;
  paintInvite('loading');
  let d;
  try {
    d = await refreshInvites();
  } catch {
    d = 'error';
  }
  paintInvite(d);
}

// ---------- Vues ----------

/** Affiche la vue courante (zones, barre du haut des sous-vues, titre). */
function paintView() {
  if (!root) return;
  const s = store.getState();
  const home = view.name === 'list';
  $('#ss-home').hidden = !home;
  $('#ss-friend').hidden = view.name !== 'friend';
  $('#ss-conv').hidden = view.name !== 'conversation';
  $('#ss-subbar').hidden = home;
  const f = view.pid ? findFriend(view.pid, s) : null;
  $('#ss-title').textContent = home ? 'Amis' : view.name === 'friend' ? 'Amis' : f ? shortName(f) : 'Discussion';
  root.setAttribute('aria-label', view.name === 'friend' && f ? 'Fiche de ' + shortName(f) : 'Amis');
  if (home) {
    paintMe(s);
    if (tab === 'friends') paintGroups(s);
  }
}

function goList() {
  if (card) card.close();
  view = { name: 'list' };
  paintView();
  focusTop();
}

/** Discussion v2 : le hook fournit le contenu ; sans hook, un texte provisoire. */
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

/** La barre de navigation du bas est-elle affichée ? Alors la page « Amis » s'arrête au-dessus d'elle (mobile). */
function syncTabbed() {
  const bar = document.querySelector('#app:not([hidden]) .tabbar, #detail:not([hidden]) .tabbar');
  root.classList.toggle('ss-tabbed', !!bar);
}

/** Ouvre la barre latérale (sans effet si le social n'est pas disponible). */
export function openSidebar() {
  if (!root || !socialAvailable() || isSidebarOpen()) return;
  const prev = document.activeElement;
  lastOpener = prev instanceof HTMLElement && !root.contains(prev) ? prev : null;
  root.hidden = false;
  document.body.classList.add('ss-open');
  syncTabbed();
  syncOpeners(true);
  view = { name: 'list' };
  paintView();
  setTab(tab);
  ensureLoaded();
  loadInvite();
  focusTop();
}

export function closeSidebar() {
  if (!root) return;
  const inside = root.contains(document.activeElement);
  const wasOpen = isSidebarOpen();
  leaveMessages();
  if (card) card.close();
  root.hidden = true;
  document.body.classList.remove('ss-open');
  view = { name: 'list' };
  filterQ = '';
  const q = $('#ss-add-in');
  if (q) q.value = '';
  closeStatusMenu();
  syncOpeners(false);
  if (wasOpen && inside && lastOpener && lastOpener.isConnected) lastOpener.focus({ preventScroll: true });
  lastOpener = null;
  if (wasOpen && location.hash === '#/friends') history.replaceState(null, '', location.pathname + location.search);
}

export function toggleSidebar() {
  if (isSidebarOpen()) closeSidebar();
  else openSidebar();
}

/** Ouvre la fiche d'un ami (la barre s'ouvre si besoin). */
export function openFriendCard(pid) {
  if (!root || !socialAvailable()) return;
  openSidebar();
  if (!findFriend(pid)) {
    toast('Ce profil n’est plus dans tes amis.');
    return;
  }
  view = { name: 'friend', pid };
  paintView();
  card.open(pid);
  focusTop();
}

/** Ouvre la discussion avec un ami : fenêtres de discussion Social v3 (hook F3). */
export function openConversation(pid) {
  if (!socialAvailable()) return;
  openConvHook(pid.startsWith('dm:') || pid.startsWith('g:') ? pid : `dm:${pid}`);
}

/** Ancienne discussion v2 dans la barre (gardée pour repli, plus appelée). */
export function openLegacyConversation(pid) {
  if (!root || !socialAvailable()) return;
  openSidebar();
  if (card) card.close();
  view = { name: 'conversation', pid };
  paintView();
  paintConversation();
  focusTop();
}

/** Charge profil, amis et conversations si le store n'a pas encore le profil (ou si la liste a échoué). */
function ensureLoaded() {
  if (store.getState().me && !loadError) return;
  Promise.resolve().then(() => store.refresh()).then(
    () => { loadError = false; },
    () => { loadError = true; },
  ).then(() => { if (isSidebarOpen() && view.name === 'list') { paintMe(store.getState()); if (tab === 'friends') paintGroups(store.getState()); } });
}

// ---------- Demandes de rejoindre (toasts) ----------

function acceptJoin(pid) {
  const room = partyBridge.isActive() && partyBridge.room ? partyBridge.room.id : undefined;
  return run(async () => {
    await store.answerJoin(pid, room ? { accept: true, partyId: room } : { accept: true });
    if (!room) inviteToParty(pid);
  }, 'Demande acceptée');
}

const declineJoin = (pid) => run(() => store.answerJoin(pid, { accept: false }), 'Demande refusée');

function announceJoinRequests(s) {
  const now = new Set((s.joinRequests || []).map((r) => r.pid));
  (s.joinRequests || []).forEach((r) => {
    if (seenJoin.has(r.pid)) return;
    toast(shortName(r) + ' demande à rejoindre ta watch party', { action: { label: 'Accepter', run: () => acceptJoin(r.pid) }, ms: 9000 });
  });
  seenJoin = now;
}

function onJoinAnswer(ev) {
  const f = findFriend(ev.pid);
  const name = f ? shortName(f) : 'Ton ami';
  if (!ev.accept) {
    toast(name + ' ne peut pas t’accueillir pour le moment.');
    return;
  }
  if (ev.partyId && PARTY_ID.test(ev.partyId)) {
    toast(name + ' accepte : rejoins sa watch party', { action: { label: 'Rejoindre', run: () => { location.hash = '#/party/' + ev.partyId; } }, ms: 9000 });
    return;
  }
  toast(name + ' a accepté ta demande.');
}

function onStore(s) {
  paintSocialBadges(s);
  announceJoinRequests(s);
  if (!isSidebarOpen()) return;
  paintMe(s);
  if (view.name === 'friend') {
    if (!findFriend(view.pid, s)) goList();
    else card.repaint();
  } else if (view.name === 'list') {
    if (tab === 'friends') paintGroups(s);
    else if (tab === 'activity') paintActivity(s);
  }
}

/** Réalise le branchement au profil actif : le social tourne pour le profil adulte connecté, et s'arrête sinon. */
function syncSocial() {
  const on = socialAvailable();
  const pid = on && auth.profile ? auth.profile.id : null;
  if (started && (!on || pid !== startedPid)) {
    store.stop();
    started = false;
    startedPid = null;
    seenJoin = new Set();
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
 * Monte la barre dans #social-sidebar (une fois, à l'amorçage), branche le store et le changement de profil. Ouvre la barre si
 * l'adresse est #/friends. Sans conteneur (tests, pages sans coque) : sans effet.
 */
export function mountSocialSidebar() {
  const el = document.getElementById('social-sidebar');
  if (!el || mounted) return;
  mounted = true;
  root = el;
  root.innerHTML = shellHTML();
  card = createFriendCard({
    root,
    box: $('#ss-friend'),
    toast,
    findFriend: (pid) => findFriend(pid),
    openLibrary: (pid) => { closeSidebar(); location.hash = '#/friend/' + encodeURIComponent(pid); },
  });
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchmove', onTouchMove, { passive: true });
  root.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('click', onOpenerClick);
  window.addEventListener('hashchange', onHashChange);
  store.subscribe(onStore);
  if (typeof store.onJoinAnswer === 'function') offJoinAnswer = store.onJoinAnswer(onJoinAnswer);
  onAuthChange(syncSocial);
  syncSocial();
  setTab('friends');
  if (location.hash === '#/friends') openSidebar();
}

/** Démontage (tests). */
export function unmountSocialSidebar() {
  if (offJoinAnswer) offJoinAnswer();
  offJoinAnswer = null;
}

// ---------- Actions ----------

function closeStatusMenu() {
  const m = $('#ss-status-menu');
  const b = $('#ss-status-btn');
  if (m) m.hidden = true;
  if (b) b.setAttribute('aria-expanded', 'false');
}

/** Mobile : la page « Amis » plein écran se ferme dès que l'adresse change (sauf #/friends). Bureau : la barre reste ouverte. */
function onHashChange() {
  if (!isSidebarOpen() || location.hash === '#/friends') return;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches) closeSidebar();
}

function onOpenerClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-soc-open]') : null;
  if (t) {
    e.preventDefault();
    if (isSidebarOpen()) {
      closeSidebar();
      return;
    }
    openSidebar();
    if (isSidebarOpen()) lastOpener = t;
    return;
  }
  // Un autre onglet de la barre du bas (Accueil, Rechercher, Ma liste) quitte la page « Amis ».
  if (isSidebarOpen() && root.classList.contains('ss-tabbed') && e.target instanceof Element && e.target.closest('.tabbar')) closeSidebar();
  // Clic à l'extérieur du menu de statut.
  if (e.target instanceof Element && !e.target.closest('.ss-me-id')) closeStatusMenu();
}

async function addFriend(form) {
  const input = form.elements.namedItem('handle');
  const msg = $('#ss-add-msg');
  const raw = input.value.trim();
  if (!raw) return;
  const h = validateHandle(raw);
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
    filterQ = '';
    paintGroups(store.getState());
    msg.textContent = 'friend' in out ? h.full + ' est maintenant ton ami.' : 'Demande envoyée à ' + h.full + '.';
  } catch (err) {
    msg.textContent = socialErrorMessage(err);
    msg.dataset.tone = 'error';
  }
}

/** « Inviter » : ajoute l'ami à ma watch party active, ou en crée une sur le titre en cours (lot F6). */
function inviteFriend(f) {
  if (f) inviteToParty(f.pid);
}

function watchWith(f) {
  if (typeof watchHandler !== 'function') {
    toast('« Regarder avec ' + (f ? shortName(f) : 'lui') + ' » arrive bientôt.');
    return;
  }
  try {
    watchHandler(f);
  } catch {
    toast('Impossible de lancer la lecture.');
  }
}

/** Menu ⋯ d'une carte de la liste : ouvre la fiche avec son menu déployé. */
function openCardMenu(pid) {
  openFriendCard(pid);
  card.handle('c-menu', null);
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('[data-ss-act]') : null;
  if (!t || !root.contains(t)) return;
  const act = t.dataset.ssAct;
  const pid = t.dataset.pid;
  if (view.name === 'friend' && card.handle(act, t)) return;
  if (act !== 'status-menu' && act !== 'set-status' && act !== 'profile') closeStatusMenu();
  switch (act) {
    case 'close': closeSidebar(); break;
    case 'back': goList(); break;
    case 'reload':
      loadError = false;
      ensureLoaded();
      paintGroups(store.getState());
      break;
    case 'tab': setTab(t.dataset.tab); break;
    case 'toggle-add': {
      const f = $('#ss-add');
      f.classList.toggle('is-open');
      if (f.classList.contains('is-open')) $('#ss-add-in').focus();
      break;
    }
    case 'fold': {
      const gid = t.dataset.gid;
      if (collapsed.has(gid)) collapsed.delete(gid);
      else collapsed.add(gid);
      paintGroups(store.getState());
      break;
    }
    case 'open': openFriendCard(pid); break;
    case 'open-menu': openCardMenu(pid); break;
    case 'accept':
      run(() => store.accept(pid), (f) => nameOf(f) + ' est maintenant ton ami.');
      break;
    case 'decline':
      run(() => store.decline(pid), t.dataset.kind === 'in' ? 'Demande refusée' : 'Demande annulée');
      break;
    case 'join-accept': acceptJoin(pid); break;
    case 'join-decline': declineJoin(pid); break;
    case 'message': openConversation(pid); break;
    case 'watch': watchWith(findFriend(pid)); break;
    case 'party': inviteFriend(findFriend(pid)); break;
    case 'profile': closeStatusMenu(); openProfileEditor(); break;
    case 'status-menu': {
      const m = $('#ss-status-menu');
      m.hidden = !m.hidden;
      t.setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) m.querySelector('[aria-checked="true"], .ss-mi')?.focus();
      break;
    }
    case 'set-status':
      closeStatusMenu();
      run(() => store.setStatus(t.dataset.status), 'Statut mis à jour').then((r) => {
        if (r === undefined) paintMe(store.getState());
      });
      $('#ss-status-btn')?.focus({ preventScroll: true });
      break;
    case 'copy-handle':
      if (store.getState().me) copyText(nameOf(store.getState().me), 'Pseudo copié');
      break;
    case 'act-retry': loadActivityFeed(); break;
    case 'inv-reload': loadInvite(); break;
    case 'copy-invite': copyInvite(t.dataset.id); break;
    case 'share-invite': shareInvite(t.dataset.id || (usableInvite() || {}).id); break;
    default: break;
  }
}

function onSubmit(e) {
  if (!(e.target instanceof HTMLFormElement)) return;
  if (e.target.id === 'ss-add') {
    e.preventDefault();
    addFriend(e.target);
  } else if (e.target.dataset.ssForm) {
    e.preventDefault();
    card.submit(e.target);
  }
}

/** Saisie dans le champ : sans « # », c'est une recherche dans la liste ; avec « # », un pseudo à ajouter (liste intacte). */
function onInput(e) {
  if (!(e.target instanceof HTMLInputElement) || e.target.id !== 'ss-add-in') return;
  const v = e.target.value;
  filterQ = v.includes('#') ? '' : v;
  const msg = $('#ss-add-msg');
  if (msg) { msg.textContent = ''; msg.dataset.tone = ''; }
  paintGroups(store.getState());
}

/** Écouteurs : Échap ferme dialogue, menu, fiche puis barre ; flèches haut/bas passent d'une action à l'autre. */
function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const sm = $('#ss-status-menu');
    if (card && card.dialogOpen) card.closeDialog();
    else if (sm && !sm.hidden) { closeStatusMenu(); $('#ss-status-btn')?.focus({ preventScroll: true }); }
    else if (card && card.menuOpen) card.closeMenu();
    else if (view.name !== 'list') goList();
    else closeSidebar();
    return;
  }
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const tablist = el.closest('[role="tablist"]');
  if (tablist && el.matches('[role="tab"]') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const next = tabs[(tabs.indexOf(el) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    next.click();
    return;
  }
  const menu = el.closest('[role="menu"]');
  if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
    const i = items.indexOf(el);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    return;
  }
  if (el.closest('.ss-dlg') && e.key === 'Tab') return;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && el instanceof HTMLButtonElement) {
    e.preventDefault();
    moveFocus(e.key === 'ArrowDown' ? 1 : -1);
  }
}

/** Focus sur l'action suivante (dir = 1) ou précédente (dir = -1), dans l'ordre du document ; boucle en fin de liste. */
function moveFocus(dir) {
  const items = Array.from(root.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), select:not([disabled])'))
    .filter((el) => !el.closest('[hidden]'));
  const n = items.length;
  if (!n) return;
  const i = items.indexOf(document.activeElement);
  const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
  items[next].focus();
}

// ---------- Glissement des lignes (mobile) ----------

const SWIPE_OPEN = 144;
let swipe = null;

function closeSwipes(except) {
  root.querySelectorAll('.ss-sw.is-open').forEach((li) => {
    if (li !== except) {
      li.classList.remove('is-open');
      li.querySelectorAll('.ss-sw-b').forEach((b) => { b.tabIndex = -1; });
    }
  });
}

function onTouchStart(e) {
  const li = e.target instanceof Element ? e.target.closest('.ss-sw') : null;
  if (!li || e.touches.length !== 1) { swipe = null; return; }
  swipe = { li, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, locked: false };
}

function onTouchMove(e) {
  if (!swipe) return;
  const dx = e.touches[0].clientX - swipe.x;
  const dy = e.touches[0].clientY - swipe.y;
  if (!swipe.locked && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
  if (Math.abs(dx) > 8) swipe.locked = true;
  swipe.dx = dx;
}

function onTouchEnd() {
  if (!swipe) return;
  const { li, dx } = swipe;
  swipe = null;
  if (dx < -40) {
    closeSwipes(li);
    li.classList.add('is-open');
    li.querySelectorAll('.ss-sw-b').forEach((b) => { b.tabIndex = 0; });
    li.style.setProperty('--ss-sw', SWIPE_OPEN + 'px');
  } else if (dx > 30) {
    closeSwipes();
  }
}
