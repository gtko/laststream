import { randomBytes } from 'node:crypto';
import type { UserBackend } from '../user/repo.js';
import type { ProfileRecord } from '../user/store.js';
import { UserApiError } from '../user/validation.js';
import type { PartyBackend } from './backend.js';
import { displayName, memberKey } from './keys.js';
import { type Fingerprint, MAX_ROOMS_PER_HOST, type RoomInfo, type RoomMeta } from './protocol.js';

/** Hôte d'un salon : son compte et le profil qui l'ouvre. */
export interface RoomHost {
  account: { id: string; username: string };
  profile: ProfileRecord;
}

/** Salon à créer, champs déjà validés. */
export interface NewRoom {
  visibility: 'private' | 'public';
  title: string;
  poster: string | null;
  language: string | null;
  media: { type: RoomMeta['media']['type']; tmdbId?: number; imdbId?: string; season?: number; episode?: number };
  fingerprint: Fingerprint | null;
  maxParticipants: number;
}

/**
 * Clé et pseudo de participant d'un profil dans un salon. Salon `memberKeys: 'profile'` : clé `<compte>:<profil>`, pseudo = nom
 * du compte pour le profil principal (admin().mainProfileId), `<compte> · <profil>` pour les autres. Salon ancien : clé = compte et
 * pseudo = nom du compte, comme avant.
 */
export async function participantOf(
  backend: UserBackend,
  account: { id: string; username: string },
  profile: ProfileRecord,
  mode: 'profile' | 'account',
): Promise<{ key: string; name: string }> {
  if (mode !== 'profile') return { key: account.id, name: account.username };
  const mainId = await backend.admin().mainProfileId(account.id);
  return { key: memberKey(account.id, profile.id, 'profile'), name: displayName(account.username, profile.name, mainId === null || mainId === profile.id) };
}

/**
 * Crée un salon de visionnage (route `POST /party` et ouverture d'une soirée). Limite de salons ouverts par hôte, comptés sur
 * le compte : les salons terminés sont retirés de l'annuaire au passage (429 `too_many_rooms` au plafond). 409 `room_exists`
 * si l'identifiant tiré existe déjà. Renvoie l'identifiant et la description du salon.
 */
export async function createPartyRoom(
  backend: UserBackend,
  party: PartyBackend,
  host: RoomHost,
  input: NewRoom,
): Promise<{ id: string; info: RoomInfo | null }> {
  const { account, profile } = host;
  let open = 0;
  for (const record of await backend.social().partyRoomsOf(account.id)) {
    const stub = party.room(record.id);
    if ((await stub.info()) === null) await backend.social().deletePartyRoom(record.id);
    // Un salon cédé à un autre hôte (transfert, ou relève après une absence) ne compte plus pour son créateur : il ne peut plus
    // le fermer, et son quota resterait pris jusqu'à 12 h.
    else if (stub.hostedBy === undefined || (await stub.hostedBy(account.id)) !== false) open += 1;
  }
  if (open >= MAX_ROOMS_PER_HOST) throw new UserApiError(429, 'too_many_rooms');
  const series = input.media.type === 'series';
  // Salon récent : participants identifiés par profil, pour que les profils d'un même compte coexistent.
  const member = await participantOf(backend, account, profile, 'profile');
  const meta: RoomMeta = {
    id: randomBytes(12).toString('base64url'),
    visibility: input.visibility,
    hostId: member.key,
    hostName: member.name,
    title: input.title,
    poster: input.poster,
    language: input.language,
    media: {
      type: input.media.type,
      tmdbId: input.media.tmdbId ?? null,
      imdbId: input.media.imdbId ?? null,
      season: series ? (input.media.season ?? null) : null,
      episode: series ? (input.media.episode ?? null) : null,
    },
    fingerprint: input.fingerprint,
    maxParticipants: input.maxParticipants,
    createdAt: Date.now(),
    memberKeys: 'profile',
  };
  if ((await party.room(meta.id).init(meta)) !== 'ok') throw new UserApiError(409, 'room_exists');
  await backend.social().addPartyRoom({
    id: meta.id,
    hostId: account.id,
    visibility: meta.visibility,
    title: meta.title,
    poster: meta.poster,
    language: meta.language,
    mediaType: meta.media.type,
    createdAt: new Date(meta.createdAt).toISOString(),
  });
  return { id: meta.id, info: await party.room(meta.id).info() };
}
