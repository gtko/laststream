import type { DatabaseSync } from 'node:sqlite';

/** Types de segments proposés par la communauté. Le générique de fin « credits » couvre aussi les films. */
export const COMMUNITY_KINDS = ['intro', 'recap', 'credits', 'postcredits'] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];

/** Une proposition masquée dès que ses votes négatifs dépassent ses votes positifs ; les segments détectés (auto) n'ont pas de votes. */
const VISIBLE = "votes_down <= votes_up AND source <> 'auto'";
/** Chevauchement minimal (intersection / union) pour qu'un vote négatif vise une proposition existante. */
const DISPUTE_OVERLAP = 0.5;

/** Proposition de segment pour un épisode (saison et épisode à 0 pour un film). */
export interface Proposal {
  imdbId: string;
  season: number;
  episode: number;
  kind: CommunityKind;
  start: number;
  end: number;
  duration: number;
}

/** Segment communautaire agrégé pour un épisode et un type. */
export interface CommunitySegment {
  kind: CommunityKind;
  /** Médiane des propositions visibles, en secondes depuis le début de l'épisode. */
  start: number;
  end: number;
  /** Confiance lissée : (votes pour + 1) / (votes pour + votes contre + 2). */
  confidence: number;
}


/** Types de segments détectés automatiquement (le store communautaire n'a pas « preview »). */
export type AutoKind = CommunityKind | 'preview';
/** Méthode de détection : chapitres du conteneur, empreinte audio entre épisodes, noir et silence de fin. */
export type AutoMethod = 'chapters' | 'fingerprint' | 'blackdetect';

/** Segment détecté automatiquement, avec sa confiance. */
export interface AutoSegment {
  kind: AutoKind;
  start: number;
  end: number;
  confidence: number;
  method: AutoMethod;
}

/** Empreinte de référence d'une saison (intro ou générique) : points uint32 d'une méthode donnée. */
export interface SeasonFingerprint {
  kind: 'intro' | 'credits';
  method: string;
  points: Uint32Array;
}

/** Médiane d'une liste non vide de nombres (moyenne des deux centres si le nombre est pair). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) throw new RangeError('median : liste vide');
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) throw new RangeError('median : liste vide');
  return (lower + upper) / 2;
}

/** Intersection sur union de deux plages (0 si disjointes). */
function overlapRatio(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const shared = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (shared <= 0) return 0;
  return shared / (Math.max(aEnd, bEnd) - Math.min(aStart, bStart));
}

/**
 * Store communautaire (table skip_segments de la base utilisateur). Une proposition positive ajoute une ligne avec une
 * voix pour ; un vote négatif ajoute une voix contre aux propositions visibles qui se chevauchent.
 */
export class SkipSegmentStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Ferme la base (fichier libéré). Ne plus utiliser le store ensuite. */
  close(): void {
    this.db.close();
  }

  /** Enregistre une proposition positive (une voix pour). */
  propose(proposal: Proposal, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO skip_segments (imdb_id, season, episode, kind, "start", "end", duration, votes_up, votes_down, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'user', ?)`,
      )
      .run(
        proposal.imdbId,
        proposal.season,
        proposal.episode,
        proposal.kind,
        proposal.start,
        proposal.end,
        proposal.duration,
        nowIso,
      );
  }

  /** Vote négatif : une voix contre chaque proposition visible du même épisode et type qui chevauche la plage. */
  dispute(proposal: Proposal): number {
    const rows = this.db
      .prepare(
        `SELECT id, "start", "end" FROM skip_segments
         WHERE imdb_id = ? AND season = ? AND episode = ? AND kind = ? AND ${VISIBLE}`,
      )
      .all(proposal.imdbId, proposal.season, proposal.episode, proposal.kind);
    const hit = rows.filter(
      (row) =>
        overlapRatio(Number(row.start), Number(row.end), proposal.start, proposal.end) >= DISPUTE_OVERLAP,
    );
    if (hit.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const bump = this.db.prepare('UPDATE skip_segments SET votes_down = votes_down + 1 WHERE id = ?');
      for (const row of hit) bump.run(row.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return hit.length;
  }

  /** Segments visibles d'un épisode : médiane des propositions par type, confiance lissée. */
  segmentsFor(imdbId: string, season: number, episode: number): CommunitySegment[] {
    const rows = this.db
      .prepare(
        `SELECT kind, "start", "end", votes_up, votes_down FROM skip_segments
         WHERE imdb_id = ? AND season = ? AND episode = ? AND ${VISIBLE}`,
      )
      .all(imdbId, season, episode);
    const groups = new Map<CommunityKind, { starts: number[]; ends: number[]; up: number; down: number }>();
    for (const row of rows) {
      const kind = String(row.kind) as CommunityKind;
      const group = groups.get(kind) ?? { starts: [], ends: [], up: 0, down: 0 };
      group.starts.push(Number(row.start));
      group.ends.push(Number(row.end));
      group.up += Number(row.votes_up);
      group.down += Number(row.votes_down);
      groups.set(kind, group);
    }
    return [...groups]
      .map(([kind, group]): CommunitySegment => ({
        kind,
        start: median(group.starts),
        end: median(group.ends),
        confidence: (group.up + 1) / (group.up + group.down + 2),
      }))
      .sort((a, b) => a.start - b.start);
  }


  /**
   * Enregistre un segment détecté. Une ligne auto existante du même type est remplacée seulement si la nouvelle
   * confiance est au moins égale ; retourne vrai si le segment est enregistré.
   */
  saveAuto(imdbId: string, season: number, episode: number, duration: number, segment: AutoSegment, nowIso: string): boolean {
    const existing = this.db
      .prepare("SELECT id, confidence FROM skip_segments WHERE imdb_id = ? AND season = ? AND episode = ? AND kind = ? AND source = 'auto'")
      .all(imdbId, season, episode, segment.kind);
    if (existing.some((row) => Number(row.confidence ?? 0) > segment.confidence)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const drop = this.db.prepare('DELETE FROM skip_segments WHERE id = ?');
      for (const row of existing) drop.run(row.id);
      this.db
        .prepare(
          `INSERT INTO skip_segments (imdb_id, season, episode, kind, "start", "end", duration, votes_up, votes_down, source, created_at, confidence, method)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'auto', ?, ?, ?)`,
        )
        .run(imdbId, season, episode, segment.kind, segment.start, segment.end, duration, nowIso, segment.confidence, segment.method);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return true;
  }

  /** Segments détectés automatiquement pour un épisode. */
  autoSegmentsFor(imdbId: string, season: number, episode: number): AutoSegment[] {
    return this.db
      .prepare(
        `SELECT kind, "start", "end", confidence, method FROM skip_segments
         WHERE imdb_id = ? AND season = ? AND episode = ? AND source = 'auto' ORDER BY "start"`,
      )
      .all(imdbId, season, episode)
      .map((row) => ({
        kind: String(row.kind) as AutoKind,
        start: Number(row.start),
        end: Number(row.end),
        confidence: Number(row.confidence ?? 0),
        method: String(row.method ?? 'fingerprint') as AutoMethod,
      }));
  }

  /** Enregistre (ou remplace) l'empreinte de référence d'une saison. */
  saveFingerprint(imdbId: string, season: number, fingerprint: SeasonFingerprint, nowIso: string): void {
    const bytes = new Uint8Array(fingerprint.points.buffer, fingerprint.points.byteOffset, fingerprint.points.byteLength);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skip_fingerprints (imdb_id, season, kind, method, fp, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(imdbId, season, fingerprint.kind, fingerprint.method, bytes, nowIso);
  }

  /** Empreintes de référence d'une saison pour une méthode. */
  fingerprintsFor(imdbId: string, season: number, method: string): SeasonFingerprint[] {
    return this.db
      .prepare('SELECT kind, method, fp FROM skip_fingerprints WHERE imdb_id = ? AND season = ? AND method = ?')
      .all(imdbId, season, method)
      .flatMap((row) => {
        const blob = row.fp;
        if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) return [];
        const copy = new Uint8Array(blob);
        return [{ kind: String(row.kind) as 'intro' | 'credits', method: String(row.method), points: new Uint32Array(copy.buffer) }];
      });
  }

  /** Durée de l'épisode la plus récemment proposée, ou undefined. */
  durationOf(imdbId: string, season: number, episode: number): number | undefined {
    const row = this.db
      .prepare('SELECT duration FROM skip_segments WHERE imdb_id = ? AND season = ? AND episode = ? ORDER BY id DESC LIMIT 1')
      .get(imdbId, season, episode);
    return row === undefined ? undefined : Number(row.duration);
  }
}
