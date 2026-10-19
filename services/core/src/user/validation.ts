import { z } from 'zod';
import { KID_MAX_AGES } from './store.js';
import { ALL_AVATAR_COLLECTIONS, KID_AVATAR_COLLECTIONS } from './avatar-collections.js';
import { AVATAR_COLLECTION_PATTERN, AVATAR_MAX_LENGTH, AVATAR_PATTERN, collectionOfAvatar } from './avatar.js';

/** Erreur de l'API utilisateur : statut HTTP, code stable, et chemins des champs invalides (jamais leurs valeurs). */
export class UserApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: string[] | undefined;
  /** Secondes avant nouvelle tentative (en-tête Retry-After), si pertinent. */
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, issues?: string[], retryAfterSec?: number) {
    super(code);
    this.name = 'UserApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Avatar `col:<colId>:<charId>` : la collection doit être publiée et, sur un profil enfant, autorisée aux enfants. Les
 * formats dicebear et hero ne sont pas concernés ; un avatar absent ou nul n'a rien à vérifier.
 */
export function assertAvatarAllowed(avatar: string | null | undefined, isKid: boolean): void {
  if (avatar === null || avatar === undefined) return;
  const colId = collectionOfAvatar(avatar);
  if (colId === undefined) return;
  if (!ALL_AVATAR_COLLECTIONS.has(colId)) throw new UserApiError(400, 'invalid_avatar');
  if (isKid && !KID_AVATAR_COLLECTIONS.has(colId)) throw new UserApiError(400, 'avatar_not_allowed_for_kid');
}

/** Valide un corps ou des paramètres ; l'erreur ne renvoie que les chemins et codes des problèmes. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(racine)'}:${issue.code}`);
    throw new UserApiError(400, 'invalid_body', issues);
  }
  return result.data as z.output<S>;
}

const USERNAME = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, 'nom : 3 à 32 caractères (a-z, 0-9, _ . -)');
const PASSWORD = z.string().min(8).max(256);
const PIN = z.string().regex(/^\d{4}$/);
const AVATAR_COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Avatar illustré : `dicebear:<style>:<graine>`, `hero:<famille>:<graine>` ou `col:<colId>:<charId>` (collection connue, voir assertAvatarAllowed). */
const AVATAR = z
  .string()
  .max(AVATAR_MAX_LENGTH)
  .refine((value) => AVATAR_PATTERN.test(value) || AVATAR_COLLECTION_PATTERN.test(value), 'avatar : format inconnu');
const KID_AGE = z.literal([...KID_MAX_AGES]);
const CATALOGS = z.array(z.string().trim().min(1).max(64)).max(50);
const IMDB_ID = z.string().regex(/^tt\d{1,10}$/);
const HTTP_URL = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url : http ou https attendu');
const MEDIA_TYPE = z.enum(['movie', 'series']);
export const mediaTypeSchema = MEDIA_TYPE;
const SEASON_OR_EPISODE = z.number().int().min(0).max(10_000);
const TMDB_ID = z.number().int().positive().max(1_000_000_000);

export const credentialsSchema = z.object({ username: USERNAME, password: PASSWORD });

/** Code d'un lien de parrainage (22 caractères base64url ; plage large pour ne rien révéler du format). */
export const INVITE_CODE = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** Inscription : identifiants + lien de parrainage (absent seulement pour le tout premier compte). */
export const registerSchema = credentialsSchema.extend({ invite: INVITE_CODE.optional() });

export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(40),
  avatarColor: AVATAR_COLOR.default('#3b82f6'),
  avatar: AVATAR.optional(),
  isKid: z.boolean().default(false),
  kidMaxAge: KID_AGE.optional(),
  pin: PIN.optional(),
  allowedCatalogs: CATALOGS.default([]),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  avatarColor: AVATAR_COLOR.optional(),
  /** `null` retire l'avatar illustré (retour à l'initiale sur la couleur). */
  avatar: AVATAR.nullable().optional(),
  isKid: z.boolean().optional(),
  kidMaxAge: KID_AGE.optional(),
  /** `null` retire le PIN ; une chaîne le remplace. */
  pin: PIN.nullable().optional(),
  allowedCatalogs: CATALOGS.optional(),
});

export const pinSchema = z.object({ pin: PIN });

export const passwordChangeSchema = z.object({ current: z.string().min(1).max(256), next: PASSWORD });

/** Réinitialisation par lien à usage unique : jeton (43 caractères base64url) et nouveau mot de passe. */
export const passwordResetSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: PASSWORD });

export const deleteAccountSchema = z.object({ password: z.string().min(1).max(256) });

export const librarySortSchema = z.object({
  type: MEDIA_TYPE.optional(),
  sort: z.enum(['added', 'title']).default('added'),
});

export const libraryWriteSchema = z.object({
  imdbId: IMDB_ID.optional(),
  title: z.string().trim().min(1).max(200),
  poster: HTTP_URL.nullable().optional(),
});

export const progressWriteSchema = z.object({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID.optional(),
  imdbId: IMDB_ID.optional(),
  season: SEASON_OR_EPISODE.optional(),
  episode: SEASON_OR_EPISODE.optional(),
  positionSec: z.number().finite().min(0).max(1_000_000),
  durationSec: z.number().finite().min(0).max(1_000_000),
});

/** Nombre maximal d'épisodes dans une écriture « vu / non vu » (une saison entière tient largement). */
export const MAX_WATCHED_EPISODES = 2000;

const EPISODE_REF = z.object({ season: SEASON_OR_EPISODE, episode: SEASON_OR_EPISODE });

/** Vu / non vu : un film, ou une liste d'épisodes (la saison 0 n'est écrite que si elle est listée). */
export const watchedWriteSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('movie'), tmdbId: TMDB_ID.optional(), imdbId: IMDB_ID.optional(), watched: z.boolean() }),
    z.object({
      type: z.literal('series'),
      tmdbId: TMDB_ID.optional(),
      imdbId: IMDB_ID.optional(),
      episodes: z.array(EPISODE_REF).min(1).max(MAX_WATCHED_EPISODES),
      watched: z.boolean(),
    }),
  ])
  .refine((body) => body.tmdbId !== undefined || body.imdbId !== undefined, 'tmdbId_ou_imdbId_requis');

/** Suivi d'un titre ou d'une personne (`person` : pas de saison, pas de notification par épisode). */
export const followWriteSchema = z.object({
  imdbId: IMDB_ID.optional(),
  title: z.string().trim().min(1).max(200),
  poster: HTTP_URL.nullable().optional(),
  notify: z.boolean().default(false),
});

/** Note de 0 à 5 par pas de 0,5 (demi-étoiles). */
const RATING = z
  .number()
  .min(0)
  .max(5)
  .refine((value) => Number.isInteger(value * 2), 'pas_de_demi_etoile');

export const ratingWriteSchema = z.object({
  rating: RATING,
  imdbId: IMDB_ID.optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const followTypeSchema = z.enum(['movie', 'series', 'person']);

export const ratingsQuerySchema = z.object({ type: MEDIA_TYPE.optional() });

export const stremioImportSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(512),
  config: z.string().min(1).max(128 * 1024).optional(),
});

/** Paramètre `:itemId` d'un titre de bibliothèque : identifiant TMDB (chiffres) ou IMDb (tt…). */
export const titleIdParam = z.union([z.string().regex(/^\d{1,10}$/), z.string().regex(/^tt\d{1,10}$/)]);

export const tmdbIdParam = z.string().regex(/^\d{1,10}$/).transform(Number).pipe(TMDB_ID);
