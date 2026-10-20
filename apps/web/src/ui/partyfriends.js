/* Invitation ciblée d'un ami dans une watch party (Social v3) : liste d'amis avec bouton « Inviter », partagée par le salon
 * d'attente et le panneau du lecteur. Les pseudos passent par esc(). Rien pour un profil enfant ni hors compte. */
import { auth, isKidProfile, isServerMode } from '../data/auth';
import { inviteFriendToParty } from '../data/socialApi';
import { getState as socialState } from '../data/socialStore';
import { UserApiError } from '../data/userApi';
import { initialsOf } from '../party/lobbyModel';
import { avatarAttrs } from './avatar-art.js';
import { toast } from './dom.js';
import { esc } from './util.js';

/** Amis déjà invités dans le salon affiché (pid). */
export const invitedPids = new Set();

/** Amis (et profils du foyer) triés : en ligne d'abord. */
export function sortedFriends() {
  const st = socialState();
  const rank = { online: 0, away: 1, dnd: 2, offline: 3 };
  return [...st.friends, ...st.household].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.handle.full.localeCompare(b.handle.full, 'fr'));
}

/** Liste des amis à inviter (HTML) ; message si le social n'est pas disponible. `attr` : nom de l'attribut des boutons (sans « data- »). */
export function friendsListHTML(attr) {
  if (isKidProfile() || !isServerMode()) return '<p class="pl-empty">Les invitations d’amis ne sont pas disponibles ici.</p>';
  const friends = sortedFriends();
  if (!friends.length) return '<p class="pl-empty">Aucun ami pour l’instant. Ajoute-en depuis la barre des amis.</p>';
  return '<ul class="pl-friends">' + friends.map((f) => {
    const done = invitedPids.has(f.pid);
    return '<li class="pl-friend"><span class="pl-av"' + avatarAttrs(f.avatar, f.avatarColor) + ' aria-hidden="true"><span class="pl-av-ini">' + esc(initialsOf(f.handle.name)) + '</span></span>' +
      '<span class="pl-friend-t"><b>' + esc(f.handle.full) + '</b><span>' + (f.status === 'offline' ? 'Hors ligne' : f.watching ? 'Regarde ' + esc(f.watching.title) : 'En ligne') + '</span></span>' +
      '<button type="button" class="pl-btn is-sec is-sm" data-' + attr + '="' + esc(f.pid) + '"' + (done ? ' disabled' : '') + '>' + (done ? 'Invité' : 'Inviter') + '</button></li>';
  }).join('') + '</ul>';
}

/** Invite l'ami `pid` dans le salon `roomId` (message dans la discussion directe et alerte en direct) ; vrai si l'invitation est partie. */
export async function inviteInto(roomId, pid) {
  const me = auth.profile ? auth.profile.id : '';
  try {
    await inviteFriendToParty(roomId, pid, me);
    invitedPids.add(pid);
    return true;
  } catch (err) {
    const code = err instanceof UserApiError ? err.code : '';
    toast(code === 'not_friend' ? 'Cette personne n’est pas dans tes amis.' : code === 'rate_limited' ? 'Trop d’invitations : réessaie dans un instant.'
      : code === 'not_member' ? 'Rejoins d’abord le salon pour inviter.' : 'Invitation impossible pour le moment.');
    return false;
  }
}
