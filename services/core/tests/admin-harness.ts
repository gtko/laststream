/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import type { CacheAdmin, CachePrefix, CacheStat, PurgeJob } from '../src/admin/cache-types.js';
import type { AppDeps } from '../src/deps.js';
import type { PartyBackend, PartyRoomStub } from '../src/party/backend.js';
import type { UserBackend } from '../src/user/repo.js';
import { newBackend } from './admin-backend.js';
import type { RoomInfo, RoomMeta } from '../src/party/protocol.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, type Member } from './social-harness.js';
import { PASSWORD, request, type Reply, type RequestOptions } from './user-harness.js';

export { addKidProfile, inviteAndRegister, type Member } from './social-harness.js';
export { PASSWORD, request, type Reply } from './user-harness.js';

/** Limites d'administration très hautes : seuls les tests de débit les abaissent. */
export const OPEN_LIMITS = { read: 100_000, write: 100_000, elevate: 100_000 };

export interface AdminRig {
  app: RunningApp;
  owner: Member;
  /** Dépôts de l'application (amorçage direct : signalements de salons…). */
  backend: UserBackend;
  /** Appel authentifié du propriétaire ; `elevation` ajoute le jeton d'élévation. */
  call<T = Record<string, any>>(method: string, path: string, options?: RequestOptions & { elevation?: string }): Promise<Reply<T>>;
  /** Jeton d'élévation frais (mot de passe du propriétaire). */
  elevate(): Promise<string>;
}

/** Application + propriétaire (premier compte) prêts pour les tests d'administration. */
export async function startAdmin(extra: Partial<AppDeps> = {}): Promise<AdminRig> {
  const backend = newBackend();
  const app = await startApp({ extra: { adminRateLimits: OPEN_LIMITS, userBackend: backend, ...extra } });
  const owner = await bootstrapOwner(app);
  const call: AdminRig['call'] = (method, path, options = {}) => {
    const { elevation, ...rest } = options;
    const headers = { 'x-profile-id': owner.profile, ...(rest.headers ?? {}), ...(elevation === undefined ? {} : { 'x-admin-elevation': elevation }) };
    return request(app, method, path, { token: owner.token, ...rest, headers }) as never;
  };
  const elevate = async (): Promise<string> => {
    const res = await call<{ token: string }>('POST', '/admin/elevate', { body: { password: PASSWORD } });
    if (res.status !== 200) throw new Error(`élévation refusée (${res.status})`);
    return res.body.token;
  };
  return { app, owner, backend, call, elevate };
}

/** Cache d'administration simulé : compteurs par préfixe et purge qui progresse à la demande. */
export function fakeCacheAdmin(counts: Partial<Record<CachePrefix, number>> = {}): CacheAdmin & { jobs: PurgeJob[]; counts: Record<string, number>; finish(id: string): void } {
  const state = { ...counts } as Record<string, number>;
  const jobs: PurgeJob[] = [];
  const now = (): string => new Date().toISOString();
  return {
    jobs,
    counts: state,
    stats: () => Promise.resolve(['issued', 'packs', 'hosts', 'torrents', 'alldebrid'].map((prefix): CacheStat => ({ prefix, keys: state[prefix] ?? 0, exact: true }))),
    startPurge: (prefix) => {
      const running = jobs.find((job) => job.prefix === prefix && job.status === 'running');
      if (running !== undefined) return Promise.resolve(running);
      const job: PurgeJob = { id: crypto.randomUUID(), prefix, status: 'running', deleted: 0, startedAt: now(), updatedAt: now(), error: null };
      jobs.unshift(job);
      return Promise.resolve(job);
    },
    purgeJob: (id) => Promise.resolve(jobs.find((job) => job.id === id)),
    purgeJobs: () => Promise.resolve([...jobs]),
    finish(id) {
      const job = jobs.find((entry) => entry.id === id);
      if (job === undefined) return;
      job.deleted = state[job.prefix] ?? 0;
      state[job.prefix] = 0;
      job.status = 'done';
    },
  };
}

export interface FakeRoom {
  meta: RoomMeta;
  messages: string[];
}

/** Salons simulés (sans WebSocket) : suffisant pour l'annuaire, la fermeture forcée et la suppression d'un message. */
export function fakeParty(): PartyBackend & { rooms: Map<string, FakeRoom>; closures: { id: string; by: string | null }[] } {
  const rooms = new Map<string, FakeRoom>();
  const closures: { id: string; by: string | null }[] = [];
  const stub = (id: string): PartyRoomStub => ({
    connected: () => Promise.resolve(false),
    init: (meta) => {
      if (rooms.has(id)) return Promise.resolve('exists');
      rooms.set(id, { meta, messages: [] });
      return Promise.resolve('ok');
    },
    info: () => {
      const room = rooms.get(id);
      if (room === undefined) return Promise.resolve(null);
      const info: RoomInfo = {
        id,
        visibility: room.meta.visibility,
        title: room.meta.title,
        poster: room.meta.poster,
        language: room.meta.language,
        media: room.meta.media,
        fingerprint: room.meta.fingerprint,
        host: room.meta.hostName,
        participants: 2,
        maxParticipants: room.meta.maxParticipants,
        createdAt: room.meta.createdAt,
      };
      return Promise.resolve(info);
    },
    check: () => Promise.resolve(rooms.has(id) ? 'ok' : 'closed'),
    invite: () => Promise.resolve('forbidden' as const),
    inviteLink: () => Promise.resolve({ ok: false, reason: 'forbidden' } as const),
    enterGuest: () => Promise.resolve({ ok: false, reason: 'not_found' } as const),
    close: (requester) => {
      const room = rooms.get(id);
      if (room === undefined) return Promise.resolve('not_found');
      closures.push({ id, by: requester });
      rooms.delete(id);
      return Promise.resolve('ok');
    },
    reports: () => Promise.resolve('not_found'),
    deleteMessage: (messageId) => {
      const room = rooms.get(id);
      const index = room?.messages.indexOf(messageId) ?? -1;
      if (room === undefined || index === -1) return Promise.resolve('not_found');
      room.messages.splice(index, 1);
      return Promise.resolve('ok');
    },
    fetch: () => Promise.resolve(new Response(null, { status: 426 })),
  });
  return { rooms, closures, room: stub };
}
