/* Colonne latérale de la page Ensemble (à droite sur grand écran, sous la page sur mobile) : amis disponibles (présence du store,
 * bouton Inviter), activité récente (fil des amis) et rappel des billets de parrainage restants. Une requête chacune à l'ouverture
 * (activité, billets), aucun polling : la présence vient du store en direct. Tout texte venant du serveur passe par esc(). */
import { getInvites } from '../data/socialApi';
import { getState, loadActivity, subscribe } from '../data/socialStore';
import { userStore } from '../data/userStore';
import { sortedFriends } from './partyfriends.js';
import { activityText } from './socialActivity.js';
import { ago, avatarHTML, SEEN_LABEL, shortName } from './socialFmt.js';
import { inviteToParty } from './socialHooks.js';
import { state } from './state.js';
import { detailEl } from './dom.js';
import { esc, rewriteKeepingFocus } from './util.js';

const FRIENDS_MAX = 5;
const ACTIVITY_MAX = 4;

/** Montage courant : compteur (une réponse d'un montage périmé n'écrit rien), profil, élément, état des chargements. */
let gen = 0;
let host = null;
let owner = '';
let activityStatus = 'loading';
/** Billets libres restants, ou null tant qu'inconnu / en échec (la carte n'apparaît alors pas). */
let freeTickets = null;
let subscribed = false;
/** Dernier HTML écrit par élément. */
const written = new WeakMap();

const plural = (n, word) => n + ' ' + word + (n > 1 ? 's' : '');

function friendsCard() {
  const all = sortedFriends().filter((f) => !f.muted);
  const online = all.filter((f) => f.status === 'online');
  const rows = online.slice(0, FRIENDS_MAX).map((f) => {
    const name = shortName(f);
    return '<li class="ens-frow">' + avatarHTML(f, 'ss-av-m', f.status) + '<span class="ens-fnm"><b>' + esc(name) + '</b><small>' +
      (f.watching ? 'En ligne · regarde ' + esc(f.watching.title) : esc(SEEN_LABEL[f.status] || '')) + '</small></span>' +
      '<button type="button" class="btn btn-ghost ens-sbtn" data-ens-invite="' + esc(f.pid) + '" aria-label="Inviter ' + esc(name) + ' dans un salon">Inviter</button></li>';
  });
  return '<section class="ens-card" aria-labelledby="ens-h-friends"><h2 id="ens-h-friends">Disponibles maintenant</h2>' +
    (rows.length ? '<ul class="ens-flist">' + rows.join('') + '</ul>' : '<p class="ens-note">' + (all.length ? 'Personne n’est en ligne pour l’instant.' : 'Aucun ami pour l’instant.') + '</p>') +
    '<a class="btn btn-ghost ens-sbtn ens-all" href="#/friends" data-go>' + (all.length ? 'Tout voir (' + plural(all.length, 'ami') + ')' : 'Trouver des amis') + '</a></section>';
}

function activityCard() {
  const items = [...getState().activity].sort((a, b) => b.at - a.at).slice(0, ACTIVITY_MAX);
  const body = items.length
    ? '<ul class="ens-act-list">' + items.map((it) => '<li><b>' + esc(shortName(it)) + '</b> ' + esc(activityText(it)) + (ago(it.at) ? ' · ' + esc(ago(it.at)) : '') + '</li>').join('') + '</ul>'
    : '<p class="ens-note" role="status">' + (activityStatus === 'loading' ? 'Chargement…' : activityStatus === 'error' ? 'Activité indisponible pour le moment.' : 'Rien pour l’instant. Ce que regardent et notent tes amis apparaîtra ici.') + '</p>';
  return '<section class="ens-card" aria-labelledby="ens-h-act"><h2 id="ens-h-act">Activité récente</h2>' + body + '</section>';
}

function ticketsCard() {
  if (!freeTickets) return '';
  return '<section class="ens-card ens-tkt" aria-labelledby="ens-h-tkt"><h2 id="ens-h-tkt">Il te reste ' + plural(freeTickets, 'billet') + '</h2>' +
    '<p class="ens-note">Invite quelqu’un à regarder avec toi. Le billet peut déjà contenir un mot et 3 coups de cœur.</p>' +
    '<a class="btn btn-primary ens-sbtn" href="#/settings" data-go>Envoyer un billet</a></section>';
}

function paint() {
  if (!host || !host.isConnected || state.kind !== 'ensemble') return;
  const html = friendsCard() + activityCard() + ticketsCard();
  if (written.get(host) === html) return;
  written.set(host, html);
  rewriteKeepingFocus(host, html);
}

/** Remplit `el` (colonne latérale) et lance les deux chargements ; sans effet sur un autre montage ou un autre profil. */
export function mountEnsembleSide(el) {
  const mine = ++gen;
  host = el;
  owner = userStore.currentProfile().id;
  activityStatus = 'loading';
  freeTickets = null;
  if (!subscribed) {
    subscribed = true;
    subscribe(() => paint());
  }
  paint();
  const current = () => mine === gen && owner === userStore.currentProfile().id;
  loadActivity({ limit: 8 }).then(
    () => { if (current()) { activityStatus = 'ok'; paint(); } },
    () => { if (current()) { activityStatus = 'error'; paint(); } },
  );
  getInvites().then(
    (d) => {
      if (!current()) return;
      freeTickets = (Array.isArray(d && d.invites) ? d.invites : []).filter((i) => i.state === 'free' && !i.revokedAt).length;
      paint();
    },
    () => { /* pas de rappel de billets : la carte reste absente */ },
  );
}

detailEl.addEventListener('click', (e) => {
  if (state.kind !== 'ensemble') return;
  const btn = e.target instanceof Element ? e.target.closest('[data-ens-invite]') : null;
  if (!btn) return;
  e.preventDefault();
  void inviteToParty(btn.dataset.ensInvite);
});
