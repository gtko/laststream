import type { FriendDto, Watching } from './socialApi';
import { UserApiError } from './userApi';

/* Textes et tris purs des fonctions sociales (testés). */

/** Message lisible d'une erreur de l'API sociale. */
export function socialErrorText(err: unknown): string {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  switch (err.code) {
    case 'network': return 'lastAddon est injoignable.';
    case 'user_not_found': return 'Aucun compte avec ce pseudo exact.';
    case 'cannot_befriend_self': return 'Tu ne peux pas t’ajouter toi-même.';
    case 'already_friends': return 'Vous êtes déjà amis.';
    case 'request_pending': return 'Une demande est déjà en attente.';
    case 'request_not_found': return 'Cette demande n’existe plus.';
    case 'friend_not_found': return 'Cet ami est introuvable.';
    case 'friend_limit_reached': return 'Limite atteinte (200 amis ou 50 demandes envoyées).';
    case 'rate_limited': return 'Trop de tentatives, réessaie dans un instant.';
    case 'kid_profile': return 'Indisponible pour un profil enfant.';
    case 'room_not_found': return 'Ce salon n’existe plus.';
    case 'room_full': return 'Le salon est complet.';
    case 'banned': return 'Tu as été exclu de ce salon.';
    case 'party_unavailable': return 'Les watch parties ne sont pas disponibles sur ce serveur.';
    case 'too_many_rooms': return 'Trois salons ouverts au plus : termine-en un d’abord.';
    default: return 'Erreur (' + err.code + ').';
  }
}

/** « Regarde Titre S2:É4 », « En ligne » ou « Hors ligne ». */
export function presenceLabel(f: Pick<FriendDto, 'status' | 'watching'>): string {
  if (f.status === 'watching' && f.watching) return 'Regarde « ' + f.watching.title + ' »' + episodeCode(f.watching);
  return f.status === 'offline' ? 'Hors ligne' : 'En ligne';
}

export function episodeCode(w: Pick<Watching, 'type' | 'season' | 'episode'>): string {
  return w.type === 'series' && w.season != null && w.episode != null ? ' S' + w.season + ':É' + w.episode : '';
}

const RANK = { watching: 0, online: 1, offline: 2 } as const;

/** Amis en train de regarder d'abord, puis en ligne, puis hors ligne (ordre alphabétique à égalité). */
export function sortFriends<T extends Pick<FriendDto, 'status' | 'username'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || a.username.localeCompare(b.username, 'fr'));
}

/** Pseudo saisi : minuscules, espaces retirés (3 à 32 caractères côté serveur). Vide si invalide. */
export function cleanUsername(raw: string): string {
  const u = raw.trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9_.-]{3,32}$/.test(u) ? u : '';
}
