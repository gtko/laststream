/* Feuille « Regarder avec… » de la fiche d'un titre (LAST-199, lot B) : les amis déjà dans un salon (Rejoindre), les amis à inviter
 * (flux d'invitation de salon existant, inviteToParty), « Planifier une soirée » (la feuille de création, titre prérempli) et
 * l'ouverture d'un salon pour ce titre (boîte « Watch party »). Présence : socialStore ; salons d'amis : mêmes règles que la page
 * Ensemble (hostFriend, friendRooms). Réservée à un compte connecté, profil adulte. Feuille basse sur mobile. */
import { auth } from '../data/auth';
import { friendName } from '../data/homeSocial';
import { eveningsAvailable } from '../data/eveningsStore';
import { listParties } from '../data/socialApi';
import { subscribe } from '../data/socialStore';
import { userStore } from '../data/userStore';
import { openEveningForm } from './eveningForm.js';
import { friendRooms } from './homeSocialRows.js';
import { hostFriend } from './parties.js';
import { sortedFriends } from './partyfriends.js';
import { openPartyDialog } from './partylaunch.js';
import { openSheet } from './sheet.js';
import { avatarHTML, SEEN_LABEL } from './socialFmt.js';
import { inviteToParty } from './socialHooks.js';
import { esc, rewriteKeepingFocus } from './util.js';

/** Amis montrés au plus (les salons d'abord, puis les amis en ligne). */
const ROWS_MAX = 8;

/** Amis invitables : mes amis (jamais le foyer ni les amis en sourdine). */
const friendsNow = () => sortedFriends().filter((f) => !f.household && !f.muted);

/** Lignes de la feuille : [ami, salon ou null], salons d'abord, puis les amis connectés. */
function watchWithRows(friends, rooms) {
  const open = friendRooms(rooms, friends);
  const byPid = new Map();
  for (const r of open) {
    const f = hostFriend(r.host, friends);
    if (f && !byPid.has(f.pid)) byPid.set(f.pid, r);
  }
  const inRoom = friends.filter((f) => byPid.has(f.pid)).map((f) => [f, byPid.get(f.pid)]);
  const online = friends.filter((f) => !byPid.has(f.pid) && f.status !== 'offline').map((f) => [f, null]);
  return [...inRoom, ...online].slice(0, ROWS_MAX);
}

function rowHTML([f, room]) {
  const name = friendName(f);
  const sub = room ? 'Dans un salon : ' + esc(room.title) : f.watching ? 'Regarde ' + esc(f.watching.title) : esc(SEEN_LABEL[f.status] || 'En ligne');
  const act = room
    ? '<a class="btn btn-primary ww-btn" href="#/party/' + encodeURIComponent(room.id) + '" data-go data-ww-go aria-label="Rejoindre le salon de ' + esc(name) + '">Rejoindre</a>'
    : '<button type="button" class="btn btn-ghost ww-btn" data-ww-invite="' + esc(f.pid) + '" aria-label="Inviter ' + esc(name) + '">Inviter</button>';
  return '<li class="ww-row">' + avatarHTML(f, 'ss-av-m', f.status === 'offline' ? '' : f.status) + '<span class="ww-nm"><b>' + esc(name) + '</b><small>' + sub + '</small></span>' + act + '</li>';
}

/** Contenu de la liste : lignes, ou le message qui explique pourquoi il n'y en a pas. */
function watchWithListHTML(friends, rooms) {
  const rows = watchWithRows(friends, rooms);
  if (rows.length) return '<ul class="ww-list">' + rows.map(rowHTML).join('') + '</ul>';
  if (!friends.length) return '<p class="ww-empty">Tu n’as pas encore d’amis ici. <a href="#/friends" data-go data-ww-go>Ajouter des amis</a>, ou planifie une soirée pour les inviter plus tard.</p>';
  return '<p class="ww-empty">Aucun ami n’est en ligne pour le moment. Planifie une soirée : ils recevront l’invitation.</p>';
}

/**
 * Ouvre la feuille pour `model` (titre de la fiche : `{ name, ... }`). Rend la feuille, ou `null` quand elle n'existe pas pour ce profil
 * (hors compte, profil enfant) : l'appelant garde alors son comportement d'origine.
 * @param {Element | null} opener
 * @param {{ name?: string } | null} model
 */
export function openWatchWith(opener, model) {
  if (!eveningsAvailable()) return null;
  const pid0 = auth.profile ? auth.profile.id : '';
  const same = () => (auth.profile ? auth.profile.id : '') === pid0;
  /** @type {any[]} */
  let rooms = [];
  let unsub = () => undefined;
  let last = '';
  const sheet = openSheet({
    title: 'Regarder avec…',
    cls: 'ww-sheet',
    opener,
    onClose: () => unsub(),
    html: '<p class="ww-lead">Chacun lit avec son propre compte, au même moment.</p><div data-ww-slot></div>' +
      '<button type="button" class="btn btn-ghost ww-plan" data-ww-plan>Planifier une soirée</button>' +
      '<button type="button" class="ww-link" data-ww-room>Ouvrir un salon pour ce titre</button>',
  });
  const slot = sheet.el.querySelector('[data-ww-slot]');
  if (!(slot instanceof HTMLElement)) return sheet;
  const paint = () => {
    if (sheet.closed || !same()) return;
    const html = watchWithListHTML(friendsNow(), rooms);
    if (html === last) return;
    last = html;
    rewriteKeepingFocus(slot, html);
  };
  paint();
  unsub = subscribe(paint);
  // Salons ouverts : lus une fois ; une réponse arrivée après la fermeture ou un changement de profil est ignorée.
  listParties(userStore.currentProfile().id, { limit: 20 }).then(
    (res) => { if (!sheet.closed && same()) { rooms = (res && res.rooms) || []; paint(); } },
    () => undefined,
  );
  sheet.el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-ww-go]')) { sheet.close(true); return; }
    const inv = t.closest('[data-ww-invite]');
    if (inv) {
      const pid = inv.getAttribute('data-ww-invite') || '';
      sheet.close(true);
      void inviteToParty(pid);
      return;
    }
    if (t.closest('[data-ww-plan]')) {
      sheet.close(true);
      openEveningForm({ title: model && model.name ? String(model.name) : '', opener });
      return;
    }
    if (t.closest('[data-ww-room]')) {
      sheet.close(true);
      if (opener) openPartyDialog(opener, model);
    }
  });
  return sheet;
}
