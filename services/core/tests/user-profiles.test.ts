import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { createProfileVia, type ErrorBody, loginAs, PASSWORD, request } from './user-harness.js';

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

async function createProfile(body: Record<string, unknown>, token = alice, mainToken?: string) {
  return createProfileVia<ProfileBody | ErrorBody>(app, token, body, mainToken);
}

/** Appel de gestion fait depuis le profil actor (X-Profile-Id) avec, éventuellement, son jeton de PIN. */
function asProfile(actor: string, pinToken?: string, token = alice) {
  return { token, headers: { 'x-profile-id': actor, ...(pinToken ? { 'x-profile-token': pinToken } : {}) } };
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
    await createProfile({ name: 'Principal' });
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

describe('profils : modification et suppression (profil principal seulement)', () => {
  let main: ProfileBody;
  beforeEach(async () => {
    main = (await createProfile({ name: 'Principal' })).body as ProfileBody;
  });

  it('PATCH depuis le principal : modifie les champs fournis ; isKid à false remet l âge maximum à null', async () => {
    const profile = (await createProfile({ name: 'Enfant', isKid: true, kidMaxAge: 10 })).body as ProfileBody;
    const res = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${profile.id}`, {
      ...asProfile(main.id),
      body: { name: 'Petit', isKid: false, allowedCatalogs: ['films'] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Petit', isKid: false, kidMaxAge: null, allowedCatalogs: ['films'] });
  });

  it('profil d un autre compte : 404 (même sans en-tête et depuis un autre principal)', async () => {
    const res = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${main.id}`, { token: bob, body: { name: 'Piraté' } });
    expect(res.status).toBe(404);
    const bobMain = (await createProfile({ name: 'Bob' }, bob)).body as ProfileBody;
    const cross = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(bobMain.id, undefined, bob), body: { name: 'Piraté' } });
    expect(cross.status).toBe(404);
  });

  it('création, modification et suppression : 403 main_profile_required pour un profil secondaire adulte ou enfant', async () => {
    const jessica = (await createProfile({ name: 'Jessica' })).body as ProfileBody;
    const kid = (await createProfile({ name: 'Theo', isKid: true })).body as ProfileBody;
    for (const actor of [jessica.id, kid.id]) {
      const create = await request<ErrorBody>(app, 'POST', '/user/profiles', { ...asProfile(actor), body: { name: 'Intrus' } });
      const patch = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${kid.id}`, { ...asProfile(actor), body: { name: 'Renommé' } });
      const avatar = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${actor}`, { ...asProfile(actor), body: { avatarColor: '#ff0000' } });
      const del = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${jessica.id}`, asProfile(actor));
      for (const res of [create, patch, avatar, del]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'main_profile_required' });
      }
    }
    // Sans X-Profile-Id, ou avec un profil inexistant : refusé aussi.
    expect((await request(app, 'POST', '/user/profiles', { token: alice, body: { name: 'Intrus' } })).status).toBe(403);
    expect((await request(app, 'DELETE', `/user/profiles/${jessica.id}`, asProfile('inconnu'))).status).toBe(403);
    const list = await request<{ profiles: ProfileBody[] }>(app, 'GET', '/user/profiles', { token: alice });
    expect(list.body.profiles.map((p) => p.name)).toEqual(['Principal', 'Jessica', 'Theo']);
  });

  it('sans session : 401 sur la création, la modification et la suppression', async () => {
    expect((await request(app, 'POST', '/user/profiles', { body: { name: 'X' } })).status).toBe(401);
    expect((await request(app, 'PATCH', `/user/profiles/${main.id}`, { body: { name: 'X' } })).status).toBe(401);
    expect((await request(app, 'DELETE', `/user/profiles/${main.id}`)).status).toBe(401);
  });

  it('un adulte change son propre code PIN seul (jeton de son profil exigé) ; un enfant ne le peut pas', async () => {
    const jessica = (await createProfile({ name: 'Jessica', pin: '1111' })).body as ProfileBody;
    const kid = (await createProfile({ name: 'Theo', isKid: true })).body as ProfileBody;
    const noToken = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${jessica.id}`, { ...asProfile(jessica.id), body: { pin: '2222' } });
    expect(noToken.body).toEqual({ error: 'pin_required' });
    const token = ((await unlock(jessica.id, '1111')).body as UnlockBody).token;
    const ok = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${jessica.id}`, { ...asProfile(jessica.id, token), body: { pin: '2222' } });
    expect(ok.status).toBe(200);
    const mixed = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${jessica.id}`, { ...asProfile(jessica.id, token), body: { pin: '3333', name: 'X' } });
    expect(mixed.body).toEqual({ error: 'main_profile_required' });
    const kidPin = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${kid.id}`, { ...asProfile(kid.id), body: { pin: '3333' } });
    expect(kidPin.body).toEqual({ error: 'main_profile_required' });
  });

  it('principal protégé par PIN : sans son jeton, la gestion est refusée (403 pin_required) ; avec, elle passe', async () => {
    const other = (await createProfile({ name: 'Autre' })).body as ProfileBody;
    const set = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { pin: '1111' } });
    expect(set.status).toBe(200);
    const denied = await createProfile({ name: 'Nouveau' });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: 'pin_required' });
    const token = ((await unlock(main.id, '1111')).body as UnlockBody).token;
    expect((await createProfile({ name: 'Nouveau' }, alice, token)).status).toBe(201);
    expect((await request(app, 'DELETE', `/user/profiles/${other.id}`, asProfile(main.id, token))).status).toBe(204);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    expect((await request(app, 'DELETE', `/user/profiles/${main.id}`, asProfile(main.id, token))).status).toBe(403);
  });

  it('déverrouillage : mauvais PIN 403, profil sans PIN 409, bon PIN : jeton de 30 jours', async () => {
    const protectedProfile = (await createProfile({ name: 'Protégé', pin: '1111' })).body as ProfileBody;
    const wrong = await unlock(protectedProfile.id, '0000');
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'invalid_pin' });
    expect((await unlock(main.id, '1111')).status).toBe(409);
    const ok = await unlock(protectedProfile.id, '1111');
    expect(ok.status).toBe(200);
    const days = (Date.parse((ok.body as UnlockBody).expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('suppression : 204, puis le profil est introuvable', async () => {
    const profile = (await createProfile({ name: 'Temporaire' })).body as ProfileBody;
    const del = await request(app, 'DELETE', `/user/profiles/${profile.id}`, asProfile(main.id));
    expect(del.status).toBe(204);
    const after = await request<ErrorBody>(app, 'GET', `/user/profiles/${profile.id}/settings`, { token: alice });
    expect(after.status).toBe(404);
    const list = await request<{ profiles: ProfileBody[] }>(app, 'GET', '/user/profiles', { token: alice });
    expect(list.body.profiles).toHaveLength(1);
  });

  it('corps invalide : 400 avec chemins de champs seulement', async () => {
    const res = await request<ErrorBody>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { name: '', kidMaxAge: 99 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(res.body.issues?.some((issue) => issue.startsWith('name:'))).toBe(true);
  });
});

describe('profils : avatar illustré (dicebear:<style>:<graine>)', () => {
  it('accepte le format, le renvoie, le modifie et le retire ; la couleur reste le repli', async () => {
    const main = (await createProfile({ name: 'Principal', avatar: 'dicebear:lorelei:Abc_123-x' })).body as ProfileBody & { avatar: string | null };
    expect(main.avatar).toBe('dicebear:lorelei:Abc_123-x');
    expect(main.avatarColor).toBe('#3b82f6');
    const edited = await request<ProfileBody & { avatar: string | null }>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { avatar: 'dicebear:thumbs:42' } });
    expect(edited.body.avatar).toBe('dicebear:thumbs:42');
    const kept = await request<ProfileBody & { avatar: string | null }>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { name: 'Autre nom' } });
    expect(kept.body.avatar).toBe('dicebear:thumbs:42');
    const cleared = await request<ProfileBody & { avatar: string | null }>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { avatar: null } });
    expect(cleared.body.avatar).toBeNull();
    const list = await request<{ profiles: Array<{ avatar: string | null }> }>(app, 'GET', '/user/profiles', { token: alice });
    expect(list.body.profiles[0].avatar).toBeNull();
  });

  it('refuse les formats invalides (préfixe, majuscules du style, caractères, longueur)', async () => {
    await createProfile({ name: 'Principal' });
    for (const avatar of ['http://x/a.svg', 'dicebear:Lorelei:abc', 'dicebear:lorelei:a b', 'dicebear:lorelei:', 'dicebear:lorelei:' + 'a'.repeat(41), 'dicebear::abc', '<svg>', 'dicebear:lorelei:é']) {
      expect((await createProfile({ name: 'X', avatar })).status, avatar).toBe(400);
    }
  });
  it('accepte les avatars Héros hero:<famille>:<graine> et refuse les familles inconnues', async () => {
    const main = (await createProfile({ name: 'Principal', avatar: 'hero:vilains:Abc_123-x' })).body as ProfileBody & { avatar: string | null };
    expect(main.avatar).toBe('hero:vilains:Abc_123-x');
    for (const family of ['heros', 'scifi', 'fantasy']) {
      const res = await request<ProfileBody & { avatar: string | null }>(app, 'PATCH', `/user/profiles/${main.id}`, { ...asProfile(main.id), body: { avatar: `hero:${family}:Aegis-2` } });
      expect(res.body.avatar).toBe(`hero:${family}:Aegis-2`);
    }
    for (const avatar of ['hero:inconnue:abc', 'hero:Heros:abc', 'hero:heros:', 'hero:heros:a b', 'hero:heros:' + 'a'.repeat(41), 'hero:heros:é', 'heros:heros:abc', 'hero::abc']) {
      expect((await createProfile({ name: 'X', avatar })).status, avatar).toBe(400);
    }
  });
});
