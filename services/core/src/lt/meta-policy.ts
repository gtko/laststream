/**
 * Politique de cache des fiches partagées, version 2 (ODY-297, lot A) : clés R2 (une couche par objet), durée de vie de
 * chaque couche selon le contenu, et fraîcheur d'un objet (frais, périmé servi pendant la reconstruction, mort).
 * Module pur : le temps est toujours passé en paramètre (ms epoch), jamais lu dans l'horloge. Aucun autre module ne
 * l'importe encore ; les lots suivants le brancheront sur meta.ts.
 */

/** Version du schéma des fiches stockées : une couche par objet (base, traduction, notes, saison). */
export const SCHEMA_VERSION = 2;

/** Langues servies par les fiches (traductions). */
export const SUPPORTED_LANGS = ['fr-FR', 'en-US'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

/** Alias acceptés, comparés en minuscules. Une Map évite de lire les propriétés héritées (« constructor », « __proto__ »). */
const LANG_ALIASES: ReadonlyMap<string, Lang> = new Map<string, Lang>([
  ['fr', 'fr-FR'],
  ['fr-fr', 'fr-FR'],
  ['en', 'en-US'],
  ['en-us', 'en-US'],
]);

/** Langue servie pour une valeur demandée (insensible à la casse). Toute autre valeur, ou son absence : fr-FR. */
export function resolveLang(input?: string): Lang {
  if (typeof input !== 'string') return 'fr-FR';
  return LANG_ALIASES.get(input.toLowerCase()) ?? 'fr-FR';
}

/** Type d'objet : film ou série (`tv` dans les clés v2 ; `series` dans l'ancienne clé de meta.ts). */
export type MetaKind = 'movie' | 'tv';
/** Identifiant TMDB de l'objet. */
export type MetaId = number | string;

/** Préfixe de tous les objets d'une fiche (base, traductions, notes, et saisons pour une série). */
export function fichePrefix(kind: MetaKind, id: MetaId): string {
  return `meta/v2/${kind}/${id}/`;
}

/** Couche « base » : données indépendantes de la langue. */
export function baseKey(kind: MetaKind, id: MetaId): string {
  return `${fichePrefix(kind, id)}base.json`;
}

/** Couche « traduction » : titre, synopsis, genres… dans une langue. */
export function l10nKey(kind: MetaKind, id: MetaId, lang: Lang): string {
  return `${fichePrefix(kind, id)}l10n/${lang}.json`;
}

/** Couche « notes » : notes MDBList, sans langue. */
export function ratingsKey(kind: MetaKind, id: MetaId): string {
  return `${fichePrefix(kind, id)}ratings.json`;
}

/** Couche « saison » d'une série, dans une langue. */
export function seasonKey(id: MetaId, season: number, lang: Lang): string {
  return `${fichePrefix('tv', id)}s${season}/${lang}.json`;
}

/**
 * Ancienne clé d'une fiche (`meta/<type>/<tmdbId>.json`, avec `series` pour une série, comme metaKey de meta.ts).
 * Sert à repérer les anciens objets.
 */
export function legacyKey(kind: MetaKind, id: MetaId): string {
  return `meta/${kind === 'tv' ? 'series' : 'movie'}/${id}.json`;
}

/** Ce que la politique sait d'un objet. Dates AAAA-MM-JJ ; absente, nulle ou mal formée : inconnue. */
export interface Subject {
  kind: MetaKind;
  /** Statut TMDB (« Ended », « Canceled », « Returning Series »…). */
  status?: string;
  /** Date de sortie (films). */
  releaseDate?: string | null;
  /** Date du prochain épisode (séries en cours). */
  nextAirDate?: string | null;
  /** Date du dernier épisode diffusé (séries). */
  lastAirDate?: string | null;
  /** Série terminée selon une autre source (TVDB). */
  ended?: boolean;
  /** Fiche incomplète : une source optionnelle a échoué. */
  partial?: boolean;
}

/** Couches d'un objet : base, traduction (l10n), notes, et saison (une saison d'une série). */
export type MetaLayer = 'base' | 'l10n' | 'ratings' | 'season';
/** Couches d'une fiche de film ou de série (la saison a sa propre clé). */
type FicheLayer = Exclude<MetaLayer, 'season'>;
/** Durée de vie (ms) de chaque couche de fiche. */
type Durations = Record<FicheLayer, number>;

const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** Statuts TMDB d'une série terminée (comme meta.ts). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['Ended', 'Canceled']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const durations = (base: number, l10n: number, ratings: number): Durations => ({ base, l10n, ratings });

/** Fiche incomplète : base et traduction une heure, notes un jour. */
const PARTIAL = durations(HOUR, HOUR, DAY);
/** Film sorti depuis plus d'un an, ou série terminée ou annulée. */
const SETTLED = durations(180 * DAY, 180 * DAY, 30 * DAY);
/** Film sorti depuis moins de 90 jours. */
const RECENT_MOVIE = durations(7 * DAY, 30 * DAY, DAY);
/** Film sorti depuis 90 à 365 jours. */
const MATURE_MOVIE = durations(30 * DAY, 90 * DAY, 7 * DAY);

/** Date AAAA-MM-JJ en ms epoch (minuit UTC), ou undefined si absente, nulle ou mal formée. */
function dayMs(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string' || !DATE.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Série terminée : statut TMDB « Ended » ou « Canceled », ou drapeau `ended` (TVDB). */
function isEnded(s: Subject): boolean {
  return s.ended === true || (s.status !== undefined && ENDED_STATUSES.has(s.status));
}

/**
 * Durée de vie (ms) d'une couche d'un film ou d'une série, à l'instant `now` (ms epoch). Une fiche incomplète (`partial`)
 * expire au plus tard au bout d'une heure, ses notes au bout d'un jour.
 */
export function ttlMs(layer: MetaLayer, subject: Subject, now: number): number {
  if (subject.kind === 'movie') return movieTtl(layer === 'season' ? 'base' : layer, subject, now);
  return seriesTtl(layer, subject, now);
}

function movieTtl(layer: FicheLayer, s: Subject, now: number): number {
  const released = dayMs(s.releaseDate);
  if (released === undefined || released > now) return unreleasedTtl(layer, s, released, now);
  if (s.partial === true) return PARTIAL[layer];
  const age = now - released;
  if (age < 90 * DAY) return RECENT_MOVIE[layer];
  if (age <= 365 * DAY) return MATURE_MOVIE[layer];
  return SETTLED[layer];
}

/** Film non sorti, ou sans date de sortie : pas de notes (aucun appel MDBList) ; base et traduction suivent la sortie. */
function unreleasedTtl(layer: FicheLayer, s: Subject, released: number | undefined, now: number): number {
  if (layer === 'ratings') return 0;
  if (s.partial === true) return HOUR;
  return unreleasedBase(released, now);
}

/**
 * Fin du jour de sortie (sortie + 1 j − now), bornée à 30 j, ou à 7 j quand la sortie est à moins de 30 j ; sans date de
 * sortie : 7 j (la sortie peut être proche). Plancher d'une heure.
 */
function unreleasedBase(released: number | undefined, now: number): number {
  if (released === undefined) return 7 * DAY;
  const cap = released - now < 30 * DAY ? 7 * DAY : 30 * DAY;
  return Math.max(HOUR, Math.min(released + DAY - now, cap));
}

function seriesTtl(layer: MetaLayer, s: Subject, now: number): number {
  if (layer === 'season') return seasonTtl(s, now);
  if (s.partial === true) return PARTIAL[layer];
  if (isEnded(s)) return SETTLED[layer];
  if (layer === 'base') return nextAirTtl(s.nextAirDate, now);
  return layer === 'l10n' ? 30 * DAY : 7 * DAY;
}

/**
 * Série en cours : base jusqu'au jour du prochain épisode (+ 6 h), bornée à 6 h … 30 j ; sans date (série en pause) : 14 j.
 */
function nextAirTtl(nextAirDate: string | null | undefined, now: number): number {
  const next = dayMs(nextAirDate);
  if (next === undefined) return 14 * DAY;
  return Math.min(30 * DAY, Math.max(6 * HOUR, next + 6 * HOUR - now));
}

/**
 * Saison d'une série : la base de la série tant que la saison est à venir ou en cours. Elle passe à 180 j une fois terminée
 * depuis plus de 30 j (dernier épisode diffusé il y a plus de 30 j) et que la série ne diffuse plus (terminée, ou sans date
 * à venir). Fiche incomplète : une heure.
 */
function seasonTtl(s: Subject, now: number): number {
  if (s.partial === true) return HOUR;
  const last = dayMs(s.lastAirDate);
  const notAiring = isEnded(s) || dayMs(s.nextAirDate) === undefined;
  if (last !== undefined && last + 30 * DAY < now && notAiring) return 180 * DAY;
  return seriesTtl('base', s, now);
}

/** Âge maximal de service d'un contenu périmé (pendant la reconstruction en arrière-plan) : sa durée de vie, plafonnée à 30 j. */
export function staleCapMs(ttl: number): number {
  return Math.min(ttl, 30 * DAY);
}

/** Fraîcheur d'un objet : frais avant l'échéance ; périmé (servi pendant la reconstruction) jusqu'à `staleCapMs` ; mort au-delà. */
export type Freshness = 'fresh' | 'stale' | 'dead';

/** Fraîcheur d'un objet à `now`, pour une échéance `expiresAt` et une durée de vie `ttl` (ms). Mort : reconstruction synchrone. */
export function freshness(expiresAt: number, ttl: number, now: number): Freshness {
  if (now < expiresAt) return 'fresh';
  if (now < expiresAt + staleCapMs(ttl)) return 'stale';
  return 'dead';
}
