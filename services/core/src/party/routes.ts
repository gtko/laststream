import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { type App, type Ctx, newApp } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from '../user/repo.js';
import { userErrorHandler } from '../user/routes.js';
import { assertUnlocked, sessionOf } from '../user/session.js';
import type { PartyRoomRecord } from '../user/social-store.js';
import type { ProfileRecord } from '../user/store.js';
import { mediaTypeSchema, parseWith, UserApiError } from '../user/validation.js';
import type { PartyBackend } from './backend.js';
import {
  DEFAULT_MAX_PARTICIPANTS,
  type Fingerprint,
  MAX_PARTICIPANTS_LIMIT,
  MAX_ROOMS_PER_HOST,
  MIN_PARTICIPANTS,
  parseFingerprint,
  type RoomInfo,
  type RoomMeta,
} from './protocol.js';
import { signTicket } from './ticket.js';
import { ROOM_ID } from './ws.js';

/** Point de montage de l'API des salons. */
export const PARTY_MOUNT = '/party';

const READ_LIMIT = 120;
const WRITE_LIMIT = 30;
const WINDOW_MS = 60_000;
const MAX_LIST = 50;

const POSTER = z
  .string()
  .max(300)
  .regex(/^(https?:\/\/\S+|\/[A-Za-z0-9._-]{1,100})$/);
const LANGUAGE = z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
const TMDB = z.number().int().positive().max(1_000_000_000);
const IMDB = z.string().regex(/^tt\d{1,10}$/);
const SEASON_EPISODE = z.number().int().min(0).max(10_000);

const createSchema = z.object({
  profileId: z.string().min(1).max(64),
  visibility: z.enum(['private', 'public']).default('private'),
  title: z.string().trim().min(1).max(200),
  poster: POSTER.nullable().optional(),
  language: LANGUAGE.optional(),
  media: z
    .object({ type: mediaTypeSchema, tmdbId: TMDB.optional(), imdbId: IMDB.optional(), season: SEASON_EPISODE.optional(), episode: SEASON_EPISODE.optional() })
    .refine((media) => media.tmdbId !== undefined || media.imdbId !== undefined, 'tmdbId_ou_imdbId_requis'),
  /** Version lue par l'hôte : { fileName?, size?, hash? } ; chacun résout sa propre source au plus proche. */
  fingerprint: z.unknown().optional(),
  maxParticipants: z.number().int().min(MIN_PARTICIPANTS).max(MAX_PARTICIPANTS_LIMIT).default(DEFAULT_MAX_PARTICIPANTS),
});

const joinSchema = z.object({ profileId: z.string().min(1).max(64) });
const listSchema = z.object({
  profileId: z.string().min(1).max(64).optional(),
  language: LANGUAGE.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIST))
    .optional()
    .transform((value) => value ?? 20),
  cursor: z.string().max(80).optional(),
});
const infoQuerySchema = z.object({ profileId: z.string().min(1).max(64).optional() });

/** Vue d'une ligne de l'annuaire pour la liste publique : pseudo et affiche seulement. */
function publicRow(record: PartyRoomRecord, info: RoomInfo) {
  return {
    id: record.id,
    title: record.title,
    poster: record.poster,
    language: record.language,
    mediaType: record.mediaType,
    host: record.hostUsername,
    participants: info.participants,
    maxParticipants: info.maxParticipants,
    createdAt: record.createdAt,
  };
}

/**
 * API REST des salons de visionnage, montée sous /party. Les salons vivent dans des Durable Objects (Workers seulement) :
 * sans `party`, toutes les routes répondent 501 `party_unavailable`. La connexion WebSocket (/party/:id/ws) est traitée
 * à part, avant l'application (voir ws.ts).
 */
export function registerPartyRoutes(app: App, deps: AppDeps, backend: UserBackend, party: PartyBackend | undefined): void {
  const users = () => backend.users();
  const social = () => backend.social();
  const reads = createRateLimiter(READ_LIMIT, WINDOW_MS);
  const writes = createRateLimiter(WRITE_LIMIT, WINDOW_MS);

  const router = newApp();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'OPTIONS') {
      const verdict = (c.req.method === 'GET' ? reads : writes)(c.get('ip') ?? 'inconnu');
      if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    }
    await next();
  });
  if (party === undefined) {
    router.all('*', () => {
      throw new UserApiError(501, 'party_unavailable');
    });
    router.onError(userErrorHandler);
    app.route(PARTY_MOUNT, router);
    return;
  }

  /** Profil choisi par le client (appartient au compte, déverrouillé si protégé par PIN). */
  async function profileFor(c: Ctx, profileId: string): Promise<{ account: Awaited<ReturnType<typeof sessionOf>>['account']; profile: ProfileRecord }> {
    const session = await sessionOf(users(), c);
    const profile = await users().findProfile(session.account.id, profileId);
    if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
    assertUnlocked(c, session, profile, deps.secret);
    return { account: session.account, profile };
  }

  const roomId = (c: Ctx): string => {
    const id = c.req.param('id') ?? '';
    if (!ROOM_ID.test(id)) throw new UserApiError(404, 'room_not_found');
    return id;
  };

  /** Salons publics, du plus récent au plus ancien (comptes Laststream seulement ; profils enfants refusés). */
  router.get('/', async (c) => {
    const query = parseWith(listSchema, queryParams(c));
    const session = await sessionOf(users(), c);
    if (query.profileId !== undefined) {
      const profile = await users().findProfile(session.account.id, query.profileId);
      if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
      if (profile.isKid) throw new UserApiError(403, 'kid_profile');
    }
    const page = await social().listPublicRooms({ limit: query.limit, cursor: query.cursor, language: query.language });
    const rooms: ReturnType<typeof publicRow>[] = [];
    const infos = await Promise.all(page.rooms.map((record) => party.room(record.id).info()));
    for (const [index, record] of page.rooms.entries()) {
      const info = infos[index] ?? null;
      if (info === null) {
        // Salon terminé ou expiré : retiré de l'annuaire au passage.
        await social().deletePartyRoom(record.id);
        continue;
      }
      rooms.push(publicRow(record, info));
    }
    return sendJson(c, { rooms, nextCursor: page.nextCursor });
  });

  /** Crée un salon depuis un titre ou un épisode. Public : profils non enfants seulement. */
  router.post('/', async (c) => {
    await sessionOf(users(), c); // 401 avant toute validation du corps
    const body = parseWith(createSchema, c.get('body'));
    const { account, profile } = await profileFor(c, body.profileId);
    if (body.visibility === 'public' && profile.isKid) throw new UserApiError(403, 'kid_profile');
    // Limite de salons ouverts par hôte ; les salons terminés sont retirés de l'annuaire au passage.
    let open = 0;
    for (const record of await social().partyRoomsOf(account.id)) {
      if ((await party.room(record.id).info()) === null) await social().deletePartyRoom(record.id);
      else open += 1;
    }
    if (open >= MAX_ROOMS_PER_HOST) throw new UserApiError(429, 'too_many_rooms');
    const fingerprint: Fingerprint | null = parseFingerprint(body.fingerprint);
    const series = body.media.type === 'series';
    const meta: RoomMeta = {
      id: randomBytes(12).toString('base64url'),
      visibility: body.visibility,
      hostId: account.id,
      hostName: account.username,
      title: body.title,
      poster: body.poster ?? null,
      language: body.language ?? null,
      media: {
        type: body.media.type,
        tmdbId: body.media.tmdbId ?? null,
        imdbId: body.media.imdbId ?? null,
        season: series ? (body.media.season ?? null) : null,
        episode: series ? (body.media.episode ?? null) : null,
      },
      fingerprint,
      maxParticipants: body.maxParticipants,
      createdAt: Date.now(),
    };
    if ((await party.room(meta.id).init(meta)) !== 'ok') throw new UserApiError(409, 'room_exists');
    await social().addPartyRoom({
      id: meta.id,
      hostId: account.id,
      visibility: meta.visibility,
      title: meta.title,
      poster: meta.poster,
      language: meta.language,
      mediaType: meta.media.type,
      createdAt: new Date(meta.createdAt).toISOString(),
    });
    const info = await party.room(meta.id).info();
    return sendJson(c, { room: info }, 201);
  });

  /** Détail d'un salon (un salon privé se connaît par son identifiant). `?profileId=` applique la règle des profils enfants. */
  router.get('/:id', async (c) => {
    const id = roomId(c);
    const session = await sessionOf(users(), c);
    const query = parseWith(infoQuerySchema, queryParams(c));
    const info = await party.room(id).info();
    if (info === null) throw new UserApiError(404, 'room_not_found');
    if (info.visibility === 'public' && query.profileId !== undefined) {
      const profile = await users().findProfile(session.account.id, query.profileId);
      if (profile?.isKid === true) throw new UserApiError(403, 'kid_profile');
    }
    return sendJson(c, { room: info });
  });

  /**
   * Rejoindre : vérifie le profil (enfant refusé en public), le salon (plein, exclu) puis délivre un ticket de 60 s pour
   * la WebSocket `wsPath` (même hôte). Aucune donnée debrid ni lien de lecture : le salon ne porte que le titre et
   * l'empreinte de version ; chaque participant résout sa source.
   */
  router.post('/:id/join', async (c) => {
    const id = roomId(c);
    await sessionOf(users(), c);
    const body = parseWith(joinSchema, c.get('body'));
    const { account, profile } = await profileFor(c, body.profileId);
    const stub = party.room(id);
    const info = await stub.info();
    if (info === null) throw new UserApiError(404, 'room_not_found');
    if (info.visibility === 'public' && profile.isKid) throw new UserApiError(403, 'kid_profile');
    const check = await stub.check(account.id);
    if (check === 'closed') throw new UserApiError(404, 'room_not_found');
    if (check === 'banned') throw new UserApiError(403, 'banned');
    if (check === 'room_full') throw new UserApiError(409, 'room_full');
    const { ticket, expiresAt } = signTicket(id, { accountId: account.id, username: account.username, avatarColor: profile.avatarColor, ...(profile.avatar ? { avatar: profile.avatar } : {}) }, Date.now(), deps.secret);
    return sendJson(c, { ticket, expiresAt, wsPath: `${PARTY_MOUNT}/${id}/ws?ticket=${ticket}`, room: info });
  });

  /** Termine le salon : l'hôte (ou le propriétaire du serveur). */
  router.delete('/:id', async (c) => {
    const id = roomId(c);
    const { account } = await sessionOf(users(), c);
    const result = await party.room(id).close(account.isOwner ? null : account.id);
    if (result === 'forbidden') throw new UserApiError(403, 'host_only');
    await social().deletePartyRoom(id);
    if (result === 'not_found') throw new UserApiError(404, 'room_not_found');
    return sendEmpty(c, 204);
  });

  /** Signalements de messages reçus par le salon (hôte ou propriétaire du serveur). */
  router.get('/:id/reports', async (c) => {
    const id = roomId(c);
    const { account } = await sessionOf(users(), c);
    const result = await party.room(id).reports(account.isOwner ? null : account.id);
    if (result === 'forbidden') throw new UserApiError(403, 'host_only');
    if (result === 'not_found') throw new UserApiError(404, 'room_not_found');
    return sendJson(c, { reports: result });
  });

  router.all('*', () => {
    throw new UserApiError(404, 'not_found');
  });
  router.onError(userErrorHandler);
  app.route(PARTY_MOUNT, router);
}
