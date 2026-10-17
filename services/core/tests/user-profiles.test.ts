import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request } from './user-harness.js';

interface ProfileBody {
  id: string;
  name: string;
  avatarColor: string;
  isKid: boolean;
  kidMaxAge: number | null;
  hasPin: boolean;
  allowedCatalogs: string[];
  createdAt: string;
  pinHash?: unknown;
}

interface UnlockBody {
  token: string;
  expiresAt: string;
}

let app: RunningApp;
let alice: string;
let bob: string;

beforeEach(async () => {
  vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
  app = await startApp({});
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  await request(app, 'POST', '/user/register', { body: { username: 'bob', password: PASSWORD } });
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await app.close();
});

async function createProfile(body: Record<string, unknown>, token = alice) {
  return request<ProfileBody | ErrorBody>(app, 'POST', '/user/profiles', { token, body });
}

async function unlock(profileId: string, pin: string, token = alice) {
  return request<UnlockBody | ErrorBody>(app, 'POST', `/user/profiles/${profileId}/unlock`, { token, body: { pin } });
}

describe('profils : création et lecture', () => {
  it('crée un profil avec les valeurs par défaut, sans jamais renvoyer le hash du PIN', async () => {
    const res = await createProfile({ name: 'Greg' });
    expect(res.status).toBe(201);
    const profile = res.body as ProfileBody;
    expect(profile).toMatchObject({
      name: 'Greg',
      avatarColor: '#3b82f6',
      isKid: false,
      kidMaxAge: null,
      hasPin: false,
      allowedCatalogs: [],
    });
    expect(profile).not.toHaveProperty('pinHash');
    expect(profile).not.toHaveProperty('accountId');
  });

  it('profil enfant : âge maximum par défaut 12, valeurs hors liste refusées', async () => {
    const kid = (await createProfile({ name: 'Enfant', isKid: true })).body as ProfileBody;
    expect(kid.kidMaxAge).toBe(12);
    expect((await createProfile({ name: 'Enfant', isKid: true, kidMaxAge: 13 })).status).toBe(400);
    const teen = (await createProfile({ name: 'Ado', isKid: true, kidMaxAge: 16 })).body as ProfileBody;
    expect(teen.kidMaxAge).toBe(16);
  });

  it('PIN à 4 chiffres : profil marqué hasPin, PIN invalide refusé', async () => {
    const res = await createProfile({ name: 'Protégé', pin: '4321' });
    expect((res.body as ProfileBody).hasPin).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('4321');
    expect((await createProfile({ name: 'X', pin: '12a4' })).status).toBe(400);
  });

  it('liste ne renvoie que les profils du compte connecté', async () => {
    await createProfile({ name: 'Alice 1' });
    await createProfile({ name: 'Bob 1' }, bob);
    const mine = await request<{ profiles: ProfileBody[] }>(app, 'GET', '/user/profiles', { token: alice });
    expect(mine.body.profiles.map((profile) => profile.name)).toEqual(['Alice 1']);
  });

  it('profil d un autre compte : 404 profile_not_found, comme un profil inexistant', async () => {
    const own = (await createProfile({ name: 'Alice' })).body as ProfileBody;
    const other = await request<ErrorBody>(app, 'GET', `/user/profiles/${own.id}/library`, { token: bob });
    const missing = await request<ErrorBody>(app, 'GET', '/user/profiles/inconnu/library', { token: alice });
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'profile_not_found' });
    expect(missing.body).toEqual(other.body);
  });

  it('sans jeton : 401 sur toutes les routes profil', async () => {
    const res = await request(app, 'GET', '/user/profiles');
    expect(res.status).toBe(401);
  });
});

describe('profils : modification et suppression', () => {
  it('PATCH modifie les champs fournis et repasse isKid à false : âge maximum remis à null', async () => {
    const profile = (await createProfile({ name: 'Enfant', isKid: true, kidMaxAge: 10 })).body as ProfileBody;
    const res = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${profile.id}`, {
      token: alice,
      body: { name: 'Petit', isKid: false, allowedCatalogs: ['films'] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Petit', isKid: false, kidMaxAge: null, allowedCatalogs: ['films'] });
  });

  it('PATCH sur le profil d un autre compte : 404', async () => {
    const profile = (await createProfile({ name: 'Alice' })).body as ProfileBody;
    const res = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${profile.id}`, { token: bob, body: { name: 'Piraté' } });
    expect(res.status).toBe(404);
  });

  it('profil protégé par PIN : modification sans jeton de déverrouillage refusée (403 pin_required)', async () => {
    const profile = (await createProfile({ name: 'Protégé', pin: '1111' })).body as ProfileBody;
    const patch = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${profile.id}`, { token: alice, body: { name: 'Autre' } });
    const del = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${profile.id}`, { token: alice });
    expect(patch.status).toBe(403);
    expect(patch.body).toEqual({ error: 'pin_required' });
    expect(del.status).toBe(403);
  });

  it('déverrouillage : mauvais PIN 403, profil sans PIN 409, bon PIN : jeton de 30 jours', async () => {
    const protectedProfile = (await createProfile({ name: 'Protégé', pin: '1111' })).body as ProfileBody;
    const open = (await createProfile({ name: 'Libre' })).body as ProfileBody;
    const wrong = await unlock(protectedProfile.id, '0000');
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'invalid_pin' });
    expect((await unlock(open.id, '1111')).status).toBe(409);
    const ok = await unlock(protectedProfile.id, '1111');
    expect(ok.status).toBe(200);
    const days = (Date.parse((ok.body as UnlockBody).expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('jeton de déverrouillage : permet la modification, lié à ce profil, et expire', async () => {
    const protectedProfile = (await createProfile({ name: 'Protégé', pin: '1111' })).body as ProfileBody;
    const other = (await createProfile({ name: 'Autre', pin: '2222' })).body as ProfileBody;
    const token = (await unlock(protectedProfile.id, '1111')).body as UnlockBody;

    const onOther = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${other.id}`, {
      token: alice,
      headers: { 'x-profile-token': token.token },
      body: { name: 'Détourné' },
    });
    expect(onOther.status).toBe(403);

    const edited = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${protectedProfile.id}`, {
      token: alice,
      headers: { 'x-profile-token': token.token },
      body: { name: 'Renommé' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('Renommé');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    const expired = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${protectedProfile.id}`, {
      token: alice,
      headers: { 'x-profile-token': token.token },
    });
    expect(expired.status).toBe(403);
  });

  it('retirer le PIN exige le déverrouillage, puis le profil n est plus protégé', async () => {
    const profile = (await createProfile({ name: 'Protégé', pin: '1111' })).body as ProfileBody;
    const token = (await unlock(profile.id, '1111')).body as UnlockBody;
    const res = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${profile.id}`, {
      token: alice,
      headers: { 'x-profile-token': token.token },
      body: { pin: null },
    });
    expect(res.body.hasPin).toBe(false);
    const free = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${profile.id}`, { token: alice, body: { name: 'Libre' } });
    expect(free.status).toBe(200);
  });

  it('suppression : 204, puis le profil est introuvable', async () => {
    const profile = (await createProfile({ name: 'Temporaire' })).body as ProfileBody;
    const del = await request(app, 'DELETE', `/user/profiles/${profile.id}`, { token: alice });
    expect(del.status).toBe(204);
    const after = await request<ErrorBody>(app, 'GET', `/user/profiles/${profile.id}/settings`, { token: alice });
    expect(after.status).toBe(404);
    const list = await request<{ profiles: ProfileBody[] }>(app, 'GET', '/user/profiles', { token: alice });
    expect(list.body.profiles).toHaveLength(0);
  });

  it('corps invalide : 400 avec chemins de champs seulement', async () => {
    const profile = (await createProfile({ name: 'Nom' })).body as ProfileBody;
    const res = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${profile.id}`, { token: alice, body: { name: '', kidMaxAge: 99 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(res.body.issues?.some((issue) => issue.startsWith('name:'))).toBe(true);
  });
});
