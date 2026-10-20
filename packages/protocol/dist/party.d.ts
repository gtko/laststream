/**
 * Watch party : contrat de fil entre le serveur (lastaddon, source de vérité) et l'application (laststream-app).
 * Constantes, formes des objets échangés et unions de messages WebSocket. Le salon ne transporte jamais de lien de
 * lecture ni de donnée debrid : seulement l'identité du titre et l'empreinte de la version préférée par l'hôte.
 */
export declare const DEFAULT_MAX_PARTICIPANTS = 20;
export declare const MIN_PARTICIPANTS = 2;
export declare const MAX_PARTICIPANTS_LIMIT = 20;
export declare const MAX_ROOMS_PER_HOST = 3;
/** Durée de vie maximale d'un salon, et délai avant suppression d'un salon vide. */
export declare const ROOM_MAX_AGE_MS: number;
export declare const EMPTY_ROOM_TTL_MS: number;
/** Absence de l'hôte avant qu'un autre participant soit promu hôte. */
export declare const HOST_GRACE_MS = 60000;
export declare const CHAT_MAX_CHARS = 500;
export declare const CHAT_HISTORY = 50;
export declare const MAX_REPORTS = 50;
export declare const MAX_FRAME_BYTES = 4096;
/** Validité du ticket de connexion WebSocket. */
export declare const TICKET_TTL_MS = 60000;
/** Durée d'une séance invité (jeton signé délivré par l'hôte ou un membre). */
export declare const GUEST_SESSION_MS: number;
/** Invités sans compte connectés en même temps dans un salon. */
export declare const MAX_GUESTS = 4;
export declare const GUEST_NAME_MAX = 24;
/** Attente de tampon : avance (s) à partir de laquelle un participant se déclare prêt. Seuil côté client (le serveur ne le juge pas), diffusé dans `wait` (`resumeAhead`). */
export declare const PARTY_RESUME_AHEAD_SEC = 10;
/** Attente de tampon : délai maximal (ms) avant reprise sans les retardataires. */
export declare const PARTY_WAIT_MAX_MS = 45000;
/** Signalisation WebRTC : donnée opaque de 16 Ko au plus (UTF-8), trame de 64 Kio au plus. */
export declare const RTC_MAX_DATA_BYTES: number;
export declare const RTC_MAX_FRAME_CHARS: number;
export declare const REACTIONS: readonly ["👍", "❤️", "😂", "😮", "😢", "👏", "🔥", "🎉", "😱", "🤯"];
/** Préparation : état déclaré par chaque participant avant le départ (message `status`). */
export declare const PREP_STATUSES: readonly ["searching", "ready", "buffering"];
export type PrepStatus = (typeof PREP_STATUSES)[number];
/** Réglages du salon, modifiés par l'hôte (`settings`). Les défauts reproduisent le comportement antérieur. */
export declare const CONTROL_MODES: readonly ["all", "host"];
export type ControlMode = (typeof CONTROL_MODES)[number];
export declare const WAIT_LATE_MODES: readonly ["off", "10s", "always"];
export type WaitLateMode = (typeof WAIT_LATE_MODES)[number];
export declare const REACTION_MODES: readonly ["float", "discreet", "off"];
export type ReactionMode = (typeof REACTION_MODES)[number];
export interface PartySettings {
    control: ControlMode;
    waitLate: WaitLateMode;
    reactions: ReactionMode;
}
export declare const DEFAULT_SETTINGS: PartySettings;
/** Délai maximal (ms) d'attente de tampon selon le réglage `waitLate` ; 0 : pas d'attente. */
export declare const WAIT_LATE_MS: Record<WaitLateMode, number>;
export declare const QUALITY_MAX = 40;
export declare const COUNTDOWN_MIN_SEC = 1;
export declare const COUNTDOWN_MAX_SEC = 10;
export declare const COUNTDOWN_DEFAULT_SEC = 5;
/** Vote du titre : nombre d'options et longueur du titre proposé. */
export declare const VOTE_MIN_OPTIONS = 2;
export declare const VOTE_MAX_OPTIONS = 6;
export declare const VOTE_TITLE_MAX = 200;
/** Événements lisibles diffusés aux participants (`event`). */
export declare const EVENT_KINDS: readonly ["pause", "play", "seek", "join", "leave"];
export type EventKind = (typeof EVENT_KINDS)[number];
/** Codes de fermeture WebSocket propres au salon (4000-4999). */
export declare const CLOSE: {
    /** Salon terminé. */
    readonly ended: 4000;
    /** Jeton d'invité expiré ou invalide. */
    readonly expired: 4001;
    readonly kicked: 4003;
    /** Exclu du salon (refus de reconnexion). */
    readonly banned: 4004;
    readonly rateLimited: 4008;
    readonly replaced: 4009;
    /** Salon plein, ou quatre invités déjà connectés. */
    readonly full: 4010;
    /** Pseudo déjà pris par un autre participant. */
    readonly nameTaken: 4011;
    /** Reconnexion d'une invitation avec un autre pseudo que le premier. */
    readonly nameChanged: 4012;
};
/** Invitations émises par un salon : au plus INVITES_PER_WINDOW par INVITE_WINDOW_MS. */
export declare const INVITES_PER_WINDOW = 10;
/** Entrées d'invités par le lien partagé : au plus ENTRIES_PER_WINDOW par ENTRY_WINDOW_MS pour le salon (donc pour le lien). */
export declare const ENTRIES_PER_WINDOW = 30;
export declare const ENTRY_WINDOW_MS: number;
/** Durée pendant laquelle un jeton de séance jamais connecté réserve une place et un pseudo. */
export declare const RESERVATION_MS: number;
export declare const INVITE_WINDOW_MS: number;
/** Pseudos d'invités retenus pour la reconnexion (les plus anciens sont oubliés au-delà). */
export declare const GUEST_NAMES_MAX = 200;
export type MediaType = 'movie' | 'series';
export interface PartyMedia {
    type: MediaType;
    tmdbId: number | null;
    imdbId: string | null;
    season: number | null;
    episode: number | null;
}
/** Empreinte de la version lue par l'hôte (nom de fichier, taille, hash) : chacun choisit la source la plus proche. */
export interface Fingerprint {
    fileName: string | null;
    size: number | null;
    hash: string | null;
}
/** Position de lecture à l'instant serveur `at` (ms) ; `rev` croît à chaque changement. */
export interface PlaybackState {
    playing: boolean;
    pos: number;
    at: number;
    rev: number;
}
/** Ligne de chat telle que vue des participants : pseudo seulement, et position du film au moment de l'envoi si connue. */
export interface ChatLine {
    id: string;
    from: string;
    text: string;
    at: number;
    pos?: number;
}
/** Préparation d'un participant : prêt à lire, qualité choisie (libellé libre), état déclaré. */
export interface PrepState {
    ready: boolean;
    quality: string | null;
    status: PrepStatus;
}
/** Option d'un vote de titre, telle que proposée par l'hôte. */
export interface VoteInput {
    type: MediaType;
    tmdbId: number;
    title: string;
}
export interface VoteOption extends VoteInput {
    id: string;
}
/** Option avec son nombre de voix (aucun votant n'est identifié). */
export interface VoteView extends VoteOption {
    votes: number;
}
export interface Participant {
    username: string;
    avatarColor: string;
    avatar?: string;
    host: boolean;
    muted: boolean;
    joinedAt: number;
    /** Identifiant de connexion (aléatoire) : cible de la signalisation WebRTC. Renouvelé à chaque connexion. */
    peerId: string;
    /** Présent (true) seulement pour un invité sans compte. */
    guest?: true;
    /** Préparation (voir PrepState). */
    ready: boolean;
    quality: string | null;
    status: PrepStatus;
}
/** Vue publique d'un salon (liste, détail, jeton de connexion). */
export interface RoomInfo {
    id: string;
    visibility: 'private' | 'public';
    title: string;
    poster: string | null;
    language: string | null;
    media: PartyMedia;
    fingerprint: Fingerprint | null;
    host: string;
    participants: number;
    maxParticipants: number;
    createdAt: number;
}
export type ClientMessage = {
    t: 'ping';
    c: number;
} | {
    t: 'sync';
} | {
    t: 'ctl';
    action: 'play' | 'pause' | 'seek' | 'sync';
    pos: number;
} | {
    t: 'episode';
    season: number;
    episode: number;
    fingerprint: Fingerprint | null;
}
/** `pos` : position du film (s) au moment de l'envoi, ou null. */
 | {
    t: 'chat';
    text: string;
    pos: number | null;
}
/** Réaction signée par son auteur ; `pos` : position du film (s), ou null. */
 | {
    t: 'react';
    emoji: string;
    pos: number | null;
}
/** Réglages du salon (hôte seul) : seuls les champs présents sont modifiés. */
 | {
    t: 'settings';
    control?: ControlMode;
    waitLate?: WaitLateMode;
    reactions?: ReactionMode;
}
/** Préparation : prêt à lire (et qualité choisie, ou null). */
 | {
    t: 'ready';
    ready: boolean;
    quality: string | null;
} | {
    t: 'status';
    status: PrepStatus;
}
/** Démarrage (hôte seul) : lecture reprise après `countdown` secondes. */
 | {
    t: 'start';
    countdown: number;
}
/** Vote du titre (hôte ouvre, hôte ferme, chacun vote). */
 | {
    t: 'vote_open';
    options: VoteInput[];
} | {
    t: 'vote';
    optionId: string;
} | {
    t: 'vote_close';
} | {
    t: 'report';
    messageId: string;
    reason: string | null;
} | {
    t: 'kick';
    user: string;
} | {
    t: 'mute';
    user: string;
    muted: boolean;
} | {
    t: 'transfer';
    user: string;
} | {
    t: 'end';
}
/** Tampon : `ready` = assez d'avance pour lire ; `ahead` = secondes de tampon devant la position (0 à 600). */
 | {
    t: 'buf';
    ready: boolean;
    ahead: number;
}
/** Signalisation WebRTC (fil JSON : `{"type":"rtc","to","data"}`) ; `bytes` = taille UTF-8 de `data`, mesurée à l'analyse. */
 | {
    t: 'rtc';
    to: string;
    data: Record<string, unknown>;
    bytes: number;
};
/** Message de signalisation relayé au seul pair visé (fil JSON : `{"type":"rtc","from","data"}`). */
export interface RtcRelay {
    type: 'rtc';
    from: string;
    data: Record<string, unknown>;
}
/** Identifiants TURN éphémères (Cloudflare Realtime) : relais des liaisons WebRTC, remis à chaque participant dans `welcome`. */
export interface TurnCredentials {
    urls: string[];
    username: string;
    credential: string;
}
export type ServerMessage = {
    t: 'welcome';
    you: {
        username: string;
        host: boolean;
        muted: boolean;
        peerId: string;
    };
    room: Omit<RoomInfo, 'participants'>;
    state: PlaybackState;
    serverTime: number;
    participants: Participant[];
    chat: ChatLine[];
    settings: PartySettings;
    countdownAt: number | null;
    vote: VoteView[] | null;
    turn?: TurnCredentials;
} | {
    t: 'pong';
    c: number;
    s: number;
} | {
    t: 'state';
    state: PlaybackState;
    serverTime: number;
    by: string;
} | {
    t: 'media';
    media: PartyMedia;
    fingerprint: Fingerprint | null;
    state: PlaybackState;
    serverTime: number;
} | {
    t: 'join';
    participant: Participant;
} | {
    t: 'leave';
    user: string;
} | {
    t: 'chat';
    line: ChatLine;
}
/** Réaction signée : `by` = pseudo de l'auteur (`user` identique, gardé pour les clients antérieurs). */
 | {
    t: 'react';
    user: string;
    by: string;
    emoji: string;
    at: number;
    pos: number | null;
}
/** Réglages du salon modifiés (diffusion à tous). */
 | {
    t: 'settings';
    settings: PartySettings;
    by: string;
}
/** Préparation d'un participant modifiée. */
 | {
    t: 'prep';
    user: string;
    ready: boolean;
    quality: string | null;
    status: PrepStatus;
}
/** Compte à rebours : `at` = instant serveur (ms) où la lecture reprend ; null = annulé. */
 | {
    t: 'countdown';
    at: number | null;
    by: string;
}
/** Vote du titre : options avec leurs voix ; `open` faux à la fermeture. */
 | {
    t: 'vote';
    options: VoteView[];
    open: boolean;
}
/** Événement lisible : `delta` (s) pour un saut, négatif si l'on recule. */
 | {
    t: 'event';
    kind: EventKind;
    by: string;
    pos: number;
    delta?: number;
} | {
    t: 'muted';
    user: string;
    muted: boolean;
} | {
    t: 'host';
    user: string;
} | {
    t: 'reported';
    messageId: string;
    by?: string;
    against?: string;
    text?: string;
}
/** Message retiré par la modération du serveur : les clients le masquent. */
 | {
    t: 'removed';
    messageId: string;
}
/** Attente de tampon : pseudos des retardataires, début (ms serveur), délai maximal, et avance (s) de `buf ready` attendue. `who` vide = fin d'attente. */
 | {
    t: 'wait';
    who: string[];
    since: number;
    maxMs: number;
    resumeAhead: number;
}
/** À l'hôte seulement : le lien partagé a été renouvelé (exclusion d'un invité entré par ce lien) ; il doit en demander la nouvelle valeur. */
 | {
    t: 'link_renewed';
} | {
    t: 'error';
    code: string;
} | {
    t: 'ended';
    reason: string;
};
