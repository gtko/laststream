import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { createProfileVia, type ErrorBody, loginAs, PASSWORD, request } from './user-harness.js';

interface ProfileBody {
  id: string;
  name: string;
  isKid: boolean;
  kidMaxAge: number | null;
  avatar: string | null;
}

// Collections des fichiers générés (src/user/avatar-collections.ts) : adulte seulement, et publiée aux enfants.
const ADULT_COLLECTION_AVATAR = 'col:marvel-heros:iron-man';
const KID_COLLECTION_AVATAR = 'col:pokemon-officiel:pikachu';

let app: RunningApp;
let alice: string;
let main: ProfileBody;

beforeEach(async () => {
  vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
  app = await startApp({});
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  alice = await loginAs(app, 'alice');
  main = (await createProfileVia<ProfileBody>(app, alice, { name: 'Principal' })).body;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

const createProfile = (body: Record<string, unknown>) => createProfileVia<ProfileBody | ErrorBody>(app, alice, body);

const patchProfile = (id: string, body: Record<string, unknown>) =>
  request<ProfileBody | ErrorBody>(app, 'PATCH', `/user/profiles/${id}`, { token: alice, headers: { 'x-profile-id': main.id }, body });

describe('avatar par collection (col:<colId>:<charId>) : validation', () => {
  it('accepte une collection publiée sur un profil adulte', async () => {
    const res = await createProfile({ name: 'Greg', avatar: ADULT_COLLECTION_AVATAR });
    expect(res.status).toBe(201);
    expect((res.body as ProfileBody).avatar).toBe(ADULT_COLLECTION_AVATAR);
  });

  it('refuse une collection inconnue : 400 invalid_avatar, à la création et à la modification', async () => {
    const created = await createProfile({ name: 'X', avatar: 'col:collection-inconnue:abc' });
    expect(created.status).toBe(400);
    expect((created.body as ErrorBody).error).toBe('invalid_avatar');
    const patched = await patchProfile(main.id, { avatar: 'col:collection-inconnue:abc' });
    expect(patched.status).toBe(400);
    expect((patched.body as ErrorBody).error).toBe('invalid_avatar');
  });

  it('refuse un format col: mal formé (slug en minuscules attendu) : 400 invalid_body', async () => {
    for (const avatar of ['col:Marvel-heros:iron-man', 'col:marvel-heros:', 'col::iron-man', 'col:marvel-heros:iron man', `col:${'a'.repeat(49)}:x`]) {
      const res = await createProfile({ name: 'X', avatar });
      expect(res.status, avatar).toBe(400);
      expect((res.body as ErrorBody).error, avatar).toBe('invalid_body');
    }
  });

  it('ne vérifie pas le charId côté serveur (regex seulement)', async () => {
    const res = await createProfile({ name: 'Greg', avatar: 'col:marvel-heros:personnage-qui-nexiste-pas' });
    expect(res.status).toBe(201);
  });

  it('les formats dicebear et hero restent acceptés sur un profil enfant', async () => {
    expect((await createProfile({ name: 'Petit', isKid: true, avatar: 'dicebear:lorelei:Abc_123' })).status).toBe(201);
    expect((await createProfile({ name: 'Ado', isKid: true, avatar: 'hero:heros:Aegis-2' })).status).toBe(201);
  });
});

describe('avatar par collection : profil enfant', () => {
  it('profil enfant : collection non autorisée aux enfants refusée (400 avatar_not_allowed_for_kid)', async () => {
    const res = await createProfile({ name: 'Petit', isKid: true, avatar: ADULT_COLLECTION_AVATAR });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('avatar_not_allowed_for_kid');
  });

  it('profil enfant : collection autorisée aux enfants acceptée', async () => {
    const res = await createProfile({ name: 'Petit', isKid: true, avatar: KID_COLLECTION_AVATAR });
    expect(res.status).toBe(201);
    expect((res.body as ProfileBody).avatar).toBe(KID_COLLECTION_AVATAR);
  });

  it('modification d un profil enfant avec une collection non autorisée : 400 avatar_not_allowed_for_kid', async () => {
    const kid = (await createProfile({ name: 'Petit', isKid: true, avatar: KID_COLLECTION_AVATAR })).body as ProfileBody;
    const res = await patchProfile(kid.id, { avatar: ADULT_COLLECTION_AVATAR });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('avatar_not_allowed_for_kid');
  });

  it('passage en profil enfant d un profil dont l avatar col: n est pas enfant : même erreur, profil inchangé', async () => {
    const adult = (await createProfile({ name: 'Greg', avatar: ADULT_COLLECTION_AVATAR })).body as ProfileBody;
    const res = await patchProfile(adult.id, { isKid: true });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('avatar_not_allowed_for_kid');
    const list = await request<{ profiles: ProfileBody[] }>(app, 'GET', '/user/profiles', { token: alice });
    expect(list.body.profiles.find((profile) => profile.id === adult.id)).toMatchObject({ isKid: false, avatar: ADULT_COLLECTION_AVATAR });
  });

  it('passage en profil enfant d un profil dont l avatar col: est enfant : accepté', async () => {
    const adult = (await createProfile({ name: 'Greg', avatar: KID_COLLECTION_AVATAR })).body as ProfileBody;
    const res = await patchProfile(adult.id, { isKid: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isKid: true, kidMaxAge: 12, avatar: KID_COLLECTION_AVATAR });
  });

  it('modification du nom seul d un profil enfant : l avatar en place n est pas revérifié', async () => {
    const kid = (await createProfile({ name: 'Petit', isKid: true, avatar: KID_COLLECTION_AVATAR })).body as ProfileBody;
    const res = await patchProfile(kid.id, { name: 'Petit bis' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Petit bis', avatar: KID_COLLECTION_AVATAR });
  });
});
