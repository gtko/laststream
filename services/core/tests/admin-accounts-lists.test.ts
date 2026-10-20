/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { AdminStore } from '../src/user/admin-store.js';
import { inviteAndRegister, type Member, startAdmin, type AdminRig } from './admin-harness.js';

const SENSITIVE = /password|hash|scrypt|pin_hash|token_hash|secret|apikey/i;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}

const names = (accounts: { username: string }[]): string[] => accounts.map((account) => account.username);

describe('/admin : filtres, effectifs, export et présence', () => {
  let rig: AdminRig;
  let bob: Member;
  let carol: Member;
  let dave: Member;

  // alice (propriétaire) -> bob, dave ; bob -> carol. Quota par défaut : 4.
  beforeEach(async () => {
    rig = await startAdmin();
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    carol = await inviteAndRegister(rig.app, bob, 'carol');
    dave = await inviteAndRegister(rig.app, rig.owner, 'dave');
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('filtre par défaut : tous, avec total et effectifs de chaque filtre', async () => {
    const res = await rig.call<any>('GET', '/admin/accounts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.counts).toEqual({ all: 4, online: 0, inactive30: 0, suspended: 0, noInvites: 0 });
    expect((await rig.call<any>('GET', '/admin/accounts?filter=all')).body.total).toBe(4);
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('filtre inconnu : 400', async () => {
    expect((await rig.call('GET', '/admin/accounts?filter=tout')).status).toBe(400);
  });

  it('suspendus : liste et effectif', async () => {
    await rig.call('POST', `/admin/accounts/${await idOf(rig, 'carol')}/suspend`, { elevation: await rig.elevate() });
    const listed = await rig.call<any>('GET', '/admin/accounts?filter=suspended');
    expect(names(listed.body.accounts)).toEqual(['carol']);
    expect(listed.body.total).toBe(1);
    expect(listed.body.counts).toMatchObject({ all: 4, suspended: 1 });
  });

  it('sans invitation : quota - liens utilisés <= 0', async () => {
    // Quota 0 : aucun lien disponible, même sans lien utilisé.
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'dave')}/invite-quota`, { body: { quota: 0 } });
    // bob a un lien utilisé (carol) : quota 1 suffit à l'épuiser.
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'bob')}/invite-quota`, { body: { quota: 1 } });
    const listed = await rig.call<any>('GET', '/admin/accounts?filter=noInvites');
    expect(names(listed.body.accounts).sort()).toEqual(['bob', 'dave']);
    expect(listed.body.counts.noInvites).toBe(2);
    // Quota 2 pour bob (un lien utilisé sur deux) : il lui reste un lien, il sort du filtre.
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'bob')}/invite-quota`, { body: { quota: 2 } });
    expect(names((await rig.call<any>('GET', '/admin/accounts?filter=noInvites')).body.accounts)).toEqual(['dave']);
  });

  it('inactifs depuis trente jours, ou jamais : dernière activité ancienne ou absente', async () => {
    // dave : sessions révoquées, dernière présence il y a 40 jours. carol : sessions révoquées, jamais de présence.
    await rig.call('POST', `/admin/accounts/${await idOf(rig, 'dave')}/revoke-sessions`, { elevation: await rig.elevate() });
    await rig.call('POST', `/admin/accounts/${await idOf(rig, 'carol')}/revoke-sessions`, { elevation: await rig.elevate() });
    await rig.backend.social().setPresence(await idOf(rig, 'dave'), dave.profile, null, false, new Date(Date.now() - 40 * DAY).toISOString());

    const listed = await rig.call<any>('GET', '/admin/accounts?filter=inactive30');
    expect(names(listed.body.accounts).sort()).toEqual(['carol', 'dave']);
    expect(listed.body.counts.inactive30).toBe(2);
    expect(listed.body.accounts.find((a: any) => a.username === 'carol').lastActivityAt).toBeNull();
    // Une présence récente sort dave de la liste des inactifs.
    await rig.backend.social().setPresence(await idOf(rig, 'dave'), dave.profile, null, false, new Date().toISOString());
    expect(names((await rig.call<any>('GET', '/admin/accounts?filter=inactive30')).body.accounts)).toEqual(['carol']);
  });

  it('en ligne : présence de moins de deux minutes', async () => {
    await rig.backend.social().setPresence(await idOf(rig, 'bob'), bob.profile, null, false, new Date().toISOString());
    await rig.backend.social().setPresence(await idOf(rig, 'dave'), dave.profile, null, false, new Date(Date.now() - 3 * MINUTE).toISOString());
    const listed = await rig.call<any>('GET', '/admin/accounts?filter=online');
    expect(names(listed.body.accounts)).toEqual(['bob']);
    expect(listed.body.counts.online).toBe(1);
    expect(listed.body.accounts[0]).toMatchObject({ online: true });
  });

  it('effectifs indépendants de la pagination, du filtre et de la recherche', async () => {
    await rig.call('POST', `/admin/accounts/${await idOf(rig, 'carol')}/suspend`, { elevation: await rig.elevate() });
    const paged = await rig.call<any>('GET', '/admin/accounts?filter=suspended&limit=1');
    expect(paged.body.accounts).toHaveLength(1);
    // La suspension révoque les sessions de carol, qui n'a jamais eu de présence : elle compte comme inactive.
    expect(paged.body.counts).toEqual({ all: 4, online: 0, inactive30: 1, suspended: 1, noInvites: 0 });
    expect((await rig.call<any>('GET', '/admin/accounts?filter=inactive30')).body.counts).toEqual(paged.body.counts);
    const searched = await rig.call<any>('GET', '/admin/accounts?q=zzz');
    expect(searched.body.total).toBe(0);
    expect(searched.body.counts.all).toBe(4);
  });

  it('filtre combiné à la pagination par curseur', async () => {
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'dave')}/invite-quota`, { body: { quota: 0 } });
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'bob')}/invite-quota`, { body: { quota: 1 } });
    const first = await rig.call<any>('GET', '/admin/accounts?filter=noInvites&limit=1');
    expect(first.body.total).toBe(2);
    expect(first.body.accounts).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await rig.call<any>('GET', `/admin/accounts?filter=noInvites&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.accounts).toHaveLength(1);
    expect(second.body.accounts[0].username).not.toBe(first.body.accounts[0].username);
    expect(second.body.nextCursor).toBeNull();
  });

  it('export : même ordre que la liste, filtre et recherche, sans donnée sensible', async () => {
    const list = await rig.call<any>('GET', '/admin/accounts');
    const exported = await rig.call<any>('GET', '/admin/accounts/export');
    expect(exported.status).toBe(200);
    expect(exported.body.truncated).toBe(false);
    expect(names(exported.body.accounts)).toEqual(names(list.body.accounts));
    expect(JSON.stringify(exported.body)).not.toMatch(SENSITIVE);

    expect(names((await rig.call<any>('GET', '/admin/accounts/export?q=ar')).body.accounts)).toEqual(['carol']);
    expect((await rig.call<any>('GET', '/admin/accounts/export?filter=suspended')).body.accounts).toEqual([]);
    expect((await rig.call('GET', '/admin/accounts/export?filter=tout')).status).toBe(400);
  });

  it('export audité : qui a exporté, quel filtre', async () => {
    await rig.call('GET', '/admin/accounts/export?filter=online');
    const audit = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=account.export');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({ actor: 'alice', action: 'account.export', detail: { filter: 'online', q: null } });
  });

  it('liste des comptes présents : titre en cours, horodatage, présence ancienne exclue', async () => {
    const bobId = await idOf(rig, 'bob');
    const aliceId = await idOf(rig, 'alice');
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 10_000).toISOString();
    await rig.backend.social().setPresence(bobId, bob.profile, { type: 'movie', tmdbId: 603, imdbId: null, title: 'Matrix', season: null, episode: null }, false, now);
    await rig.backend.social().setPresence(aliceId, rig.owner.profile, null, false, earlier);
    await rig.backend.social().setPresence(await idOf(rig, 'carol'), carol.profile, null, false, new Date(Date.now() - 5 * MINUTE).toISOString());

    const res = await rig.call<{ accounts: any[] }>('GET', '/admin/online');
    expect(res.status).toBe(200);
    // Le plus récemment vu d'abord.
    expect(res.body.accounts).toEqual([
      { id: bobId, username: 'bob', lastSeenAt: now, watching: { title: 'Matrix', mediaType: 'movie' } },
      { id: aliceId, username: 'alice', lastSeenAt: earlier, watching: null },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('série en cours : type series, sans identifiant TMDB ni IMDb exposé', async () => {
    const bobId = await idOf(rig, 'bob');
    await rig.backend
      .social()
      .setPresence(bobId, bob.profile, { type: 'series', tmdbId: 1399, imdbId: 'tt0944947', title: 'Game of Thrones', season: 1, episode: 2 }, false, new Date().toISOString());
    const res = await rig.call<{ accounts: any[] }>('GET', '/admin/online');
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].watching).toEqual({ title: 'Game of Thrones', mediaType: 'series' });
    expect(JSON.stringify(res.body)).not.toMatch(/tmdbId|imdbId|1399|tt0944947/);
  });

  it('effectif « en ligne » et liste /admin/online : même définition', async () => {
    await rig.backend.social().setPresence(await idOf(rig, 'carol'), carol.profile, null, false, new Date().toISOString());
    const counts = (await rig.call<any>('GET', '/admin/accounts')).body.counts;
    const online = (await rig.call<any>('GET', '/admin/online')).body.accounts;
    expect(counts.online).toBe(online.length);
    expect(names(online)).toEqual(['carol']);
  });
});

describe('AdminStore : export plafonné et présence sans rig', () => {
  const ACCOUNT_SQL = 'INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)';

  it('export au-delà du plafond : `truncated`, jamais plus de `max` comptes', () => {
    const db = openUserDb(':memory:');
    const insert = db.prepare(ACCOUNT_SQL);
    insert.run('00000000-0000-4000-8000-000000000001', 'un', 'h', 1, '2026-01-01T00:00:00.000Z');
    insert.run('00000000-0000-4000-8000-000000000002', 'deux', 'h', 0, '2026-01-02T00:00:00.000Z');
    insert.run('00000000-0000-4000-8000-000000000003', 'trois', 'h', 0, '2026-01-03T00:00:00.000Z');
    const store = new AdminStore(db);
    const capped = store.exportAccounts({ filter: 'all' }, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.accounts.map((a) => a.username)).toEqual(['trois', 'deux']);
    const whole = store.exportAccounts({ filter: 'all' }, 3);
    expect(whole.truncated).toBe(false);
    expect(whole.accounts).toHaveLength(3);
    // Trois comptes sans activité depuis 2026-01 : tous inactifs, aucun en ligne.
    expect(store.listAccounts({ order: 'newest', limit: 25, filter: 'all' }).counts).toEqual({ all: 3, online: 0, inactive30: 3, suspended: 0, noInvites: 0 });
    db.close();
  });

  it('présence au JSON illisible ou sans titre : titre en cours absent, compte tout de même listé', () => {
    const db = openUserDb(':memory:');
    db.prepare(ACCOUNT_SQL).run('00000000-0000-4000-8000-000000000001', 'un', 'h', 1, '2026-01-01T00:00:00.000Z');
    db.prepare(ACCOUNT_SQL).run('00000000-0000-4000-8000-000000000002', 'deux', 'h', 0, '2026-01-01T00:00:00.000Z');
    const now = new Date().toISOString();
    const presence = db.prepare('INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES (?, ?, ?, ?, 0)');
    presence.run('00000000-0000-4000-8000-000000000001', null, now, 'pas du json');
    presence.run('00000000-0000-4000-8000-000000000002', null, now, '{"type":"movie"}');
    const online = new AdminStore(db).onlineAccounts();
    expect(online.map((a) => [a.username, a.watching])).toEqual([
      ['un', null],
      ['deux', null],
    ]);
    db.close();
  });
});
