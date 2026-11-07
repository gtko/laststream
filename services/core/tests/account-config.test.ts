import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openUserDb, wrapSqlite } from '../src/platform/node/user-db.js';
import { migrate, MIGRATIONS } from '../src/user/migrations.js';
import { addKidProfile, inviteAndRegister, type Member, request, startAdmin, type AdminRig } from './admin-harness.js';
import { createProfileVia } from './user-harness.js';

interface ConfigBody {
  config: string | null;
}

const asProfile = (profile: string) => ({ 'x-profile-id': profile });

describe('configuration lastAddon du compte (lecture par tous les profils, écriture par le principal)', () => {
  let rig: AdminRig;
  let other: Member;
  let kid: string;
  let jessica: string;
  let encoded: string;

  beforeAll(async () => {
    rig = await startAdmin({ fetch: () => Promise.resolve(new Response('{}', { status: 404 })) });
    other = await inviteAndRegister(rig.app, rig.owner, 'bob');
    kid = await addKidProfile(rig.app, rig.owner);
    jessica = (await createProfileVia(rig.app, rig.owner.token, { name: 'Jessica' })).body.id;
    const res = await request<ConfigBody>(rig.app, 'POST', '/config/encode', { body: {} });
    encoded = res.body.config as string;
    expect(encoded.length).toBeGreaterThan(10);
  });
  afterAll(async () => {
    await rig.app.close();
  });

  it('sans session : 401 en lecture comme en écriture', async () => {
    expect((await request(rig.app, 'GET', '/user/account/config')).status).toBe(401);
    expect((await request(rig.app, 'PUT', '/user/account/config', { body: { config: 'X' } })).status).toBe(401);
  });

  it('compte sans config : null', async () => {
    const res = await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: rig.owner.token });
    expect(res.body).toEqual({ config: null });
  });

  it('Jessica (secondaire), l enfant, ou sans profil : écriture refusée (403 main_profile_required)', async () => {
    const put = await request<{ error: string }>(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, headers: asProfile(jessica), body: { config: encoded } });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('main_profile_required');
    expect((await request(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, body: { config: encoded } })).status).toBe(403);
    expect((await request(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, headers: asProfile(kid), body: { config: encoded } })).status).toBe(403);
  });

  it('le principal écrit ; enfant et Jessica lisent sans PIN, et /stream fonctionne avec cette config', async () => {
    const put = await request<ConfigBody>(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, headers: asProfile(rig.owner.profile), body: { config: encoded } });
    expect(put.status).toBe(200);
    for (const profile of [kid, jessica, rig.owner.profile]) {
      const res = await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: rig.owner.token, headers: asProfile(profile) });
      expect(res.status).toBe(200);
      expect(res.body.config).toBe(encoded);
    }
    const stream = await fetch(`${rig.app.baseUrl}/${encoded}/stream/movie/tt1234567.json`);
    expect(stream.status).toBe(200);
    expect(Array.isArray(((await stream.json()) as { streams: unknown[] }).streams)).toBe(true);
  });

  it('valeur invalide ou trop grande : 400', async () => {
    const headers = asProfile(rig.owner.profile);
    expect((await request(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, headers, body: { config: 12 } })).status).toBe(400);
    expect((await request(rig.app, 'PUT', '/user/account/config', { token: rig.owner.token, headers, body: { config: 'x'.repeat(5000) } })).status).toBe(400);
  });

  it('un profil inconnu du compte est refusé (404)', async () => {
    const res = await request(rig.app, 'GET', '/user/account/config', { token: rig.owner.token, headers: asProfile(other.profile) });
    expect(res.status).toBe(404);
  });

  it('autre compte : aucune fuite, ni lecture ni écriture croisée', async () => {
    const mine = await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: other.token, headers: asProfile(other.profile) });
    expect(mine.body).toEqual({ config: null });
    const settings = await request(rig.app, 'GET', `/user/profiles/${rig.owner.profile}/settings`, { token: other.token });
    expect(settings.status).toBe(404);
    await request(rig.app, 'PUT', '/user/account/config', { token: other.token, headers: asProfile(other.profile), body: { config: 'AUTRE' } });
    const alice = await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: rig.owner.token });
    expect(alice.body.config).toBe(encoded);
  });

  it('principal protégé par PIN : lecture sans PIN pour les autres profils, écriture avec jeton seulement', async () => {
    const pinned = await inviteAndRegister(rig.app, rig.owner, 'carol');
    const small = await addKidProfile(rig.app, pinned);
    const setPin = await request(rig.app, 'PATCH', `/user/profiles/${pinned.profile}`, { token: pinned.token, headers: asProfile(pinned.profile), body: { pin: '1234' } });
    expect(setPin.status).toBe(200);
    const put = (token?: string) =>
      request<{ error: string }>(rig.app, 'PUT', '/user/account/config', {
        token: pinned.token,
        headers: { ...asProfile(pinned.profile), ...(token === undefined ? {} : { 'x-profile-token': token }) },
        body: { config: 'CHIFFRE' },
      });
    expect((await put()).body.error).toBe('pin_required');
    const unlock = await request<{ token: string }>(rig.app, 'POST', `/user/profiles/${pinned.profile}/unlock`, { token: pinned.token, body: { pin: '1234' } });
    expect((await put(unlock.body.token)).status).toBe(200);
    const read = await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: pinned.token, headers: asProfile(small) });
    expect(read.body.config).toBe('CHIFFRE');
  });

  it('ancienne voie : la clé du profil principal alimente le compte, et inversement', async () => {
    const legacy = await inviteAndRegister(rig.app, rig.owner, 'dave');
    await request(rig.app, 'PUT', `/user/profiles/${legacy.profile}/settings`, { token: legacy.token, body: { lastaddonConfig: 'ANCIEN' } });
    expect((await request<ConfigBody>(rig.app, 'GET', '/user/account/config', { token: legacy.token })).body.config).toBe('ANCIEN');
    await request(rig.app, 'PUT', '/user/account/config', { token: legacy.token, headers: asProfile(legacy.profile), body: { config: 'NOUVEAU' } });
    const settings = await request<{ settings: Record<string, unknown> }>(rig.app, 'GET', `/user/profiles/${legacy.profile}/settings`, { token: legacy.token });
    expect(settings.body.settings.lastaddonConfig).toBe('NOUVEAU');
  });
});

describe('migration v10 : la config du profil principal rejoint le compte', () => {
  it('copie la valeur (propriétaire : profil administrateur ; autre compte : plus ancien profil), sans toucher les autres comptes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-v10-'));
    const file = join(dir, 'laststream.db');
    try {
      const old = wrapSqlite(new DatabaseSync(file));
      migrate(old, MIGRATIONS.slice(0, 9));
      const acc = (id: string, owner: number) => old.prepare('INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)').run(id, id, 'h', owner, 't');
      const prof = (id: string, account: string, at: string) => old.prepare("INSERT INTO profiles (id, account_id, name, avatar_color, created_at) VALUES (?, ?, ?, '#000000', ?)").run(id, account, id, at);
      const set = (profile: string, value: string) => old.prepare("INSERT INTO settings (profile_id, key, value) VALUES (?, 'lastaddonConfig', ?)").run(profile, JSON.stringify(value));
      acc('a1', 1);
      prof('p1', 'a1', '1');
      prof('p2', 'a1', '2');
      acc('a2', 0);
      prof('p3', 'a2', '1');
      prof('p4', 'a2', '2');
      acc('a3', 0);
      prof('p5', 'a3', '1');
      old.prepare("INSERT INTO app_settings (key, value) VALUES ('admin_profile_id', ?)").run(JSON.stringify('p2'));
      set('p1', 'AUTRE-PROFIL');
      set('p2', 'CONFIG-ADMIN');
      set('p4', 'SECONDAIRE');
      set('p3', 'CONFIG-A2');
      old.close();

      const db = openUserDb(file);
      try {
        const rows = db.prepare('SELECT id, lastaddon_config AS c FROM accounts ORDER BY id').all();
        expect(rows).toEqual([
          { id: 'a1', c: JSON.stringify('CONFIG-ADMIN') },
          { id: 'a2', c: JSON.stringify('CONFIG-A2') },
          { id: 'a3', c: null },
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
