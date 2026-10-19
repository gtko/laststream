import type { SqlDb, SqlRow } from './sql.js';

/** Type de fiche partagée : film ou série (même vocabulaire que la clé R2 meta/<type>/<tmdbId>.json). */
export type MetaIndexType = 'movie' | 'series';

/** Une ligne de l'index des fiches : identifiants croisés et champs de tri/recherche. Aucune donnée personnelle. */
export interface MetaIndexRow {
  type: MetaIndexType;
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  status: string | null;
  /** Date ISO de la dernière écriture de la ligne. */
  updatedAt: string;
  /** Date de sortie du prochain épisode (AAAA-MM-JJ), séries en cours. */
  nextAirDate: string | null;
  /** Empreinte du contenu de la fiche stockée dans R2. */
  etag: string;
}

/**
 * Index des fiches partagées (table meta_index, base des données utilisateur). Écrit seulement quand le contenu d'une
 * fiche change (voir lt/meta.ts) ; lu par identifiant TMDB, IMDb ou TVDB.
 */
export class MetaStore {
  constructor(private readonly db: SqlDb) {}

  /** Insère ou met à jour la ligne d'une fiche (clé : type + identifiant TMDB). */
  upsert(row: MetaIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO meta_index (type, tmdb_id, imdb_id, tvdb_id, title, original_title, year, status, updated_at, next_air_date, etag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, tmdb_id) DO UPDATE SET
           imdb_id = excluded.imdb_id, tvdb_id = excluded.tvdb_id, title = excluded.title,
           original_title = excluded.original_title, year = excluded.year, status = excluded.status,
           updated_at = excluded.updated_at, next_air_date = excluded.next_air_date, etag = excluded.etag`,
      )
      .run(
        row.type,
        row.tmdbId,
        row.imdbId,
        row.tvdbId,
        row.title,
        row.originalTitle,
        row.year,
        row.status,
        row.updatedAt,
        row.nextAirDate,
        row.etag,
      );
  }

  /** Ligne d'une fiche par type et identifiant TMDB, ou undefined. */
  find(type: MetaIndexType, tmdbId: number): MetaIndexRow | undefined {
    const row = this.db.prepare('SELECT * FROM meta_index WHERE type = ? AND tmdb_id = ?').get(type, tmdbId);
    return row === undefined ? undefined : rowOf(row);
  }

  /** Fiches portant cet identifiant IMDb (un film ou une série par type). */
  findByImdb(imdbId: string): MetaIndexRow[] {
    return this.db
      .prepare('SELECT * FROM meta_index WHERE imdb_id = ? ORDER BY type, tmdb_id')
      .all(imdbId)
      .map(rowOf);
  }

  /** Fiches portant cet identifiant TVDB. */
  findByTvdb(tvdbId: number): MetaIndexRow[] {
    return this.db
      .prepare('SELECT * FROM meta_index WHERE tvdb_id = ? ORDER BY type, tmdb_id')
      .all(tvdbId)
      .map(rowOf);
  }
}

function rowOf(row: SqlRow): MetaIndexRow {
  return {
    type: row.type === 'series' ? 'series' : 'movie',
    tmdbId: Number(row.tmdb_id),
    imdbId: typeof row.imdb_id === 'string' ? row.imdb_id : null,
    tvdbId: row.tvdb_id === null || row.tvdb_id === undefined ? null : Number(row.tvdb_id),
    title: String(row.title),
    originalTitle: typeof row.original_title === 'string' ? row.original_title : null,
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    status: typeof row.status === 'string' ? row.status : null,
    updatedAt: String(row.updated_at),
    nextAirDate: typeof row.next_air_date === 'string' ? row.next_air_date : null,
    etag: String(row.etag),
  };
}
