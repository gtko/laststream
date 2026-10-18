import type { DatabaseSync } from 'node:sqlite';

/** Types de segments proposés par la communauté. Le générique de fin « credits » couvre aussi les films. */
export const COMMUNITY_KINDS = ['intro', 'recap', 'credits', 'postcredits'] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];

/** Une proposition masquée dès que ses votes négatifs dépassent ses votes positifs. */
const VISIBLE = 'votes_down <= votes_up';
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

  /** Durée de l'épisode la plus récemment proposée, ou undefined. */
  durationOf(imdbId: string, season: number, episode: number): number | undefined {
    const row = this.db
      .prepare('SELECT duration FROM skip_segments WHERE imdb_id = ? AND season = ? AND episode = ? ORDER BY id DESC LIMIT 1')
      .get(imdbId, season, episode);
    return row === undefined ? undefined : Number(row.duration);
  }
}
