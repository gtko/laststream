/**
 * Lecteur invité du salon : types partagés.
 */

/**
 * Accès à un fichier distant par plages d'octets.
 * `read(start, end)` renvoie les octets [start, end) : `end` est exclu, la longueur attendue est `end - start`.
 * Un RangeClient HTTP doit donc envoyer `Range: bytes=start-(end-1)`.
 */
export interface RangeReader {
  size(): Promise<number>;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface VideoTrackInfo {
  /** Nom court du codec tel que mediabunny le rapporte : 'avc', 'hevc', 'vp8', 'vp9', 'av1'. */
  codec: string;
  /** Chaîne WebCodecs (ex. 'avc1.64001f', 'hvc1.1.6.L93.B0', 'av01.0.08M.08'). Vide si inconnue. */
  codecString: string;
  /** Extradata du décodeur (avcC, hvcC, av1C...) si le conteneur en fournit. */
  description?: Uint8Array;
  /** Dimensions codées, en pixels (0 si inconnues). */
  width: number;
  height: number;
}

export interface AudioTrackInfo {
  codec: string;
  codecString: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
}

export interface MediaInfo {
  /** Nom du conteneur tel que mediabunny le rapporte (ex. 'MP4', 'Matroska', 'WebM'). */
  container: string;
  /** Durée en secondes ; 0 si inconnue. */
  duration: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
}

/** Résultat de la vérification WebCodecs. `codec` est le libellé lisible du codec en cause. */
export type SupportResult =
  | { ok: true; reason: null; codec: null }
  | { ok: false; reason: string; codec: string };

/** Décision de lecture : décodage natif, ou format refusé avec un message à afficher. */
export type PlaybackPlan = { kind: 'native' } | { kind: 'unsupported'; message: string };

export interface PlayerState {
  playing: boolean;
  /** Position courante, en secondes. */
  position: number;
  /** Durée, en secondes ; 0 si inconnue. */
  duration: number;
}

/**
 * État du salon : `position` (s) prise à l'instant `at` (ms, horloge partagée déjà corrigée par l'appelant).
 * Si `playing`, la position attendue est extrapolée jusqu'à l'instant de comparaison.
 */
export interface RoomState {
  playing: boolean;
  position: number;
  at: number;
}

export interface PlayerStats {
  videoCodec: string | null;
  audioCodec: string | null;
  /** Images sorties du décodeur depuis le chargement. */
  decodedFrames: number;
  /** Images écartées parce que périmées avant affichage. */
  droppedFrames: number;
  /** Segments audio programmés sur WebAudio depuis le chargement. */
  audioChunks: number;
  /** Images décodées en attente d'affichage. */
  queuedFrames: number;
  /** Audio programmé d'avance, en secondes de média. */
  audioAheadSec: number;
  /** Dérive (position locale − cible du salon) de la dernière synchronisation, en secondes. */
  lastDriftSec: number;
  seeks: number;
}

export interface PlayerCallbacks {
  /** L'utilisateur (et non le salon) a lancé la lecture à cette position. */
  onUserPlay?: (position: number) => void;
  /** L'utilisateur (et non le salon) a mis en pause à cette position. */
  onUserPause?: (position: number) => void;
  /** L'utilisateur (et non le salon) a demandé un déplacement vers cette position. */
  onUserSeek?: (position: number) => void;
  onStats?: (stats: PlayerStats) => void;
  onError?: (error: Error) => void;
  onEnded?: () => void;
}
