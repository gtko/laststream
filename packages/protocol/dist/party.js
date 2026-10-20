/**
 * Watch party : contrat de fil entre le serveur (lastaddon, source de vérité) et l'application (laststream-app).
 * Constantes, formes des objets échangés et unions de messages WebSocket. Le salon ne transporte jamais de lien de
 * lecture ni de donnée debrid : seulement l'identité du titre et l'empreinte de la version préférée par l'hôte.
 */
export const DEFAULT_MAX_PARTICIPANTS = 20;
export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS_LIMIT = 20;
export const MAX_ROOMS_PER_HOST = 3;
/** Durée de vie maximale d'un salon, et délai avant suppression d'un salon vide. */
export const ROOM_MAX_AGE_MS = 12 * 3600_000;
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** Absence de l'hôte avant qu'un autre participant soit promu hôte. */
export const HOST_GRACE_MS = 60_000;
export const CHAT_MAX_CHARS = 500;
export const CHAT_HISTORY = 50;
export const MAX_REPORTS = 50;
export const MAX_FRAME_BYTES = 4096;
/** Validité du ticket de connexion WebSocket. */
export const TICKET_TTL_MS = 60_000;
/** Durée d'une séance invité (jeton signé délivré par l'hôte ou un membre). */
export const GUEST_SESSION_MS = 12 * 3600_000;
/** Invités sans compte connectés en même temps dans un salon. */
export const MAX_GUESTS = 4;
export const GUEST_NAME_MAX = 24;
/** Attente de tampon : avance (s) à partir de laquelle un participant se déclare prêt. Seuil côté client (le serveur ne le juge pas), diffusé dans `wait` (`resumeAhead`). */
export const PARTY_RESUME_AHEAD_SEC = 10;
/** Attente de tampon : délai maximal (ms) avant reprise sans les retardataires. */
export const PARTY_WAIT_MAX_MS = 45_000;
/** Signalisation WebRTC : donnée opaque de 16 Ko au plus (UTF-8), trame de 64 Kio au plus. */
export const RTC_MAX_DATA_BYTES = 16 * 1024;
export const RTC_MAX_FRAME_CHARS = 64 * 1024;
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '😱', '🤯'];
/** Préparation : état déclaré par chaque participant avant le départ (message `status`). */
export const PREP_STATUSES = ['searching', 'ready', 'buffering'];
/** Réglages du salon, modifiés par l'hôte (`settings`). Les défauts reproduisent le comportement antérieur. */
export const CONTROL_MODES = ['all', 'host'];
export const WAIT_LATE_MODES = ['off', '10s', 'always'];
export const REACTION_MODES = ['float', 'discreet', 'off'];
export const DEFAULT_SETTINGS = { control: 'all', waitLate: 'always', reactions: 'float' };
/** Délai maximal (ms) d'attente de tampon selon le réglage `waitLate` ; 0 : pas d'attente. */
export const WAIT_LATE_MS = { off: 0, '10s': 10_000, always: PARTY_WAIT_MAX_MS };
export const QUALITY_MAX = 40;
export const COUNTDOWN_MIN_SEC = 1;
export const COUNTDOWN_MAX_SEC = 10;
export const COUNTDOWN_DEFAULT_SEC = 5;
/** Vote du titre : nombre d'options et longueur du titre proposé. */
export const VOTE_MIN_OPTIONS = 2;
export const VOTE_MAX_OPTIONS = 6;
export const VOTE_TITLE_MAX = 200;
/** Événements lisibles diffusés aux participants (`event`). */
export const EVENT_KINDS = ['pause', 'play', 'seek', 'join', 'leave'];
/** Codes de fermeture WebSocket propres au salon (4000-4999). */
export const CLOSE = {
    /** Salon terminé. */
    ended: 4000,
    /** Jeton d'invité expiré ou invalide. */
    expired: 4001,
    kicked: 4003,
    /** Exclu du salon (refus de reconnexion). */
    banned: 4004,
    rateLimited: 4008,
    replaced: 4009,
    /** Salon plein, ou quatre invités déjà connectés. */
    full: 4010,
    /** Pseudo déjà pris par un autre participant. */
    nameTaken: 4011,
    /** Reconnexion d'une invitation avec un autre pseudo que le premier. */
    nameChanged: 4012,
};
/** Invitations émises par un salon : au plus INVITES_PER_WINDOW par INVITE_WINDOW_MS. */
export const INVITES_PER_WINDOW = 10;
/** Entrées d'invités par le lien partagé : au plus ENTRIES_PER_WINDOW par ENTRY_WINDOW_MS pour le salon (donc pour le lien). */
export const ENTRIES_PER_WINDOW = 30;
export const ENTRY_WINDOW_MS = 10 * 60_000;
/** Durée pendant laquelle un jeton de séance jamais connecté réserve une place et un pseudo. */
export const RESERVATION_MS = 2 * 60_000;
export const INVITE_WINDOW_MS = 10 * 60_000;
/** Pseudos d'invités retenus pour la reconnexion (les plus anciens sont oubliés au-delà). */
export const GUEST_NAMES_MAX = 200;
