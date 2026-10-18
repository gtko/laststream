import { requireBase } from './config';
import { getSession, validProfileToken } from './session';

/* Client de l'API utilisateur de lastAddon : {base}/user/… (comptes, profils, bibliothèque, progression, réglages). */

export type MediaKind = 'movie' | 'series';
export type KidMaxAge = 10 | 12 | 16 | 18;
export const KID_AGES: readonly KidMaxAge[] = [10, 12, 16, 18];

export class UserApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec?: number;
  readonly issues?: string[];

  constructor(status: number, code: string, extra: { retryAfterSec?: number; issues?: string[] } = {}) {
    super(code);
    this.name = 'UserApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = extra.retryAfterSec;
    this.issues = extra.issues;
  }
}

export interface AccountDto {
  id: string;
  username: string;
  isAdmin?: boolean;
}

export interface ProfileDto {
  id: string;
  name: string;
  avatarColor: string;
  isKid: boolean;
  kidMaxAge: KidMaxAge | null;
  hasPin: boolean;
  allowedCatalogs: string[];
  createdAt: string;
}

export interface ProfileInput {
  name: string;
  avatarColor?: string;
  isKid?: boolean;
  kidMaxAge?: KidMaxAge;
  pin?: string | null;
  /** Sections du catalogue enfant autorisées (vide : toutes sauf la TV jeunesse). */
  allowedCatalogs?: string[];
}

export type Visibility = 'private' | 'friends';

export interface LibraryItemDto {
  /** Partage : `private` par défaut. */
  visibility?: Visibility;
  type: MediaKind;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
}

export interface ContinueDto {
  type: MediaKind;
  tmdbId: number | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number | null;
  updatedAt: string;
  suggested: boolean;
}

export interface ProgressWrite {
  type: MediaKind;
  tmdbId: number;
  season?: number;
  episode?: number;
  positionSec: number;
  durationSec: number;
}

/** Évènements remontés à l'interface (session expirée, PIN requis). */
export const authEvents: { onUnauthorized: () => void; onPinRequired: (profileId: string) => void } = {
  onUnauthorized: () => undefined,
  onPinRequired: () => undefined,
};

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Route d'un profil : joint X-Profile-Token si le profil en a un de valable. */
  profileId?: string;
  anonymous?: boolean;
  bootstrapToken?: string;
  timeoutMs?: number;
  /** Préfixe de l'API (défaut `/user`) ; `/party` pour les salons. */
  prefix?: string;
}

export async function call<T>(path: string, o: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const session = getSession();
  if (!o.anonymous && session) headers.authorization = 'Bearer ' + session.token;
  if (o.profileId) {
    const pt = validProfileToken(o.profileId);
    if (pt) headers['x-profile-token'] = pt;
  }
  if (o.bootstrapToken) headers['x-bootstrap-token'] = o.bootstrapToken;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(requireBase() + (o.prefix ?? '/user') + path, { method: o.method ?? 'GET', headers, body, signal: controller.signal });
  } catch {
    throw new UserApiError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : 'http_' + res.status;
    const retry = Number(res.headers.get('retry-after'));
    const err = new UserApiError(res.status, code, {
      retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined,
      issues: Array.isArray(json?.issues) ? json.issues : undefined,
    });
    if (res.status === 401 && !o.anonymous && code === 'unauthorized') authEvents.onUnauthorized();
    if (res.status === 403 && code === 'pin_required' && o.profileId) authEvents.onPinRequired(o.profileId);
    throw err;
  }
  return json as T;
}

// ---- Comptes ----
export const register = (username: string, password: string, bootstrapToken?: string, invite?: string) =>
  call<{ account: AccountDto }>('/register', { method: 'POST', body: { username, password, ...(invite ? { invite } : {}) }, anonymous: true, bootstrapToken });
export const login = (username: string, password: string) =>
  call<{ token: string; expiresAt: string }>('/login', { method: 'POST', body: { username, password }, anonymous: true });
export const refresh = () => call<{ token: string; expiresAt: string }>('/refresh', { method: 'POST' });
export const logout = () => call<void>('/logout', { method: 'POST' });
export const me = (timeoutMs?: number) => call<{ account: AccountDto }>('/me', { timeoutMs });

// ---- Profils ----
export const listProfiles = () => call<{ profiles: ProfileDto[] }>('/profiles');
export const createProfile = (p: ProfileInput) => call<ProfileDto>('/profiles', { method: 'POST', body: p });
export const updateProfile = (id: string, patch: Partial<ProfileInput>) =>
  call<ProfileDto>('/profiles/' + encodeURIComponent(id), { method: 'PATCH', body: patch, profileId: id });
export const deleteProfile = (id: string) => call<void>('/profiles/' + encodeURIComponent(id), { method: 'DELETE', profileId: id });
export const unlockProfile = (id: string, pin: string) =>
  call<{ token: string; expiresAt: string }>('/profiles/' + encodeURIComponent(id) + '/unlock', { method: 'POST', body: { pin } });
export const lockProfile = (id: string) => call<void>('/profiles/' + encodeURIComponent(id) + '/lock', { method: 'POST' });

// ---- Suivis et notes ----
export type FollowKind = MediaKind | 'person';
export interface FollowDto {
  type: FollowKind;
  tmdbId: number;
  title?: string;
  name?: string;
  poster?: string | null;
  addedAt?: string;
}
export interface RatingDto {
  type: MediaKind;
  tmdbId: number;
  rating: number;
  title?: string;
  year?: string | number | null;
  updatedAt?: string;
}
const PF = (id: string) => '/profiles/' + encodeURIComponent(id);
export const getFollows = (id: string) => call<{ items: FollowDto[] }>(PF(id) + '/follows', { profileId: id });
export const putFollow = (id: string, type: FollowKind, tmdbId: number, body: { title?: string; poster?: string | null }) =>
  call<void>(`${PF(id)}/follows/${type}/${tmdbId}`, { method: 'PUT', body, profileId: id });
export const deleteFollow = (id: string, type: FollowKind, tmdbId: number) =>
  call<void>(`${PF(id)}/follows/${type}/${tmdbId}`, { method: 'DELETE', profileId: id });
export const getRatings = (id: string) => call<{ items: RatingDto[] }>(PF(id) + '/ratings', { profileId: id });
export const putRating = (id: string, type: MediaKind, tmdbId: number, body: { rating: number; title?: string; year?: string | null }) =>
  call<void>(`${PF(id)}/ratings/${type}/${tmdbId}`, { method: 'PUT', body, profileId: id });
export const deleteRating = (id: string, type: MediaKind, tmdbId: number) =>
  call<void>(`${PF(id)}/ratings/${type}/${tmdbId}`, { method: 'DELETE', profileId: id });

// ---- « Vu » (films et épisodes) ----
export interface WatchedEpisode {
  season: number;
  episode: number;
}
export interface WatchedDto {
  movie?: boolean;
  episodes?: Array<WatchedEpisode & { finished?: boolean; positionSec?: number; durationSec?: number }>;
}
export const putWatched = (id: string, body: { type: MediaKind; tmdbId: number; imdbId?: string; episodes?: WatchedEpisode[]; watched: boolean }) =>
  call<void>('/profiles/' + encodeURIComponent(id) + '/watched', { method: 'PUT', body, profileId: id });
export const getWatched = (id: string, type: MediaKind, tmdbId: number) =>
  call<WatchedDto>('/profiles/' + encodeURIComponent(id) + '/watched/' + type + '/' + tmdbId, { profileId: id });

// ---- Bibliothèque, progression, réglages d'un profil ----
const P = (id: string) => '/profiles/' + encodeURIComponent(id);
export const getLibrary = (id: string) => call<{ items: LibraryItemDto[] }>(P(id) + '/library', { profileId: id });
export const putLibrary = (id: string, type: MediaKind, tmdbId: number, body: { title: string; poster?: string | null; imdbId?: string }) =>
  call<void>(`${P(id)}/library/${type}/${tmdbId}`, { method: 'PUT', body, profileId: id });
export const deleteLibrary = (id: string, type: MediaKind, tmdbId: number) =>
  call<void>(`${P(id)}/library/${type}/${tmdbId}`, { method: 'DELETE', profileId: id });
export const putProgress = (id: string, p: ProgressWrite) => call<unknown>(P(id) + '/progress', { method: 'PUT', body: p, profileId: id });
export const deleteContinue = (id: string, type: MediaKind, tmdbId: number) =>
  call<void>(`${'/profiles/' + encodeURIComponent(id)}/continue/${type}/${tmdbId}`, { method: 'DELETE', profileId: id });
export const getContinue = (id: string) => call<{ items: ContinueDto[] }>(P(id) + '/continue', { profileId: id });
export const getTitleProgress = (id: string, type: MediaKind, tmdbId: number) =>
  call<{ items: Array<{ season: number | null; episode: number | null; positionSec: number; durationSec: number; finished: boolean }> }>(`${P(id)}/progress/${type}/${tmdbId}`, { profileId: id });
export const getSettings = (id: string) => call<{ settings: Record<string, unknown> }>(P(id) + '/settings', { profileId: id });
export const putSettings = (id: string, settings: Record<string, unknown>) =>
  call<{ settings: Record<string, unknown> }>(P(id) + '/settings', { method: 'PUT', body: settings, profileId: id });
export const importStremio = (id: string, email: string, password: string, config?: string) =>
  call<Record<string, unknown>>(P(id) + '/import/stremio', { method: 'POST', body: { email, password, config }, profileId: id, timeoutMs: 120_000 });
