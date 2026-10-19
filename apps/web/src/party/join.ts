/* Invitation d'un salon : lien `<origine>/#/party/join/<id>?t=<jeton>`, pseudo de l'invité, adresse du WebSocket invité et
 * messages affichés. Fonctions pures (testées) : aucune URL n'est journalisée, et les messages ne contiennent aucune donnée
 * de la source (seulement des libellés fixes). */

export interface JoinRoute {
  roomId: string;
  token: string;
}

export const PSEUDO_MAX = 32;
const TOKEN_MIN = 8;
const TOKEN_MAX = 512;

/** `#/party/join/<id>?t=<jeton>` -> identifiant du salon et jeton, ou null si la route ne correspond pas. */
export function parseJoinHash(hash: string): JoinRoute | null {
  const m = /^#\/party\/join\/([A-Za-z0-9_-]{1,64})\?t=([^&#\s]{8,700})$/.exec(hash);
  if (!m) return null;
  let token: string;
  try {
    token = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return token.length >= TOKEN_MIN && token.length <= TOKEN_MAX ? { roomId: m[1], token } : null;
}

/** Adresse sans le jeton : `#/party/join/<id>?t=<jeton>` -> `#/party/join/<id>` ; toute autre adresse est rendue telle quelle. */
export function hashWithoutToken(hash: string): string {
  return hash.replace(/\?t=[^&#\s]*/, '');
}

/** Lien d'invitation à partir de l'origine publique de l'application. */
export function joinLinkOf(base: string, roomId: string, token: string): string {
  return base.replace(/\/+$/, '') + '/#/party/join/' + encodeURIComponent(roomId) + '?t=' + encodeURIComponent(token);
}

/** Pseudo saisi : sans espaces autour, 32 caractères au plus, sans caractères de contrôle. Null si refusé. */
export function cleanPseudo(raw: string): string | null {
  const t = raw.normalize('NFC').trim();
  if (!t || t.length > PSEUDO_MAX || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** Chemin du WebSocket invité (relatif à l'adresse du serveur). Le jeton n'apparaît que dans ce chemin. */
export function guestWsPath(roomId: string, token: string, name: string): string {
  return '/party/' + encodeURIComponent(roomId) + '/ws?t=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(name);
}

/** Message du refus : le navigateur ne montre pas le code HTTP de l'échec du WebSocket, donc on énumère les causes. */
export function refusedText(): string {
  return 'Le salon n’a pas accepté la connexion : lien expiré ou remplacé, salon complet, ou pseudo déjà pris.';
}

/** Message de fin de salon, selon le motif reçu du client de salon. */
export function endText(reason: string): string {
  switch (reason) {
    case 'ended': return 'Le salon est terminé.';
    case 'kicked': return 'Tu as été exclu du salon.';
    case 'replaced': return 'Connexion reprise depuis un autre appareil.';
    case 'full': return 'Le salon est complet.';
    case 'expired': return 'Lien expiré ou invalide : demande une nouvelle invitation à l’hôte.';
    case 'banned': return 'Tu ne peux pas rejoindre ce salon.';
    case 'name_taken': return 'Ce pseudo est déjà pris dans le salon : choisis-en un autre.';
    case 'name_changed': return 'Cette invitation est liée à un autre pseudo : rejoins avec le pseudo d’origine.';
    default: return 'Salon fermé.';
  }
}

/** Message d'une erreur du relais (code seulement : jamais de texte de la source). */
export function relayErrorText(code: string): string {
  switch (code) {
    case 'timeout': return 'L’hôte ne répond pas : sa lecture doit être en cours.';
    case 'unavailable': return 'Connexion à l’hôte impossible (réseau bloqué ?).';
    case 'source': return 'L’hôte n’arrive pas à lire le fichier pour le moment.';
    case 'unshareable': return 'Ce lien ne peut pas être partagé depuis le navigateur de l’hôte.';
    case 'busy': return 'L’hôte est très sollicité : nouvel essai en cours.';
    case 'closed': return 'La liaison avec l’hôte a été coupée.';
    case 'protocol': return 'Réponse inattendue de l’hôte.';
    default: return 'Lecture partagée impossible sur cet appareil.';
  }
}

/** Message affiché quand la liaison avec l’hôte tombe en pleine lecture. */
export function hostLostText(): string {
  return 'La liaison avec l’hôte est coupée. L’hôte doit rester en lecture.';
}

/** Message de l’invité quand l’hôte n’a pas encore de lecture partagée. */
export function waitingHostText(): string {
  return 'En attente de l’hôte : la lecture partagée démarre quand il lit le titre.';
}

/** Message après « Quitter » : l’invité peut rejoindre à nouveau avec la même invitation. */
export function leftText(): string {
  return 'Tu as quitté le salon.';
}

/* ---- Séance d'invité (lien partagé) ----
 * Le lien est le même pour tous : à l'entrée, le serveur rend un jeton de séance individuel (lié à un identifiant d'invité et au
 * pseudo attribué). Il sert aux reconnexions et vit en sessionStorage (onglet seulement), jamais en localStorage ni dans l'adresse. */

export interface GuestSession {
  sessionToken: string;
  name: string;
  /** Échéance, ISO 8601. */
  expiresAt: string;
}

const SESSION_KEY = 'ls.party.guest.';

/** Stockage de l'onglet, ou null s'il est indisponible (navigation privée, accès bloqué). */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Mémorise la séance de l'invité pour ce salon. Sans effet si le stockage est indisponible. */
export function saveGuestSession(roomId: string, session: GuestSession, storage = tabStorage()): void {
  try {
    storage?.setItem(SESSION_KEY + roomId, JSON.stringify(session));
  } catch {
    // stockage plein ou bloqué : l'invité repassera par le lien
  }
}

/** Séance mémorisée pour ce salon, si elle existe, est bien formée et n'a pas expiré (sinon elle est oubliée). */
export function loadGuestSession(roomId: string, now = Date.now(), storage = tabStorage()): GuestSession | null {
  try {
    const raw = storage?.getItem(SESSION_KEY + roomId);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GuestSession> | null;
    const valid =
      value !== null && typeof value === 'object' &&
      typeof value.sessionToken === 'string' && value.sessionToken.length >= TOKEN_MIN && value.sessionToken.length <= TOKEN_MAX &&
      typeof value.name === 'string' && cleanPseudo(value.name) !== null &&
      typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) > now;
    if (valid) return { sessionToken: value.sessionToken as string, name: value.name as string, expiresAt: value.expiresAt as string };
    storage?.removeItem(SESSION_KEY + roomId);
  } catch {
    // illisible ou stockage bloqué
  }
  return null;
}

/** Oublie la séance de l'invité (salon terminé, exclusion, jeton refusé). */
export function clearGuestSession(roomId: string, storage = tabStorage()): void {
  try {
    storage?.removeItem(SESSION_KEY + roomId);
  } catch {
    // stockage bloqué
  }
}

/** Message d'un refus à l'entrée par le lien partagé (code d'erreur du serveur, jamais de texte du serveur). */
export function entryErrorText(code: string): string {
  switch (code) {
    case 'invite_revoked': return 'Ce lien a été remplacé : demande le nouveau lien à l’hôte.';
    case 'invite_invalid': return 'Lien d’invitation invalide ou expiré : demande une nouvelle invitation à l’hôte.';
    case 'room_full':
    case 'guest_limit': return 'Le salon est complet.';
    case 'room_not_found': return 'Ce salon n’existe plus.';
    case 'too_many_entries':
    case 'rate_limited': return 'Trop d’entrées sur ce lien : réessaie dans quelques minutes.';
    case 'invalid_name': return 'Pseudo refusé : choisis-en un autre.';
    case 'network': return 'Serveur injoignable : vérifie ta connexion et réessaie.';
    default: return 'Entrée dans le salon impossible pour le moment.';
  }
}
