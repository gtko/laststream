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
  return 'Le salon n’a pas accepté la connexion : lien expiré ou déjà utilisé, salon complet, ou pseudo déjà pris.';
}

/** Message de fin de salon, selon le motif reçu du client de salon. */
export function endText(reason: string): string {
  switch (reason) {
    case 'ended': return 'Le salon est terminé.';
    case 'kicked': return 'Tu as été exclu du salon.';
    case 'replaced': return 'Connexion reprise depuis un autre appareil.';
    case 'full': return 'Le salon est complet.';
    default: return 'Salon fermé.';
  }
}

/** Message d'une erreur du relais (code seulement : jamais de texte de la source). */
export function relayErrorText(code: string): string {
  switch (code) {
    case 'timeout': return 'L’hôte ne répond pas : sa lecture doit être en cours.';
    case 'unavailable': return 'Connexion à l’hôte impossible (réseau bloqué ?).';
    case 'source': return 'L’hôte n’arrive pas à lire le fichier pour le moment.';
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
