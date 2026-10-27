import { z } from 'zod';
import { isValidHandleName, parseHandle } from './social-handles.js';
import { type CustomStatus, type FavoriteView, type HomeTitleRef, MAX_MESSAGE_PAGE, MAX_PROFILE_FAVORITES, type ProfilePatch } from './social-v2-store.js';

/** Schémas des routes sociales v2 (`/user/social/*`). Objets stricts : une clé inconnue est refusée. */

/** Statuts choisis par l'utilisateur (`invisible` : vu hors ligne par les autres). */
const SOCIAL_STATUSES = ['online', 'away', 'dnd', 'invisible'] as const;

/** Identifiant public d'un profil : 16 caractères base32 (voir social-handles.ts). */
const PID_PATTERN = /^[A-Z2-7]{16}$/;

/** Vrai si `value` a la forme d'un pid. Un pid mal formé est traité comme un pid inconnu. */
export function isPid(value: string): boolean {
  return PID_PATTERN.test(value);
}

export const statusSchema = z.strictObject({ status: z.enum(SOCIAL_STATUSES) });

/** Demande d'ami : « Nom#TAG », saisie insensible à la casse. */
export const requestSchema = z.strictObject({
  handle: z
    .string()
    .trim()
    .max(40)
    .refine((value) => parseHandle(value) !== null, 'handle:format'),
});

/** Chemin TMDB seul (`/abc123.jpg`) ou URL du CDN d'images TMDB en https (`https://image.tmdb.org/t/p/w500/abc123.jpg`). */
const TMDB_PATH_IMAGE = /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;
const TMDB_URL_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/\w+\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

/**
 * Image acceptée : chemin TMDB strict ou URL du CDN TMDB, 500 caractères au plus, sans caractère de contrôle. Tout autre
 * chemin du site, hôte, schéma ou paramètre est refusé.
 */
export function isTmdbImageRef(value: string): boolean {
  if (value.length > 500 || /\p{Cc}/u.test(value)) return false;
  return TMDB_PATH_IMAGE.test(value) || TMDB_URL_IMAGE.test(value);
}

/**
 * Affiche acceptée (voir `isTmdbImageRef`). Toute autre valeur est supprimée sans erreur : le titre en cours reste accepté,
 * sans affiche.
 */
export function cleanPoster(value: string | undefined): string | undefined {
  return value !== undefined && isTmdbImageRef(value) ? value : undefined;
}

const TMDB_ID = z.number().int().positive().max(999_999_999);
const SEASON = z.number().int().min(0).max(10_000);
const EPISODE = z.number().int().min(0).max(10_000);

/** Titre en cours de lecture (contrat `Watching`). Saison et épisode ignorés pour un film (voir store). */
const watchingSchema = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: TMDB_ID,
  imdbId: z
    .string()
    .regex(/^tt\d{1,10}$/)
    .optional(),
  title: z.string().trim().min(1).max(200),
  poster: z
    .string()
    .optional()
    .transform((value) => cleanPoster(value)),
  season: SEASON.optional(),
  episode: EPISODE.optional(),
  /** Position en secondes. */
  pos: z.number().min(0).max(10_000_000),
  duration: z.number().min(0).max(10_000_000).optional(),
  paused: z.boolean(),
  /** Instant du relevé, en millisecondes (epoch). */
  at: z.number().int().min(0).max(32_503_680_000_000),
});

/** Battement de présence : `watching` absent ou `null` = simplement en ligne. */
export const presenceSchema = z.strictObject({
  watching: watchingSchema.nullable().optional(),
});

/** Historique d'un ami : `?limit=` de 1 à 50, 20 par défaut. */
export const historyQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 20),
});

/** Accueil « ce que regardent tes amis » : `?limit=` de 1 à 50, 20 par défaut. */
export const homeWatchingQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 20),
});

/** Titre demandé à l'accueil (`movie:603` ou `series:1399`). */
const HOME_TITLE = z
  .string()
  .regex(/^(movie|series):[1-9]\d{0,8}$/)
  .transform((ref): HomeTitleRef => {
    const [type, tmdbId] = ref.split(':');
    return { type: type === 'series' ? 'series' : 'movie', tmdbId: Number(tmdbId) };
  });

/** Titres au plus par requête de progression de l'accueil. */
const MAX_HOME_TITLES = 20;

/** `?titles=movie:603,series:1399` : 1 à 20 titres, sans doublon. Absent ou mal formé : 400. */
export const homeProgressQuery = z.strictObject({
  titles: z
    .string()
    .transform((raw) => raw.split(','))
    .pipe(z.array(HOME_TITLE).min(1).max(MAX_HOME_TITLES))
    .transform((titles) => [...new Map(titles.map((title) => [`${title.type}:${title.tmdbId}`, title])).values()]),
});

/** Accueil « coups de cœur » : `?before=<ms>` (strictement plus ancien) et `?limit=` de 1 à 50, 20 par défaut. */
export const homeRecommendationsQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,13}$/)
    .transform(Number)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 20),
});

/** Coup de cœur du profil agissant (`PUT /social/recommendations`). Mot de 1 à 140 caractères après rognage des espaces de bord. */
export const recommendationSchema = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: TMDB_ID,
  title: z.string().trim().min(1).max(200),
  poster: z
    .string()
    .optional()
    .transform((value) => cleanPoster(value)),
  word: z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= 140, 'word:too_long'),
});

/** Titre visé par `DELETE /social/recommendations/:type/:tmdbId` (paramètres de chemin). */
export const recommendationKeySchema = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
});

// Messages et notes

/** Titre (contrat `MediaRef`) : saison et épisode facultatifs. */
const MEDIA_FIELDS = {
  type: z.enum(['movie', 'series']),
  tmdbId: TMDB_ID,
  season: SEASON.optional(),
  episode: EPISODE.optional(),
};

const POSITION = z.number().min(0).max(10_000_000);

/** Corps de `POST /messages/:pid`. Le texte est vérifié ensuite (longueur en caractères, contrôle) : voir `cleanMessageBody`. */
export const messageSchema = z.strictObject({
  body: z.string().max(4000),
  context: z.strictObject({ ...MEDIA_FIELDS, pos: POSITION.optional() }).optional(),
});

/** Corps de `POST /notes` : titre, position, type (texte ou emoji) et contenu (vérifié par `cleanNoteBody`). */
export const noteSchema = z.strictObject({
  ...MEDIA_FIELDS,
  pos: POSITION,
  kind: z.enum(['text', 'emoji']),
  body: z.string().max(1000),
});

/** Corps de `PATCH /notes/:id` : nouveau genre et nouveau contenu (vérifié par `cleanNoteBody`). Titre et position ne changent pas. */
export const noteEditSchema = z.strictObject({
  kind: z.enum(['text', 'emoji']),
  body: z.string().max(1000),
});

/** `?before=<createdAt ms>&limit=` des notes d'un ami : 1 à 50, 30 par défaut ; `before` exclu. */
export const friendNotesQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 30),
});

/** `?before=<createdAt ms>&limit=` : page de messages, 50 au plus (50 par défaut). */
export const messagesQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_MESSAGE_PAGE))
    .optional()
    .transform((value) => value ?? MAX_MESSAGE_PAGE),
});

/** `?type&tmdbId&season&episode` : notes d'un titre. Saison et épisode facultatifs (ignorés pour un film). */
export const notesQuery = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
  season: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().max(10_000))
    .optional(),
  episode: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().max(10_000))
    .optional(),
});

// Activité (S5)

/** Entier décimal de 1 à 3 chiffres, borné : pagination et nombre de tranches. */
const SMALL_INT = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number);

/** `?before=<at ms>&limit=` : flux d'activité, 30 par défaut, 50 au plus. */
export const activityQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: SMALL_INT.pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 30),
});

/** `?type&tmdbId&season&episode&buckets=` : carte de chaleur, 60 tranches par défaut, 200 au plus. */
export const heatmapQuery = notesQuery.extend({
  buckets: SMALL_INT.pipe(z.number().int().min(1).max(200))
    .optional()
    .transform((value) => value ?? 60),
});

/**
 * `?since=<ms>` (exclu) et titre facultatif : `type` et `tmdbId` vont ensemble, saison et épisode facultatifs.
 */
export const missedQuery = z
  .strictObject({
    since: z
      .string()
      .regex(/^\d{1,15}$/)
      .transform(Number),
    type: z.enum(['movie', 'series']).optional(),
    tmdbId: z
      .string()
      .regex(/^[1-9]\d{0,8}$/)
      .transform(Number)
      .optional(),
    season: z
      .string()
      .regex(/^\d{1,5}$/)
      .transform(Number)
      .optional(),
    episode: z
      .string()
      .regex(/^\d{1,5}$/)
      .transform(Number)
      .optional(),
  })
  .refine((query) => (query.type === undefined) === (query.tmdbId === undefined), 'media:incomplete');

export const MESSAGE_MAX_CHARS = 1000;
const NOTE_TEXT_MAX_CHARS = 140;
/** Bio du profil social, et texte du statut personnalisé (caractères). */
const BIO_MAX_CHARS = 140;
const STATUS_TEXT_MAX_CHARS = 60;

const CONTROL_CHARACTER = /\p{Cc}/u;
/** Découpage en graphèmes (un emoji composé, ZWJ, drapeau ou ton de peau, ne compte que pour un). */
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Un graphème d'emoji contient toujours un pictogramme (ou un indicateur régional pour les drapeaux). */
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Unités de code au plus pour un emoji (famille ZWJ la plus longue : 11). */
const MAX_EMOJI_CODE_UNITS = 16;

/** Vrai si `text` est exactement un emoji : un seul graphème, qui contient un pictogramme. */
export function isSingleEmoji(text: string): boolean {
  // Plafond avant segmentation : un « graphème » peut enchaîner des centaines de marques combinantes.
  if (text.length > MAX_EMOJI_CODE_UNITS) return false;
  return [...GRAPHEMES.segment(text)].length === 1 && PICTOGRAPHIC.test(text);
}

/** Problèmes d'un texte (déjà débarrassé de ses espaces de bord). Chemins seulement, jamais les valeurs. */
function textIssues(body: string, max: number, allowNewlines: boolean): string[] {
  const issues: string[] = [];
  const length = [...body].length;
  if (length === 0) issues.push('body:empty');
  else if (length > max) issues.push('body:too_long');
  if ([...body].some((ch) => CONTROL_CHARACTER.test(ch) && !(allowNewlines && ch === '\n'))) issues.push('body:control_char');
  return issues;
}

/** Texte d'un message : espaces de bord retirés, 1 à 1000 caractères, sans caractère de contrôle (saut de ligne admis). */
export function cleanMessageBody(raw: string): { body: string; issues: string[] } {
  const body = raw.trim();
  return { body, issues: textIssues(body, MESSAGE_MAX_CHARS, true) };
}

/** Contenu d'une note : texte de 1 à 140 caractères sans contrôle, ou exactement un emoji. */
export function cleanNoteBody(kind: 'text' | 'emoji', raw: string): { body: string; issues: string[] } {
  const body = raw.trim();
  if (kind === 'text') return { body, issues: textIssues(body, NOTE_TEXT_MAX_CHARS, false) };
  if (body === '') return { body, issues: ['body:empty'] };
  return { body, issues: isSingleEmoji(body) ? [] : ['body:not_emoji'] };
}

// Profil social étendu (contrat S1)

const TITLE_TYPE = z.enum(['movie', 'series']);
/** Chemin d'une image TMDB (« /xxx.jpg »), jamais une URL absolue ni un chemin réseau (« //… »). */
const BACKDROP_PATTERN = /^\/[A-Za-z0-9_-]{1,120}\.(?:jpg|jpeg|png|webp)$/i;
const PROFILE_TITLE = z.string().trim().min(1).max(200);

/** Favori du profil (`favorites` : ≤ 4, ordonnés). */
const favoriteSchema = z.strictObject({
  type: TITLE_TYPE,
  tmdbId: TMDB_ID,
  title: PROFILE_TITLE,
  poster: z.string().max(500).optional(),
});

/**
 * Corps de `PUT /user/social/profile` : tous les champs sont facultatifs ; `null` retire bio, statut ou bannière. Les
 * textes et les dates sont vérifiés ensuite par `cleanProfilePatch`.
 */
export const profilePatchSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .refine((value) => isValidHandleName(value), 'name:format')
    .optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  bio: z.string().max(1000).nullable().optional(),
  customStatus: z
    .strictObject({
      emoji: z.string().max(64).optional(),
      text: z.string().max(300).optional(),
      expiresAt: z.number().int().min(0).max(32_503_680_000_000).optional(),
    })
    .nullable()
    .optional(),
  banner: z
    .strictObject({
      type: TITLE_TYPE,
      tmdbId: TMDB_ID,
      backdrop: z.string().regex(BACKDROP_PATTERN),
      title: PROFILE_TITLE,
      posY: z.number().int().min(0).max(100).optional(),
    })
    .nullable()
    .optional(),
  favorites: z.array(favoriteSchema).max(MAX_PROFILE_FAVORITES).optional(),
});

/** Préfixe les problèmes de texte (`body:…`) par le nom du champ (`bio:…`). */
function prefixed(field: string, problems: string[]): string[] {
  return problems.map((problem) => problem.replace(/^body:/, `${field}:`));
}

/** Corps validé du profil social : la modification à appliquer, ou la liste des problèmes (chemins seulement). */
export function cleanProfilePatch(input: z.output<typeof profilePatchSchema>, now: number): { patch: ProfilePatch; issues: string[] } {
  const patch: ProfilePatch = {};
  const issues: string[] = [];
  if (input.name !== undefined) patch.name = input.name;
  if (input.avatarColor !== undefined) patch.avatarColor = input.avatarColor;

  if (input.bio !== undefined) {
    const bio = input.bio === null ? '' : input.bio.trim();
    if (bio === '') patch.bio = null;
    else {
      const problems = prefixed('bio', textIssues(bio, BIO_MAX_CHARS, false));
      issues.push(...problems);
      if (problems.length === 0) patch.bio = bio;
    }
  }

  if (input.customStatus !== undefined) {
    if (input.customStatus === null) patch.customStatus = null;
    else {
      const before = issues.length;
      const status: CustomStatus = {};
      const emoji = (input.customStatus.emoji ?? '').trim();
      const text = (input.customStatus.text ?? '').trim();
      if (emoji !== '') {
        if (isSingleEmoji(emoji)) status.emoji = emoji;
        else issues.push('customStatus.emoji:not_emoji');
      }
      if (text !== '') {
        const problems = prefixed('customStatus.text', textIssues(text, STATUS_TEXT_MAX_CHARS, false));
        issues.push(...problems);
        if (problems.length === 0) status.text = text;
      }
      if (input.customStatus.expiresAt !== undefined) {
        if (input.customStatus.expiresAt > now) status.expiresAt = input.customStatus.expiresAt;
        else issues.push('customStatus.expiresAt:past');
      }
      if (issues.length === before) {
        if (status.emoji === undefined && status.text === undefined) issues.push('customStatus:empty');
        else patch.customStatus = status;
      }
    }
  }

  if (input.banner !== undefined) {
    if (input.banner === null) patch.banner = null;
    else {
      const problems = prefixed('banner.title', textIssues(input.banner.title, 200, false));
      issues.push(...problems);
      if (problems.length === 0) {
        const { tmdbId, type, backdrop, title, posY } = input.banner;
        patch.banner = { tmdbId, type, backdrop, title, ...(posY !== undefined && posY !== 50 ? { posY } : {}) };
      }
    }
  }

  if (input.favorites !== undefined) {
    const favorites: FavoriteView[] = [];
    const seen = new Set<string>();
    input.favorites.forEach((favorite, index) => {
      const key = `${favorite.type}:${favorite.tmdbId}`;
      if (seen.has(key)) issues.push(`favorites.${index}:duplicate`);
      seen.add(key);
      issues.push(...prefixed(`favorites.${index}.title`, textIssues(favorite.title, 200, false)));
      const item: FavoriteView = { tmdbId: favorite.tmdbId, type: favorite.type, title: favorite.title };
      const poster = cleanPoster(favorite.poster);
      if (poster !== undefined) item.poster = poster;
      favorites.push(item);
    });
    patch.favorites = favorites;
  }

  return { patch, issues };
}
