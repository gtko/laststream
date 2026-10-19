import type { ByteSourceStats, RangeReader } from './types';

/**
 * Audio décodé d'avance (s) : tient un blocage du fil principal d'environ 1 s (ramasse-miettes, minuteries ralenties
 * d'un onglet caché). Mesuré par `scripts/relay-e2e/ac3.mjs` : 1,5 s laissait un trou de ~0,5 s pour un blocage de 2 s.
 */
export const AUDIO_DECODED_AHEAD_SEC = 3.5;

/** Tampon compressé (vidéo + audio) préchargé devant la position de lecture (s). */
export const GUEST_BUFFER_TARGET_SEC = 30;

/** Borne mémoire du tampon compressé (octets, 256 Mio) : au-delà, le préchargement s'arrête. */
export const GUEST_BUFFER_MAX_BYTES = 256 * 1024 * 1024;

/** Taille d'une lecture de préchargement (octets). */
const CHUNK_BYTES = 2 * 1024 * 1024;
/** Avant de connaître la durée (lecture de l'en-tête), on ne précharge que ce volume. */
const BOOTSTRAP_BYTES = 8 * 1024 * 1024;
/** Octets conservés derrière la position (au cas où la demande reviendrait un peu en arrière). */
const BEHIND_BYTES = CHUNK_BYTES;
/** Attente avant de réessayer un préchargement en échec (ms). */
const RETRY_MS = 1000;

export interface AudioAnchor {
  /** Position média (s) au moment `clock`. */
  media: number;
  /** Instant de l'horloge audio (s) correspondant à `media`. */
  clock: number;
}

export interface SegmentPlacement {
  /** Instant de départ sur l'horloge audio (s). */
  when: number;
  /** Décalage dans le segment (s) : non nul si le segment arrive en retard. */
  offset: number;
  /** Vrai si tout le segment est déjà passé : rien à programmer. */
  skipped: boolean;
}

/**
 * Où programmer un segment audio sur l'horloge audio, sans cumul d'erreur. Le calcul part de l'image de média entière
 * `startFrame` (et non d'un instant en flottant) : deux segments contigus (startFrame(n) = startFrame(n−1) + frames(n−1))
 * sont exactement jointifs, quelle que soit leur longueur ni le nombre de segments précédents.
 * Un segment dont l'instant est passé démarre maintenant, décalé dans le segment (`offset`) : c'est le rattrapage de
 * dérive, il n'y a pas de ré-ancrage ni de dérive accumulée. S'il est entièrement passé, il est écarté (`skipped`).
 */
export function placeSegment(
  anchor: AudioAnchor,
  rate: number,
  startFrame: number,
  frames: number,
  clockNow: number,
): SegmentPlacement {
  // L'ancre reste en secondes (non arrondie) : elle s'annule entre deux segments d'un même calage.
  let when = anchor.clock + (startFrame / rate - anchor.media);
  if (when >= clockNow) return { when, offset: 0, skipped: false };
  const late = Math.min(frames, Math.round((clockNow - when) * rate));
  if (late >= frames) return { when: clockNow, offset: frames / rate, skipped: true };
  when = clockNow;
  return { when, offset: late / rate, skipped: false };
}

interface Chunk {
  start: number;
  end: number;
  bytes: Uint8Array;
}

export interface ReadAheadOptions {
  /** Avance visée (s) au débit moyen du fichier. */
  targetSec: number;
  /** Borne mémoire (octets) du tampon. */
  maxBytes: number;
  /** Taille d'un préchargement (octets). */
  chunkBytes?: number;
  now?: () => number;
}

/**
 * Tampon compressé : lit à l'avance les octets qui suivent la position de lecture, jusqu'à `targetSec` au débit moyen
 * du fichier, dans la limite de `maxBytes`. Ce qui est derrière la position est évincé. Une lecture hors du tampon
 * (saut, morceau absent) passe directement à la source : le tampon n'affecte jamais le résultat, seulement la latence.
 * La position en octets est estimée au débit moyen (exacte pour un débit constant, approximative sinon).
 */
export class ReadAheadReader implements RangeReader {
  private readonly targetSec: number;
  private readonly maxBytes: number;
  private readonly chunkBytes: number;
  private readonly now: () => number;
  private chunks: Chunk[] = [];
  private held = 0;
  /** Prochain octet à précharger : la zone [premier chunk, frontier[ est préchargée. */
  private frontier = 0;
  private bytesPerSec = 0;
  private fileSize = 0;
  private positionSec = 0;
  /** Incrémenté à chaque saut : invalide le préchargement en cours. */
  private generation = 0;
  /** Génération du préchargement en cours, ou null. */
  private activeGen: number | null = null;
  private retryAt = 0;
  private closed = false;

  constructor(
    private readonly source: RangeReader,
    options: ReadAheadOptions,
  ) {
    this.targetSec = options.targetSec;
    this.maxBytes = options.maxBytes;
    this.chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  size(): Promise<number> {
    return this.source.size();
  }

  read(start: number, end: number): Promise<Uint8Array> {
    const hit = this.find(start, end);
    if (hit) return Promise.resolve(hit);
    return this.source.read(start, end);
  }

  bytesStats(): ByteSourceStats {
    return this.source.bytesStats?.() ?? { bytesFromHost: 0, bytesFromPeers: 0 };
  }

  /** Octets actuellement conservés (borné par `maxBytes`). */
  get bufferedBytes(): number {
    return this.held;
  }

  /** Durée et taille connues (après ouverture) : fixe le débit moyen et lance le préchargement. */
  setTimeline(durationSec: number, size: number): void {
    this.fileSize = size;
    this.bytesPerSec = durationSec > 0 && size > 0 ? size / durationSec : 0;
    this.kick();
  }

  /** Secondes de média préchargées au-delà de `positionSec`. */
  aheadSec(positionSec: number): number {
    if (this.bytesPerSec <= 0) return 0;
    return Math.max(0, this.frontier / this.bytesPerSec - positionSec);
  }

  /** Position de lecture (s) : évince ce qui est derrière, repart de la position si elle est hors du tampon. */
  setPosition(positionSec: number): void {
    if (this.closed) return;
    this.positionSec = positionSec;
    if (this.bytesPerSec <= 0) return;
    const posBytes = Math.floor(Math.min(this.fileSize, Math.max(0, positionSec * this.bytesPerSec)));
    const windowStart = this.chunks.length > 0 ? this.chunks[0].start : this.frontier;
    if (posBytes < windowStart || posBytes > this.frontier) {
      this.chunks = [];
      this.held = 0;
      this.frontier = posBytes;
      this.generation++;
    } else {
      while (this.chunks.length > 0 && this.chunks[0].end <= posBytes - BEHIND_BYTES) {
        const dropped = this.chunks.shift();
        this.held -= dropped?.bytes.byteLength ?? 0;
      }
    }
    this.kick();
  }

  close(): void {
    this.closed = true;
    this.chunks = [];
    this.held = 0;
    this.generation++;
  }

  private find(start: number, end: number): Uint8Array | null {
    for (const chunk of this.chunks) {
      if (chunk.start <= start && end <= chunk.end) return chunk.bytes.slice(start - chunk.start, end - chunk.start);
    }
    return null;
  }

  private kick(): void {
    if (this.closed || this.fileSize <= 0 || this.activeGen === this.generation || this.now() < this.retryAt) return;
    const gen = this.generation;
    this.activeGen = gen;
    void this.pump(gen);
  }

  private wantsMore(): boolean {
    if (this.frontier >= this.fileSize) return false;
    if (this.held + this.chunkBytes > this.maxBytes) return false;
    if (this.bytesPerSec <= 0) return this.frontier < BOOTSTRAP_BYTES;
    return this.aheadSec(this.positionSec) < this.targetSec;
  }

  private async pump(gen: number): Promise<void> {
    try {
      while (!this.closed && gen === this.generation && this.wantsMore()) {
        const start = this.frontier;
        const end = Math.min(this.fileSize, start + this.chunkBytes);
        const bytes = await this.source.read(start, end);
        if (this.closed || gen !== this.generation) return;
        this.chunks.push({ start, end, bytes });
        this.held += bytes.byteLength;
        this.frontier = end;
      }
    } catch {
      // Préchargement en échec : on réessaie plus tard. La lecture, elle, lira directement la source.
      this.retryAt = this.now() + RETRY_MS;
    } finally {
      if (this.activeGen === gen) this.activeGen = null;
    }
  }
}
