import { exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * Salons (/party) depuis une session verrouillée sur un profil invité, contre le vrai Worker : toute action au nom d'un autre
 * profil du compte est refusée (403 profile_locked), et le profil verrouillé agit sans PIN. Les comptes sont créés par
 * invitations « système » (route /__admin/invite), comme dans party.test.ts.
 */

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const ADMIN = 'admin-test-secret-with-more-than-32-chars';
const PASSWORD = 'mot-de-passe-test-1';

let counter = 0;
const nextIp = (): string => `10.${Math.floor(counter / 65_000) % 250}.${Math.floor(counter / 250) % 250}.${(counter += 1) % 250}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- corps JSON dynamiques des routes testées
type Body = Record<string, any>;

async function api(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Body }> {
  const headers: Record<string, string> = { 'cf-connecting-ip': nextIp(), ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Body };
}

interface Owner {
  token: string;
  /** Profil principal (adulte) du compte. */
  profile: string;
  /** Profil adulte non principal, cible de l'invitation du foyer. */
  marie: string;
  /** Session verrouillée sur Marie (inscription via le lien du foyer). */
  locked: string;
}

let seq = 0;
/** Compte neuf avec un profil principal, un profil « Marie » et une session verrouillée sur Marie. */
async function owner(): Promise<Owner> {
  const name = `lock${++seq}${Math.floor(Math.random() * 1e6)}`;
  const invite = await api('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  expect(invite.status).toBe(200);
  expect((await api('POST', '/user/register', { body: { username: name, password: PASSWORD, invite: invite.body.code } })).status).toBe(201);
  const token = (await api('POST', '/user/login', { body: { username: name, password: PASSWORD } })).body.token as string;
  const profile = (await api('POST', '/user/profiles', { token, body: { name, avatarColor: '#aa5500' } })).body.id as string;
  const marie = (await api('POST', '/user/profiles', { token, headers: { 'x-profile-id': profile }, body: { name: 'Marie', avatarColor: '#0055aa' } })).body.id as string;
  const link = await api('POST', `/user/profiles/${marie}/household-invite`, { token, headers: { 'x-profile-id': profile }, body: {} });
  expect(link.status).toBe(201);
  const login = `marie${Math.random().toString(36).slice(2, 10)}`;
  const redeemed = await api('POST', '/user/household-invites/redeem', { body: { token: link.body.token, login, password: PASSWORD } });
  expect(redeemed.status).toBe(201);
  await api('DELETE', `/__admin/invite/${invite.body.code}`, { headers: { 'x-admin-secret': ADMIN } });
  return { token, profile, marie, locked: redeemed.body.token as string };
}

const room = {
  visibility: 'private',
  title: 'Matrix',
  poster: '/matrix.jpg',
  language: 'fr',
  media: { type: 'movie', tmdbId: 603 },
  fingerprint: { fileName: 'The.Matrix.1999.1080p.mkv', size: 8_000_000_000, hash: 'abcdef0123456789abcdef' },
};

describe('salons depuis une session verrouillée sur un profil invité', () => {
  it('POST /party : un autre profil du compte est refusé (403 profile_locked), le profil verrouillé crée le salon', async () => {
    const acc = await owner();
    const other = await api('POST', '/party', { token: acc.locked, body: { ...room, profileId: acc.profile } });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('profile_locked');

    const mine = await api('POST', '/party', { token: acc.locked, body: { ...room, profileId: acc.marie } });
    expect(mine.status).toBe(201);
  });

  it('GET /party et GET /party/:id : profileId différent refusé ; le profil verrouillé est accepté', async () => {
    const acc = await owner();
    const created = await api('POST', '/party', { token: acc.locked, body: { ...room, profileId: acc.marie } });
    const id = created.body.room.id as string;

    expect((await api('GET', `/party?profileId=${acc.profile}`, { token: acc.locked })).body.error).toBe('profile_locked');
    expect((await api('GET', `/party/${id}?profileId=${acc.profile}`, { token: acc.locked })).body.error).toBe('profile_locked');
    expect((await api('GET', `/party?profileId=${acc.marie}`, { token: acc.locked })).status).toBe(200);
    expect((await api('GET', `/party/${id}?profileId=${acc.marie}`, { token: acc.locked })).status).toBe(200);
  });

  it('POST /party/:id/join et /invite-link : profileId différent refusé (403 profile_locked)', async () => {
    const acc = await owner();
    const created = await api('POST', '/party', { token: acc.locked, body: { ...room, profileId: acc.marie } });
    const id = created.body.room.id as string;

    const join = await api('POST', `/party/${id}/join`, { token: acc.locked, body: { profileId: acc.profile } });
    expect(join.status).toBe(403);
    expect(join.body.error).toBe('profile_locked');
    const link = await api('POST', `/party/${id}/invite-link`, { token: acc.locked, body: { profileId: acc.profile } });
    expect(link.status).toBe(403);
    expect(link.body.error).toBe('profile_locked');
  });

  it('un profil protégé par PIN n’exige pas de jeton de profil à sa session verrouillée', async () => {
    const acc = await owner();
    expect((await api('PATCH', `/user/profiles/${acc.marie}`, { token: acc.token, headers: { 'x-profile-id': acc.profile }, body: { pin: '1234' } })).status).toBe(200);
    const created = await api('POST', '/party', { token: acc.locked, body: { ...room, profileId: acc.marie } });
    expect(created.status).toBe(201);
    const join = await api('POST', `/party/${created.body.room.id}/join`, { token: acc.locked, body: { profileId: acc.marie } });
    expect(join.body.error).not.toBe('pin_required');
    expect(join.status).toBe(200);
  });
});
