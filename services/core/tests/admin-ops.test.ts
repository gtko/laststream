/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryMetrics } from '../src/metrics/memory.js';
import type { TvCronState } from '../src/admin/cache-types.js';
import type { RoomMeta } from '../src/party/protocol.js';
import { fakeCacheAdmin, fakeParty, inviteAndRegister, request, startAdmin, type AdminRig } from './admin-harness.js';

let rig: AdminRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

describe('/admin/metrics', () => {
  it('requêtes publiques mesurées par groupe, statut et latence', async () => {
    const metrics = createMemoryMetrics();
    rig = await startAdmin({ metrics });
    await request(rig.app, 'GET', '/health');
    await request(rig.app, 'GET', '/health');
    await request(rig.app, 'GET', '/manifest.json');
    await request(rig.app, 'GET', '/user/me'); // 401
    await request(rig.app, 'GET', '/inconnu/stream/movie/tt0133093.json'); // configuration illisible
    const res = await rig.call<any>('GET', '/admin/metrics?range=1h');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('1h');
    expect(res.body.totals.requests).toBeGreaterThanOrEqual(5);
    expect(res.body.groups.other.requests).toBeGreaterThanOrEqual(3);
    expect(res.body.groups.user.status['4xx']).toBeGreaterThanOrEqual(1);
    expect(res.body.groups.stream.requests).toBe(1);
    expect(res.body.groups.other.p95).toEqual(expect.any(Number));
    expect(res.body.series).toHaveLength(12);
    expect(res.body).not.toHaveProperty('cpu');
    expect(res.body.upstreams).toEqual([]);
  });

  it('plages 24h et 7d, plage invalide refusée, défaut 1h', async () => {
    rig = await startAdmin({ metrics: createMemoryMetrics() });
    expect((await rig.call<any>('GET', '/admin/metrics?range=24h')).body.series).toHaveLength(288);
    expect((await rig.call<any>('GET', '/admin/metrics?range=7d')).body.stepSec).toBe(3600);
    expect((await rig.call<any>('GET', '/admin/metrics')).body.range).toBe('1h');
    expect((await rig.call('GET', '/admin/metrics?range=1y')).status).toBe(400);
  });

  it('les 5xx entrent dans la liste des erreurs, sans donnée personnelle', async () => {
    const metrics = createMemoryMetrics();
    rig = await startAdmin({ metrics });
    metrics.sink.error('/:config/stream/movie/:id', 500, 'Error: boom https://addon.example/SECRETSECRETSECRETSECRET/manifest.json');
    const res = await rig.call<any>('GET', '/admin/metrics');
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ route: '/:config/stream/movie/:id', status: 500 });
    expect(JSON.stringify(res.body.errors)).not.toContain('SECRET');
    expect(JSON.stringify(res.body.errors)).not.toContain('addon.example');
  });
});

describe('/admin/caches et /admin/tv', () => {
  it('501 propre sans administration de cache (Node) ou sans API TV', async () => {
    rig = await startAdmin({ metrics: createMemoryMetrics() });
    // Sous Workers la plateforme fournit les caches ; ici on ne teste que l'absence côté TV.
    const tv = await rig.call<{ error: string }>('GET', '/admin/tv');
    expect(tv.status).toBe(501);
    expect(tv.body.error).toBe('tv_admin_unavailable');
    const rerun = await rig.call<{ error: string }>('POST', '/admin/tv/rerun');
    expect(rerun.status).toBe(501);
    expect(rerun.body.error).toBe('tv_admin_unavailable');
  });

  it('TV : dernier cron (état complet) et relance (auditée)', async () => {
    let runs = 0;
    const lastCron: TvCronState = {
      startedAt: '2026-10-18T03:00:00.000Z', finishedAt: '2026-10-18T03:04:12.000Z', durationMs: 252_000,
      ok: true, channels: 708, programmes: 15_230, epgOk: true, error: null,
    };
    rig = await startAdmin({ tvAdmin: { lastCron: () => Promise.resolve(lastCron), rerun: () => Promise.resolve(void (runs += 1)) } });
    expect((await rig.call<any>('GET', '/admin/tv')).body).toEqual({ lastCron });
    expect((await rig.call('POST', '/admin/tv/rerun')).status).toBe(202);
    expect(runs).toBe(1);
    const audit = await rig.call<any>('GET', '/admin/audit?action=tv.rerun');
    expect(audit.body.entries).toHaveLength(1);
  });

  it('statistiques par préfixe avec taux de succès', async () => {
    const metrics = createMemoryMetrics();
    const cache = fakeCacheAdmin({ packs: 12, issued: 3 });
    rig = await startAdmin({ metrics, cacheAdmin: cache });
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', false);
    const res = await rig.call<{ caches: any[]; range: string }>('GET', '/admin/caches');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('24h');
    const packs = res.body.caches.find((entry) => entry.prefix === 'packs');
    expect(packs).toEqual({ prefix: 'packs', keys: 12, exact: true, hits: 3, misses: 1, hitRate: 0.75 });
    expect(res.body.caches.find((entry) => entry.prefix === 'hosts')).toMatchObject({ keys: 0, hits: 0, misses: 0, hitRate: null });
  });

  it('purge : élévation exigée, préfixe connu, progression consultable', async () => {
    const cache = fakeCacheAdmin({ packs: 7 });
    rig = await startAdmin({ cacheAdmin: cache });
    expect((await rig.call('POST', '/admin/caches/packs/purge')).status).toBe(403);
    expect(cache.jobs).toHaveLength(0);
    const elevation = await rig.elevate();
    expect((await rig.call('POST', '/admin/caches/inconnu/purge', { elevation })).status).toBe(404);
    expect((await rig.call('POST', '/admin/caches/*/purge', { elevation })).status).toBe(404);

    const started = await rig.call<any>('POST', '/admin/caches/packs/purge', { elevation });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ prefix: 'packs', status: 'running', deleted: 0 });
    // Une purge déjà en cours pour ce préfixe est renvoyée telle quelle.
    expect((await rig.call<any>('POST', '/admin/caches/packs/purge', { elevation })).body.id).toBe(started.body.id);

    expect((await rig.call<any>('GET', `/admin/caches/purges/${started.body.id}`)).body.status).toBe('running');
    cache.finish(started.body.id);
    expect((await rig.call<any>('GET', `/admin/caches/purges/${started.body.id}`)).body).toMatchObject({ status: 'done', deleted: 7 });
    expect((await rig.call<any>('GET', '/admin/caches/purges')).body.jobs).toHaveLength(1);
    expect((await rig.call('GET', `/admin/caches/purges/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await rig.call<any>('GET', '/admin/audit?action=cache.purge')).body.entries[0]).toMatchObject({ target: 'packs', actor: 'alice' });
  });

  it('un compte non propriétaire ne peut ni lire ni purger', async () => {
    rig = await startAdmin({ cacheAdmin: fakeCacheAdmin({ packs: 1 }) });
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    expect((await request(rig.app, 'GET', '/admin/caches', { token: bob.token })).status).toBe(403);
    expect((await request(rig.app, 'POST', '/admin/caches/packs/purge', { token: bob.token })).status).toBe(403);
  });
});

function meta(id: string, hostId: string, hostName: string, visibility: 'private' | 'public'): RoomMeta {
  return {
    id,
    visibility,
    hostId,
    hostName,
    title: `Salon ${id}`,
    poster: null,
    language: 'fr',
    media: { type: 'movie', tmdbId: 603, imdbId: null, season: null, episode: null },
    fingerprint: null,
    maxParticipants: 8,
    createdAt: Date.now(),
  };
}

describe('/admin/party', () => {
  it('salons actifs (privés compris), fermeture forcée, nettoyage de l\'annuaire', async () => {
    const party = fakeParty();
    rig = await startAdmin({ party });
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    // Création via l'API publique : annuaire + salon simulé.
    const created = await request<{ room: { id: string } }>(rig.app, 'POST', '/party', {
      token: bob.token,
      body: { profileId: bob.profile, visibility: 'private', title: 'Matrix', media: { type: 'movie', tmdbId: 603 } },
    });
    expect(created.status).toBe(201);
    const roomId = created.body.room.id;

    const list = await rig.call<{ rooms: any[] }>('GET', '/admin/party/rooms');
    expect(list.body.rooms).toEqual([expect.objectContaining({ id: roomId, host: 'bob', visibility: 'private', title: 'Matrix', participants: 2 })]);

    expect((await rig.call('DELETE', `/admin/party/rooms/${roomId}`)).status).toBe(403);
    expect((await rig.call('DELETE', `/admin/party/rooms/${roomId}`, { elevation: await rig.elevate() })).status).toBe(204);
    expect(party.closures).toEqual([{ id: roomId, by: null }]);
    expect((await rig.call<{ rooms: any[] }>('GET', '/admin/party/rooms')).body.rooms).toEqual([]);
    expect((await rig.call('DELETE', `/admin/party/rooms/${roomId}`, { elevation: await rig.elevate() })).status).toBe(404);

    // Salon terminé côté salon mais resté dans l'annuaire : retiré de la liste.
    await party.room('ghostroom12345678').init(meta('ghostroom12345678', 'x', 'bob', 'public'));
    expect((await rig.call<any>('GET', '/admin/party/rooms')).body.rooms).toEqual([]);
  });

  it('suppression d\'un compte : ses salons sont fermés', async () => {
    const party = fakeParty();
    rig = await startAdmin({ party });
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    const created = await request<{ room: { id: string } }>(rig.app, 'POST', '/party', {
      token: bob.token,
      body: { profileId: bob.profile, visibility: 'public', title: 'Salon', media: { type: 'movie', tmdbId: 1 } },
    });
    const bobId = (await rig.call<any>('GET', '/admin/accounts?q=bob')).body.accounts[0].id as string;
    expect((await rig.call('DELETE', `/admin/accounts/${bobId}`, { elevation: await rig.elevate() })).status).toBe(204);
    expect(party.closures).toEqual([{ id: created.body.room.id, by: null }]);
  });

  it("file des signalements : liste, ignorer, supprimer le message, suspendre l'auteur", async () => {
    const party = fakeParty();
    const current = await startAdmin({ party });
    rig = current;
    const bob = await inviteAndRegister(current.app, current.owner, 'bob');
    await inviteAndRegister(current.app, current.owner, 'carol');
    const accounts = (await current.call<any>('GET', '/admin/accounts')).body.accounts as { id: string; username: string }[];
    const idOf = (name: string): string => accounts.find((account) => account.username === name)?.id as string;

    // Le salon alimente la file au moment du signalement (voir PartyRoom, testé sur le vrai Worker) : amorçage direct ici.
    await party.room('room1234567890ab').init(meta('room1234567890ab', idOf('bob'), 'bob', 'public'));
    const room = party.rooms.get('room1234567890ab');
    room?.messages.push('m1', 'm2', 'm3');
    const seed = async (messageId: string, against: string, againstId: string | null): Promise<void> => {
      await current.backend.admin().addReport({ roomId: 'room1234567890ab', messageId, by: 'bob', againstId, against, text: `texte ${messageId}`, reason: 'spam', at: Date.now() });
    };
    await seed('m1', 'carol', idOf('carol'));
    await seed('m2', 'carol', idOf('carol'));
    await seed('m3', 'inconnu', null);
    await seed('m1', 'carol', idOf('carol')); // doublon (même message, même auteur du signalement) ignoré

    const open = await current.call<{ reports: any[] }>('GET', '/admin/party/reports');
    expect(open.body.reports.map((r) => r.messageId).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(open.body.reports[0]).toMatchObject({ roomId: 'room1234567890ab', by: 'bob', reason: 'spam', status: 'open' });
    const byMessage = new Map(open.body.reports.map((r) => [r.messageId as string, r.id as number]));

    // Ignorer.
    const ignored = await current.call<any>('POST', `/admin/party/reports/${byMessage.get('m1')}/action`, { body: { action: 'ignore' } });
    expect(ignored.body.status).toBe('ignored');
    expect((await current.call('POST', `/admin/party/reports/${byMessage.get('m1')}/action`, { body: { action: 'ignore' } })).status).toBe(409);

    // Supprimer le message : retiré du salon, signalement clos.
    expect((await current.call<any>('POST', `/admin/party/reports/${byMessage.get('m2')}/action`, { body: { action: 'delete' } })).body.status).toBe('deleted');
    expect(room?.messages).toEqual(['m1', 'm3']);

    // Suspendre l'auteur : élévation exigée, auteur inconnu refusé.
    expect((await current.call('POST', `/admin/party/reports/${byMessage.get('m3')}/action`, { body: { action: 'suspend' } })).status).toBe(403);
    const unknown = await current.call<{ error: string }>('POST', `/admin/party/reports/${byMessage.get('m3')}/action`, { body: { action: 'suspend' }, elevation: await current.elevate() });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toBe('author_unknown');
    await seed('m4', 'carol', idOf('carol'));
    const m4 = (await current.call<{ reports: any[] }>('GET', '/admin/party/reports')).body.reports.find((r) => r.messageId === 'm4');
    const suspended = await current.call<any>('POST', `/admin/party/reports/${m4.id}/action`, { body: { action: 'suspend' }, elevation: await current.elevate() });
    expect(suspended.body.status).toBe('suspended');
    expect((await current.call<any>('GET', `/admin/accounts/${idOf('carol')}`)).body.account.status).toBe('suspended');
    expect((await request(current.app, 'POST', '/user/login', { body: { username: 'carol', password: 'mot-de-passe-test-1' } })).status).toBe(403);

    // Files par statut.
    expect((await current.call<any>('GET', '/admin/party/reports?status=ignored')).body.reports).toHaveLength(1);
    expect((await current.call<any>('GET', '/admin/party/reports?status=deleted')).body.reports).toHaveLength(1);
    expect((await current.call('GET', '/admin/party/reports?status=autre')).status).toBe(400);
    expect((await current.call('POST', '/admin/party/reports/999999/action', { body: { action: 'ignore' } })).status).toBe(404);
    expect((await current.call('POST', '/admin/party/reports/abc/action', { body: { action: 'ignore' } })).status).toBe(400);
    expect((await request(current.app, 'GET', '/admin/party/reports', { token: bob.token })).status).toBe(403);
  });
});
