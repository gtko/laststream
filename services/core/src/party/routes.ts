import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { type App, type Ctx, newApp } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from '../user/repo.js';
import { userErrorHandler } from '../user/routes.js';
import { assertUnlocked, sessionOf } from '../user/session.js';
import { emitSocialEvent } from '../user/social-v2-events.js';
import { convError } from '../user/social-v2-messages-routes.js';
import { actorOf, pidParam } from '../user/social-v2-routes.js';
import type { ConvScope } from '../user/social-v2-store.js';
import type { PartyRoomRecord } from '../user/social-store.js';
import type { ProfileRecord } from '../user/store.js';
import { mediaTypeSchema, parseWith, UserApiError } from '../user/validation.js';
import type { PartyBackend } from './backend.js';
import {
  DEFAULT_MAX_PARTICIPANTS,
  GUEST_SESSION_MS,
  type Fingerprint,
  MAX_PARTICIPANTS_LIMIT,
  MAX_ROOMS_PER_HOST,
  MIN_PARTICIPANTS,
  parseFingerprint,
  type RoomInfo,
  type RoomMeta,
} from './protocol.js';
import { cleanGuestName, newGuestId, signGuestToken, signRoomInviteToken, verifyRoomInviteToken } from './guest.js';
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

const inviteLinkSchema = z.object({ profileId: z.string().min(1).max(64), rotate: z.boolean().default(false) });
const guestEntrySchema = z.object({ token: z.string().min(1).max(1024), name: z.string().min(1).max(200) });
const joinSchema = z.object({ profileId: z.string().min(1).max(64) });
const friendInviteSchema = z.object({ pid: z.string().min(1).max(64) });
/** Titre d'invitation : 200 caractères au plus, sans caractère de contrôle (contrat du message `party`). */
const inviteTitle = (title: string): string => [...title.replace(/\p{Cc}/gu, ' ').trim()].slice(0, 200).join('') || 'Salon';
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
  const socialV2 = () => backend.socialV2();
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

  /**
   * Invitation d'un ami à rejoindre le salon (`{ pid }`) : le demandeur est le profil social de l'en-tête `X-Profile-Id`, et
   * doit être connecté au salon (un invité sans compte ne peut pas inviter). La cible doit être un ami ou un profil du foyer
   * (règles de la messagerie : 400 self, 404 profile_not_found, 403 not_friend / not_allowed, blocage et `messagesFrom` compris).
   * Crée un message v3 `kind: 'party'` `{ partyId, title }` dans le DM (conversation `dm:<pid>`), et diffuse `party_invite`
   * (titre et identifiant du salon) à la cible.
   */
  async function inviteFriend(c: Ctx, id: string, raw: unknown): Promise<Response> {
    const input = parseWith(friendInviteSchema, raw);
    const me = await actorOf(c, users(), socialV2(), deps.secret);
    const target = pidParam(input.pid, 'profile_not_found');
    if (party === undefined) throw new UserApiError(501, 'party_unavailable');
    const stub = party.room(id);
    const info = await stub.info();
    if (info === null) throw new UserApiError(404, 'room_not_found');
    if (!(await stub.connected(me.accountId))) throw new UserApiError(403, 'not_member');
    const title = inviteTitle(info.title);
    const scope: ConvScope = { kind: 'dm', peer: target };
    const outcome = await socialV2().sendConvMessage(me.pid, scope, { kind: 'party', body: '', party: { partyId: id, title } }, Date.now());
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'sent') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'message', message: notice.payload });
    emitSocialEvent(deps.socialEvents, [target], {
      t: 'party_invite',
      from: { pid: me.pid, handle: me.handle, avatarColor: me.avatarColor },
      partyId: id,
      title,
    });
    return sendJson(c, { message: outcome.message }, 201);
  }

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

  /**
   * Invitation d'un visiteur sans compte : jeton signé valable 12 h, lié à ce salon. Réservé à un membre connecté du salon ;
   * même règle que pour rejoindre (profil enfant refusé en public). Le visiteur se connecte avec
   * GET /party/:id/ws?t=<token>&name=<pseudo>, sans compte.
   */
  router.post('/:id/invite', async (c) => {
    const id = roomId(c);
    await sessionOf(users(), c);
    const raw: unknown = c.get('body');
    // `{ pid }` : invitation d'un ami (voir inviteFriend). Sinon, invitation d'un visiteur sans compte (`{ profileId }`).
    if (typeof raw === 'object' && raw !== null && 'pid' in raw) return inviteFriend(c, id, raw);
    const body = parseWith(joinSchema, raw);
    const { account, profile } = await profileFor(c, body.profileId);
    const stub = party.room(id);
    const info = await stub.info();
    if (info === null) throw new UserApiError(404, 'room_not_found');
    if (info.visibility === 'public' && profile.isKid) throw new UserApiError(403, 'kid_profile');
    // Émission réservée à l'hôte connecté ; refus si quatre invités sont là ; débit par salon (voir RoomCore.inviteVerdict).
    const verdict = await stub.invite(account.id);
    if (verdict === 'not_found') throw new UserApiError(404, 'room_not_found');
    if (verdict === 'forbidden') throw new UserApiError(403, 'host_only');
    if (verdict === 'guests_full') throw new UserApiError(409, 'guests_full');
    if (verdict === 'rate_limited') throw new UserApiError(429, 'too_many_invites');
    const { token, expiresAt } = await signGuestToken(id, Date.now(), deps.secret);
    return sendJson(c, { token, expiresAt }, 201);
  });

  /**
   * Lien d'invitation partageable (un seul lien pour tous les invités, comme un lien de réunion) : jeton signé, multi-usage,
   * non lié à un pseudo, valable jusqu'à la fin du salon. Hôte connecté seulement. `rotate: true` (« Nouveau lien ») invalide
   * les liens précédents ; sans `rotate`, le lien rendu est toujours le même.
   */
  router.post('/:id/invite-link', async (c) => {
    const id = roomId(c);
    await sessionOf(users(), c);
    const body = parseWith(inviteLinkSchema, c.get('body'));
    const { account, profile } = await profileFor(c, body.profileId);
    const stub = party.room(id);
    const info = await stub.info();
    if (info === null) throw new UserApiError(404, 'room_not_found');
    if (info.visibility === 'public' && profile.isKid) throw new UserApiError(403, 'kid_profile');
    const verdict = await stub.inviteLink(account.id, body.rotate);
    if (!verdict.ok) {
      if (verdict.reason === 'not_found') throw new UserApiError(404, 'room_not_found');
      if (verdict.reason === 'forbidden') throw new UserApiError(403, 'host_only');
      throw new UserApiError(429, 'too_many_invites');
    }
    const token = await signRoomInviteToken(id, verdict.epoch, verdict.exp, deps.secret);
    return sendJson(c, { token, expiresAt: new Date(verdict.exp).toISOString() }, 201);
  });

  /**
   * Entrée d'un invité sans compte avec le lien partagé : jeton du lien + pseudo souhaité. Rend un jeton de séance
   * individuel (lié à un identifiant d'invité et au pseudo attribué, unique dans le salon) à présenter ensuite à la
   * WebSocket (`?t=<sessionToken>&name=<name>`), y compris pour se reconnecter. Sans session de compte.
   */
  router.post('/:id/guest', async (c) => {
    const id = roomId(c);
    const body = parseWith(guestEntrySchema, c.get('body'));
    const now = Date.now();
    const link = await verifyRoomInviteToken(body.token, id, now, deps.secret);
    if (link === undefined) throw new UserApiError(403, 'invite_invalid');
    const wanted = cleanGuestName(body.name);
    if (wanted === undefined) throw new UserApiError(400, 'invalid_name');
    const guestId = newGuestId();
    const verdict = await party.room(id).enterGuest(guestId, wanted, link.epoch);
    if (!verdict.ok) {
      if (verdict.reason === 'not_found') throw new UserApiError(404, 'room_not_found');
      if (verdict.reason === 'link_revoked') throw new UserApiError(403, 'invite_revoked');
      if (verdict.reason === 'rate_limited') throw new UserApiError(429, 'too_many_entries');
      if (verdict.reason === 'name_banned') throw new UserApiError(403, 'banned');
      if (verdict.reason === 'name_taken') throw new UserApiError(409, 'name_taken');
      throw new UserApiError(409, verdict.reason);
    }
    const session = await signGuestToken(id, now, deps.secret, { gid: guestId, exp: Math.min(now + GUEST_SESSION_MS, verdict.exp) });
    return sendJson(c, { sessionToken: session.token, expiresAt: session.expiresAt, name: verdict.name }, 201);
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
