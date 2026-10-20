/* Avatar d'un invité de watch party (sans compte) : une grille d'avatars prédéfinis gratuits, dessinés localement (Héros :
 * aucune requête réseau, aucun catalogue à charger). Le choix est mémorisé sur l'appareil (localStorage) pour la prochaine
 * fois. Le serveur n'accepte que les formats de sa liste blanche : jamais d'URL ni de valeur libre. */
import { formatHero, HERO_SEEDS, parseHero } from '../data/avatars';

/** Nombre d'avatars proposés dans la grille de l'écran d'entrée. */
export const GUEST_AVATAR_COUNT = 24;

/** Avatars proposés (famille « heros »), dans un ordre fixe. */
export const GUEST_AVATARS: readonly string[] = HERO_SEEDS.slice(0, GUEST_AVATAR_COUNT).map((seed) => formatHero('heros', seed));

const KEY = 'ls.party.guest.avatar';

/** Vrai si la valeur fait partie de la grille proposée. */
export const isGuestAvatar = (value: unknown): value is string => typeof value === 'string' && GUEST_AVATARS.includes(value);

/** Avatar mémorisé sur l'appareil, ou null (rien de mémorisé, valeur hors grille, stockage bloqué). */
export function loadGuestAvatar(storage?: Pick<Storage, 'getItem'> | null): string | null {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    const value = store?.getItem(KEY);
    return isGuestAvatar(value) ? value : null;
  } catch {
    return null;
  }
}

/** Mémorise le choix pour la prochaine fois. Sans effet si la valeur est hors grille ou le stockage indisponible. */
export function saveGuestAvatar(value: string, storage?: Pick<Storage, 'setItem'> | null): void {
  if (!isGuestAvatar(value)) return;
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    store?.setItem(KEY, value);
  } catch {
    // stockage plein ou bloqué : le choix ne sera pas retenu
  }
}

/** Avatar de départ de l'écran d'entrée : le choix mémorisé, sinon le premier de la grille (jamais de grille sans sélection). */
export const initialGuestAvatar = (): string => loadGuestAvatar() ?? GUEST_AVATARS[0];

/** Avatar valide pour l'envoi au serveur, sinon undefined (le serveur garde alors la lettre sur la couleur fixe). */
export const guestAvatarToSend = (value: unknown): string | undefined => (isGuestAvatar(value) && parseHero(value) ? value : undefined);
