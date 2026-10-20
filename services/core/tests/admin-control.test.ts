/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminAccount, PartyReportRecord, AuditEntry, RegisteredRoom } from '../src/user/admin-store.js';
import type { PurgeJob, TvCronState } from '../src/admin/cache-types.js';
import { deltaPercent, feedOf, inboxOf, overviewOf, type ProviderState, statusOf, type ServiceState } from '../src/admin/ops-control.js';
import { buildReport, bucketOf, type MetricsReport, noopSink } from '../src/metrics/core.js';
import { createMemoryMetrics } from '../src/metrics/memory.js';
import type { RoomMeta } from '../src/party/protocol.js';
import { type AdminRig, fakeCacheAdmin, fakeParty, inviteAndRegister, type Member, request, startAdmin } from './admin-harness.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const SENSITIVE = /password|hash|scrypt|token|secret|apikey|detail/i;
const ROUTES = ['/admin/status', '/admin/inbox', '/admin/live', '/admin/overview-series'];

/** Rapport d'une heure construit avec les vrais compteurs (même chemin que le service de métriques). */
function reportOf(counters: [string, number][], now = NOW): MetricsReport {
  const bucket = bucketOf(now - 10 * 60_000);
  return buildReport(
    counters.map(([name, value]) => ({ bucket, name, value })),
    [],
    '1h',
    now,
  );
}

function accountOf(over: Partial<AdminAccount> & Pick<AdminAccount, 'id' | 'username'>): AdminAccount {
  return {
    isOwner: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    status: 'active',
    suspendedAt: null,
    referrer: null,
    lastActivityAt: '2026-10-19T10:00:00.000Z',
    online: false,
    sessionCount: 0,
    profileCount: 1,
    libraryCount: 0,
    inviteQuota: 0,
    invitesUsed: 0,
    ...over,
  };
}

const providerOf = (id: string, status: ProviderState['status'], label = id): ProviderState => ({ id, label, status, lastFailureAt: null });

const noCron = undefined;
const serviceOf = (status: ServiceState['status']): ServiceState => ({ id: 'accounts', label: 'Comptes', status, value: 'test' });

describe('centre de contrôle : agrégation (fonctions pures)', () => {
  it('statut global : pire service connu ; unknown ignoré ; ok si rien n’est connu', () => {
    const allUnknown = statusOf({ now: NOW, report: undefined, accounts: serviceOf('unknown'), providers: [], cron: noCron });
    expect(allUnknown.services.map((service) => service.id)).toEqual(['api', 'accounts', 'kv', 'upstream', 'cron']);
    expect(allUnknown.services.find((service) => service.id === 'api')?.status).toBe('unknown');
    expect(allUnknown.status).toBe('ok');

    const providerDown = statusOf({ now: NOW, report: undefined, accounts: serviceOf('ok'), providers: [providerOf('tmdb', 'down', 'TMDB')], cron: noCron });
    expect(providerDown.status).toBe('down');
    expect(providerDown.services.find((service) => service.id === 'upstream')).toMatchObject({ status: 'down', value: '0/1 OK', detail: 'TMDB' });

    const accountsDown = statusOf({ now: NOW, report: undefined, accounts: serviceOf('down'), providers: [providerOf('tmdb', 'ok')], cron: noCron });
    expect(accountsDown.status).toBe('down');
  });

  it('API : taux de 5xx sur 1 h (≥ 1 % dégradé, ≥ 10 % en panne) et p95 ; KV : taux de succès des caches', () => {
    const degraded = statusOf({
      now: NOW,
      report: reportOf([['rq|other', 200], ['st|other|5xx', 4], ['st|other|2xx', 196]]),
      accounts: serviceOf('ok'),
      providers: [],
      cron: noCron,
    });
    expect(degraded.services.find((service) => service.id === 'api')).toMatchObject({ status: 'degraded' });

    const down = statusOf({
      now: NOW,
      report: reportOf([['rq|other', 100], ['st|other|5xx', 10], ['st|other|2xx', 90], ['ch|packs|hit', 1], ['ch|packs|miss', 9]]),
      accounts: serviceOf('ok'),
      providers: [],
      cron: noCron,
    });
    expect(down.services.find((service) => service.id === 'api')).toMatchObject({ status: 'down' });
    expect(down.services.find((service) => service.id === 'kv')).toMatchObject({ status: 'down', value: '10,0 % de succès (1 h)' });
    expect(down.status).toBe('down');
  });

  it('cron TV : en retard ou jamais passé → dégradé ; sans API TV → unknown', () => {
    const state: TvCronState = {
      startedAt: '2026-10-19T00:00:00.000Z',
      finishedAt: '2026-10-19T00:04:00.000Z',
      durationMs: 240_000,
      ok: true,
      channels: 10,
      programmes: 20,
      epgOk: true,
      error: null,
    };
    const late = statusOf({ now: NOW, report: undefined, accounts: serviceOf('ok'), providers: [], cron: { state, overdue: true } });
    expect(late.services.find((service) => service.id === 'cron')).toMatchObject({ status: 'degraded' });
    const never = statusOf({ now: NOW, report: undefined, accounts: serviceOf('ok'), providers: [], cron: { state: null, overdue: true } });
    expect(never.services.find((service) => service.id === 'cron')).toMatchObject({ status: 'degraded', value: 'aucun passage enregistré' });
    const absent = statusOf({ now: NOW, report: undefined, accounts: serviceOf('ok'), providers: [], cron: noCron });
    expect(absent.services.find((service) => service.id === 'cron')).toMatchObject({ status: 'unknown' });
  });

  it('boîte : chaque type d’élément, écarté masqué, tri par sévérité puis date', () => {
    const report: PartyReportRecord = { id: 7, roomId: 'r1', messageId: 'm1', by: 'carol', againstId: 'b', against: 'bob', text: 'texte', reason: null, at: NOW, status: 'open', resolvedAt: null };
    const purge: PurgeJob = { id: 'p1', prefix: 'packs', status: 'failed', deleted: 0, startedAt: '2026-10-20T11:00:00.000Z', updatedAt: '2026-10-20T11:30:00.000Z', error: 'kv_timeout' };
    const cronState: TvCronState = { startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:04:00.000Z', durationMs: 1, ok: true, channels: 1, programmes: 1, epgOk: true, error: null };
    const bob = accountOf({ id: 'bob-id', username: 'bob', inviteQuota: 1, invitesUsed: 1 });
    const input = {
      now: NOW,
      reports: [report],
      providers: [providerOf('tmdb', 'down', 'TMDB'), providerOf('fanart', 'degraded', 'Fanart.tv'), providerOf('cinemeta', 'ok')],
      series: [
        { t: '2026-10-20T11:50:00.000Z', errors5xx: 10 },
        { t: '2026-10-20T11:55:00.000Z', errors5xx: 15 },
      ],
      quotaAccounts: [bob, accountOf({ id: 'carol-id', username: 'carol', inviteQuota: 0, invitesUsed: 0 })],
      cron: { state: cronState, overdue: true },
      purges: [purge, { ...purge, id: 'p2', status: 'running' as const }],
      dismissed: [],
    };
    const { items, total } = inboxOf(input);
    expect(total).toBe(items.length);
    // Critique d'abord, puis avertissements les plus récents d'abord (sans date : en dernier), puis infos.
    expect(items.map((item) => item.key)).toEqual(['provider:tmdb', 'report:7', '5xx:2026-10-20T12', 'purge:p1', 'cron:tv', 'provider:fanart', 'quota:bob-id']);
    expect(items.map((item) => item.kind)).toEqual(['provider', 'report', 'errors5xx', 'purge', 'cron', 'provider', 'quota']);
    expect(items[0]).toMatchObject({ severity: 'critical', title: 'TMDB en panne', action: { route: '#/admin/sources' } });
    expect(items.find((item) => item.kind === 'cron')?.action).toEqual({ label: 'Relancer la TV', route: '#/admin/tasks', call: 'tv-rerun' });
    expect(items.find((item) => item.kind === 'errors5xx')).toMatchObject({ severity: 'warn', detail: '25 erreurs 5xx sur la dernière heure' });
    expect(items.find((item) => item.kind === 'quota')).toMatchObject({ severity: 'info', action: { route: '#/admin/accounts/bob-id' } });
    expect(items.find((item) => item.kind === 'report')?.detail).toBe('Signalé par carol contre bob');

    // Écarter une clé la retire ; les autres restent.
    const dismissed = inboxOf({ ...input, dismissed: ['report:7', 'provider:tmdb'] });
    expect(dismissed.items.map((item) => item.key)).not.toContain('report:7');
    expect(dismissed.items.map((item) => item.key)).not.toContain('provider:tmdb');
    expect(dismissed.total).toBe(items.length - 2);
  });

  it('boîte : rien à signaler sous les seuils, comptes sans quota ni quota restant ignorés', () => {
    const result = inboxOf({
      now: NOW,
      reports: [],
      providers: [providerOf('tmdb', 'ok'), providerOf('fanart', 'unknown')],
      series: [{ t: '2026-10-20T11:55:00.000Z', errors5xx: 19 }],
      quotaAccounts: [accountOf({ id: 'a', username: 'a', inviteQuota: 0, invitesUsed: 0 }), accountOf({ id: 'b', username: 'b', inviteQuota: 3, invitesUsed: 2 })],
      cron: { state: null, overdue: false },
      purges: [],
      dismissed: [],
    });
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('fil : 30 événements, récent d’abord, libellés, sans détail d’audit', () => {
    const audit: AuditEntry[] = Array.from({ length: 35 }, (_, index) => ({
      id: index,
      at: new Date(NOW - index * 60_000).toISOString(),
      actor: 'alice',
      actorId: 'alice-id',
      action: index === 0 ? 'account.suspend' : 'unknown.action',
      target: index === 1 ? null : 'bob',
      detail: { password: 'nope', accountIds: ['x'] },
    }));
    const signups = [accountOf({ id: 'c', username: 'carol', createdAt: new Date(NOW - 30_000).toISOString() })];
    const rooms: RegisteredRoom[] = [{ id: 'room1', hostId: 'b', host: 'bob', visibility: 'private', title: 'Soirée privée', mediaType: 'movie', createdAt: new Date(NOW - 45_000).toISOString() }];
    const feed = feedOf(audit, signups, rooms);
    expect(feed).toHaveLength(30);
    expect(feed[0]).toEqual({ at: new Date(NOW).toISOString(), kind: 'audit', label: 'Compte suspendu', target: 'bob' });
    expect(feed[1]).toEqual({ at: new Date(NOW - 30_000).toISOString(), kind: 'signup', label: 'Nouvelle inscription', target: 'carol' });
    expect(feed[2]).toEqual({ at: new Date(NOW - 45_000).toISOString(), kind: 'party', label: 'Salon créé', target: 'bob' });
    // Entrée d'audit sans cible : pas de champ target ; le code d'une action inconnue reste le libellé.
    expect(feed[3]).toEqual({ at: new Date(NOW - 60_000).toISOString(), kind: 'audit', label: 'unknown.action' });
    expect(feed.find((event) => event.label === 'unknown.action' && event.target === 'bob')).toBeDefined();
    expect(JSON.stringify(feed)).not.toMatch(SENSITIVE);
    expect(JSON.stringify(feed)).not.toContain('Soirée privée');
    for (let index = 1; index < feed.length; index += 1) {
      expect(Date.parse(feed[index - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(feed[index]!.at));
    }
  });

  it('deltas : % vs base ; null sans base (absente ou nulle)', () => {
    expect(deltaPercent(10, 5)).toBe(100);
    expect(deltaPercent(3, 4)).toBe(-25);
    expect(deltaPercent(7, 0)).toBeNull();
    expect(deltaPercent(7, null)).toBeNull();
    expect(deltaPercent(null, 4)).toBeNull();
    const empty = overviewOf(undefined, undefined);
    expect(empty).toEqual({ points: [], deltas: { requests: null, errors5xx: null, p95: null } });
    const current = reportOf([['rq|other', 12], ['st|other|5xx', 3]]);
    const previous = reportOf([['rq|other', 10], ['st|other|5xx', 0]], NOW - 60 * 60_000);
    const { points, deltas } = overviewOf(current, previous);
    expect(points).toHaveLength(current.series.length);
    expect(points[0]).toEqual(expect.objectContaining({ requests: expect.any(Number), errors5xx: expect.any(Number) }));
    expect(deltas).toEqual({ requests: 20, errors5xx: null, p95: null });
  });
});

describe('/admin : centre de contrôle (accès)', () => {
  let rig: AdminRig;
  let member: Member;

  afterEach(async () => {
    await rig?.app.close();
  });

  it('sans session : 401 sur chaque route ; compte non propriétaire : 403 owner_only', async () => {
    rig = await startAdmin();
    member = await inviteAndRegister(rig.app, rig.owner, 'bob');
    for (const path of ROUTES) {
      expect((await request(rig.app, 'GET', path)).status, path).toBe(401);
      const res = await request<any>(rig.app, 'GET', path, { token: member.token, headers: { 'x-profile-id': member.profile } });
      expect(res.status, path).toBe(403);
      expect(res.body.error).toBe('owner_only');
    }
  });

  it('statut : services et statut global ; une métrique en panne fait passer l’API en down', async () => {
    const metrics = createMemoryMetrics();
    rig = await startAdmin({ metrics, cacheAdmin: fakeCacheAdmin() });
    for (let index = 0; index < 20; index += 1) metrics.sink.request('other', 500, 5);
    const res = await rig.call<any>('GET', '/admin/status');
    expect(res.status).toBe(200);
    expect(res.body.services.map((service: any) => service.id)).toEqual(['api', 'accounts', 'kv', 'upstream', 'cron']);
    expect(res.body.services.find((service: any) => service.id === 'api')).toMatchObject({ status: 'down', label: 'API' });
    expect(res.body.services.find((service: any) => service.id === 'accounts')).toMatchObject({ status: 'ok' });
    expect(res.body.status).toBe('down');
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('sous-calculs en échec : la route répond 200, services unknown, courbes vides', async () => {
    const broken = { sink: noopSink, report: () => Promise.reject(new Error('métriques indisponibles')) };
    rig = await startAdmin({ metrics: broken });
    const res = await rig.call<any>('GET', '/admin/status');
    expect(res.status).toBe(200);
    expect(res.body.services.find((service: any) => service.id === 'api')).toMatchObject({ status: 'unknown' });
    expect(res.body.services.find((service: any) => service.id === 'kv')).toMatchObject({ status: 'unknown' });
    expect(res.body.services.find((service: any) => service.id === 'cron')).toMatchObject({ status: 'unknown' });
    expect(res.body.services.find((service: any) => service.id === 'accounts')).toMatchObject({ status: 'ok' });
    expect(res.body.status).toBe('ok');
    const inbox = await rig.call<any>('GET', '/admin/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.filter((entry: any) => entry.kind === 'errors5xx')).toEqual([]);
    const series = await rig.call<any>('GET', '/admin/overview-series');
    expect(series.status).toBe(200);
    expect(series.body).toEqual({ points: [], deltas: { requests: null, errors5xx: null, p95: null } });
  });

  it('boîte : signalement agrégé, écarté puis absent, clé stable', async () => {
    rig = await startAdmin({ metrics: createMemoryMetrics() });
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    await inviteAndRegister(rig.app, bob, 'carol');
    await rig.backend.admin().addReport({ roomId: 'salon-1', messageId: 'message-1', by: 'carol', againstId: null, against: 'bob', text: 'texte signalé', reason: 'spam', at: Date.now() });
    const inbox = await rig.call<any>('GET', '/admin/inbox');
    expect(inbox.status).toBe(200);
    const item = inbox.body.items.find((entry: any) => entry.kind === 'report');
    expect(item).toMatchObject({ severity: 'warn', title: 'Signalement de message', action: { route: '#/admin/moderation' } });
    expect(JSON.stringify(inbox.body)).not.toContain('texte signalé');

    const dismissed = await rig.call<any>('POST', `/admin/inbox/${encodeURIComponent(item.key)}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ ok: true });
    const after = await rig.call<any>('GET', '/admin/inbox');
    expect(after.body.items.map((entry: any) => entry.key)).not.toContain(item.key);
  });

  it('boîte : pic 5xx, cron TV en retard, purge échouée, quota épuisé', async () => {
    const metrics = createMemoryMetrics();
    const stale: TvCronState = { startedAt: '2026-10-10T00:00:00.000Z', finishedAt: '2026-10-10T00:04:00.000Z', durationMs: 1, ok: true, channels: 1, programmes: 1, epgOk: true, error: null };
    const cache = fakeCacheAdmin({ packs: 3 });
    cache.jobs.unshift({ id: 'purge-failed', prefix: 'packs', status: 'failed', deleted: 0, startedAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:01:00.000Z', error: 'kv_timeout' });
    rig = await startAdmin({ metrics, cacheAdmin: cache, tvAdmin: { lastCron: () => Promise.resolve(stale), rerun: () => Promise.resolve(undefined) } });
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    await inviteAndRegister(rig.app, bob, 'carol');
    await rig.call('PUT', `/admin/accounts/${await idOf(rig, 'bob')}/invite-quota`, { body: { quota: 1 } });
    for (let index = 0; index < 25; index += 1) metrics.sink.request('other', 500, 5);

    const res = await rig.call<any>('GET', '/admin/inbox');
    const kinds = res.body.items.map((entry: any) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['errors5xx', 'cron', 'purge', 'quota']));
    expect(res.body.items.find((entry: any) => entry.kind === 'cron')).toMatchObject({ action: { call: 'tv-rerun' } });
    expect(res.body.items.find((entry: any) => entry.kind === 'purge')).toMatchObject({ key: 'purge:purge-failed', detail: 'kv_timeout' });
    expect(res.body.items.find((entry: any) => entry.kind === 'quota')).toMatchObject({ key: `quota:${await idOf(rig, 'bob')}` });
    expect(res.body.total).toBe(res.body.items.length);
  });

  it('live : présence, lectures en cours, salons vivants, fil sans donnée sensible', async () => {
    const party = fakeParty();
    rig = await startAdmin({ party, metrics: createMemoryMetrics() });
    await inviteAndRegister(rig.app, rig.owner, 'bob');
    const bobId = await idOf(rig, 'bob');
    await rig.backend.social().setPresence(bobId, null, { type: 'movie', tmdbId: 603, imdbId: null, title: 'Matrix', season: null, episode: null }, false, new Date().toISOString());
    await rig.call('PUT', `/admin/accounts/${bobId}/invite-quota`, { body: { quota: 2 } });
    await rig.backend.social().addPartyRoom({ id: 'salon-vivant', hostId: bobId, visibility: 'public', title: 'Soirée Matrix', poster: null, language: 'fr', mediaType: 'movie', createdAt: new Date().toISOString() });
    await rig.backend.social().addPartyRoom({ id: 'salon-mort', hostId: bobId, visibility: 'private', title: 'Salon privé', poster: null, language: 'fr', mediaType: 'series', createdAt: new Date().toISOString() });
    await party.room('salon-vivant').init(roomMeta('salon-vivant', bobId, 'bob'));

    const res = await rig.call<any>('GET', '/admin/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: 1, watching: 1, parties: 1 });
    expect(res.body.feed.map((event: any) => event.label)).toEqual(expect.arrayContaining(['Nouvelle inscription', 'Salon créé', 'Quota d’invitations modifié']));
    expect(res.body.feed.length).toBeLessThanOrEqual(30);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(SENSITIVE);
    expect(text).not.toContain('Soirée Matrix');
    expect(text).not.toContain('Salon privé');
  });

  it('courbes : deltas en % vs la période précédente de même durée', async () => {
    let shift = 0;
    const metrics = createMemoryMetrics(() => Date.now() + shift);
    rig = await startAdmin({ metrics });
    // Période précédente (il y a 90 min) : 5 requêtes dont une en 5xx. Période courante (il y a 10 min) : 10 requêtes.
    shift = -90 * 60_000;
    for (let index = 0; index < 4; index += 1) metrics.sink.request('other', 200, 10);
    metrics.sink.request('other', 500, 10);
    shift = -10 * 60_000;
    for (let index = 0; index < 10; index += 1) metrics.sink.request('other', 200, 10);
    shift = 0;

    const res = await rig.call<any>('GET', '/admin/overview-series?range=1h');
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(12);
    expect(res.body.points[0]).toEqual(expect.objectContaining({ t: expect.any(String), requests: expect.any(Number), errors5xx: expect.any(Number) }));
    const currentRequests = res.body.points.reduce((sum: number, point: any) => sum + point.requests, 0);
    const currentErrors = res.body.points.reduce((sum: number, point: any) => sum + point.errors5xx, 0);
    // Base : 5 requêtes et 1 erreur 5xx dans la période précédente.
    expect(res.body.deltas.requests).toBe(Math.round(((currentRequests - 5) / 5) * 1000) / 10);
    expect(res.body.deltas.errors5xx).toBe(Math.round(((currentErrors - 1) / 1) * 1000) / 10);
    expect(currentRequests).toBeGreaterThanOrEqual(10);
    expect(res.body.deltas.p95 === null || typeof res.body.deltas.p95 === 'number').toBe(true);
  });

  it('courbes : plage invalide refusée ; sans base, deltas null', async () => {
    rig = await startAdmin({ metrics: createMemoryMetrics() });
    expect((await rig.call('GET', '/admin/overview-series?range=1y')).status).toBe(400);
    const res = await rig.call<any>('GET', '/admin/overview-series');
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(12);
    expect(res.body.deltas).toEqual({ requests: null, errors5xx: null, p95: null });
  });
});

/** Salon simulé (métadonnées minimales) pour l'annuaire vivant. */
function roomMeta(id: string, hostId: string, hostName: string): RoomMeta {
  return {
    id,
    visibility: 'public',
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

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}
