/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it } from 'vitest';
import { type AdminRig, inviteAndRegister, type Member, request, startAdmin } from './admin-harness.js';

let rig: AdminRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
  delete process.env.LASTADDON_READ_RATE_LIMIT;
});

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('annonces : gestion par le propriétaire', () => {
  it('création, lecture, modification partielle et suppression, chacune auditée', async () => {
    const r = (rig = await startAdmin());
    const elevation = await r.elevate();
    const created = await r.call<any>('POST', '/admin/announcements', { elevation, body: { title: 'Maintenance', message: 'Coupure mardi soir', level: 'warning' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Maintenance', message: 'Coupure mardi soir', level: 'warning', startsAt: null, endsAt: null, active: true });
    expect(created.body.id).toMatch(UUID);
    const id: string = created.body.id;

    const list = await r.call<any>('GET', '/admin/announcements');
    expect(list.status).toBe(200);
    expect(list.body.announcements.map((a: any) => a.id)).toEqual([id]);

    const renamed = await r.call<any>('PUT', `/admin/announcements/${id}`, { elevation, body: { title: 'Maintenance reportée' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Maintenance reportée', message: 'Coupure mardi soir', level: 'warning', active: true });

    const deactivated = await r.call<any>('PUT', `/admin/announcements/${id}`, { elevation, body: { active: false } });
    expect(deactivated.body.active).toBe(false);

    expect((await r.call('DELETE', `/admin/announcements/${id}`, { elevation })).status).toBe(204);
    expect((await r.call<any>('GET', '/admin/announcements')).body.announcements).toEqual([]);

    const audit = await r.call<any>('GET', '/admin/audit?limit=50');
    const actions: string[] = audit.body.entries.map((e: any) => e.action);
    expect(actions.filter((a) => a === 'announcement.create')).toHaveLength(1);
    expect(actions.filter((a) => a === 'announcement.update')).toHaveLength(2);
    expect(actions.filter((a) => a === 'announcement.delete')).toHaveLength(1);
  });

  it('dates ISO normalisées en UTC à l’écriture', async () => {
    const r = (rig = await startAdmin());
    const res = await r.call<any>('POST', '/admin/announcements', {
      elevation: await r.elevate(),
      body: { title: 'Fuseau', message: 'Heure locale', level: 'info', startsAt: '2026-10-20T12:00:00+02:00', endsAt: '2026-10-21' },
    });
    expect(res.status).toBe(201);
    expect(res.body.startsAt).toBe('2026-10-20T10:00:00.000Z');
    expect(res.body.endsAt).toBe('2026-10-21T00:00:00.000Z');
  });

  it('validation : bornes de longueur, niveau, dates, champs inconnus, fenêtre inversée et patch vide refusés', async () => {
    const r = (rig = await startAdmin());
    const base = { title: 'x', message: 'y', level: 'info' };
    const elevation = await r.elevate();
    const post = (body: unknown) => r.call<any>('POST', '/admin/announcements', { elevation, body });

    expect((await post({ ...base, title: 'a'.repeat(80) })).status).toBe(201);
    expect((await post({ ...base, title: 'a'.repeat(81) })).status).toBe(400);
    expect((await post({ ...base, title: '   ' })).status).toBe(400);
    expect((await post({ ...base, message: 'm'.repeat(500) })).status).toBe(201);
    expect((await post({ ...base, message: 'm'.repeat(501) })).status).toBe(400);
    expect((await post({ ...base, level: 'error' })).status).toBe(400);
    expect((await post({ ...base, startsAt: 'bientot' })).status).toBe(400);
    expect((await post({ ...base, startsAt: '2026-10-20T10:00:00' })).status).toBe(400); // fuseau obligatoire avec l’heure
    expect((await post({ ...base, id: 'forgé' })).status).toBe(400);
    expect((await post({ ...base, startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T09:00:00Z' })).status).toBe(400);
    expect((await post(undefined)).status).toBe(400);

    const made = await post({ ...base, title: 'Fenêtre', startsAt: '2026-10-20T10:00:00Z' });
    expect(made.status).toBe(201);
    const id: string = made.body.id;
    // La fin ne peut pas rejoindre ou dépasser le début déjà enregistré.
    expect((await r.call('PUT', `/admin/announcements/${id}`, { elevation, body: { endsAt: '2026-10-20T10:00:00Z' } })).status).toBe(400);
    expect((await r.call('PUT', `/admin/announcements/${id}`, { elevation, body: {} })).status).toBe(400);
    expect((await r.call('PUT', `/admin/announcements/${crypto.randomUUID()}`, { elevation, body: { active: true } })).status).toBe(404);
    expect((await r.call('PUT', '/admin/announcements/pas-un-identifiant', { elevation, body: { active: true } })).status).toBe(400);
    expect((await r.call('DELETE', `/admin/announcements/${crypto.randomUUID()}`, { elevation })).status).toBe(404);
  });
});

describe('annonces et boîte de contrôle : accès réservé au propriétaire', () => {
  it('sans session : 401 ; compte non propriétaire : 403 owner_only, sans rien écrire', async () => {
    const r = (rig = await startAdmin());
    const member: Member = await inviteAndRegister(r.app, r.owner, 'bob');
    const routes: [string, string, unknown?][] = [
      ['GET', '/admin/announcements'],
      ['POST', '/admin/announcements', { title: 't', message: 'm', level: 'info' }],
      ['PUT', `/admin/announcements/${crypto.randomUUID()}`, { active: false }],
      ['DELETE', `/admin/announcements/${crypto.randomUUID()}`],
      ['POST', '/admin/inbox/report:1/dismiss'],
    ];
    for (const [method, path, body] of routes) {
      expect((await request(r.app, method, path, { body })).status, `${method} ${path} sans session`).toBe(401);
      const denied = await request<any>(r.app, method, path, { token: member.token, body });
      expect(denied.status, `${method} ${path} non propriétaire`).toBe(403);
      expect(denied.body.error).toBe('owner_only');
    }
    expect((await r.call<any>('GET', '/admin/announcements')).body.announcements).toEqual([]);
    expect(await r.backend.admin().listDismissedKeys()).toEqual([]);
  });

  it('propriétaire sans élévation : 403 elevation_required sur POST, PUT et DELETE, sans rien écrire', async () => {
    const r = (rig = await startAdmin());
    const made = await r.call<any>('POST', '/admin/announcements', { elevation: await r.elevate(), body: { title: 'Gardée', message: 'Intacte', level: 'info' } });
    const id: string = made.body.id;
    const writes: [string, string, unknown?][] = [
      ['POST', '/admin/announcements', { title: 'Sans élévation', message: 'm', level: 'info' }],
      ['PUT', `/admin/announcements/${id}`, { title: 'Modifiée' }],
      ['DELETE', `/admin/announcements/${id}`],
    ];
    for (const [method, path, body] of writes) {
      const res = await r.call<any>(method, path, { body });
      expect(res.status, `${method} ${path} sans élévation`).toBe(403);
      expect(res.body.error).toBe('elevation_required');
    }
    const listed = (await r.call<any>('GET', '/admin/announcements')).body.announcements;
    expect(listed).toEqual([expect.objectContaining({ id, title: 'Gardée', message: 'Intacte' })]);
  });
});

describe('lecture publique GET /announcements', () => {
  it('ne renvoie que les annonces actives dans leur fenêtre, et seulement quatre champs', async () => {
    const r = (rig = await startAdmin());
    const now = Date.now();
    const elevation = await r.elevate();
    const make = (title: string, extra: Record<string, unknown> = {}) =>
      r.call<any>('POST', '/admin/announcements', { elevation, body: { title, message: `${title} : message`, level: 'info', ...extra } });
    const noBounds = await make('sans-bornes');
    const inWindow = await make('en-cours', { startsAt: iso(now - HOUR), endsAt: iso(now + HOUR) });
    const openEnd = await make('depuis-hier', { startsAt: iso(now - 24 * HOUR), endsAt: null });
    await make('pas-encore', { startsAt: iso(now + HOUR) });
    await make('terminee', { endsAt: iso(now - HOUR) });
    await make('desactivee', { active: false });

    const res = await request<any>(r.app, 'GET', '/announcements');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(Object.keys(res.body)).toEqual(['announcements']);
    expect(res.body.announcements.map((a: any) => a.title).sort()).toEqual(['depuis-hier', 'en-cours', 'sans-bornes']);
    expect(res.body.announcements.map((a: any) => a.id).sort()).toEqual([noBounds.body.id, inWindow.body.id, openEnd.body.id].sort());
    for (const item of res.body.announcements) {
      expect(Object.keys(item).sort()).toEqual(['id', 'level', 'message', 'title']);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/active|startsAt|endsAt|createdAt|updatedAt|alice/);
  });

  it('une annonce disparaît dès que sa fin est passée', async () => {
    const r = (rig = await startAdmin());
    const endsAt = Date.now() + 2_500;
    await r.call('POST', '/admin/announcements', { elevation: await r.elevate(), body: { title: 'Éphémère', message: 'Court', level: 'info', endsAt: iso(endsAt) } });
    expect((await request<any>(r.app, 'GET', '/announcements')).body.announcements).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, endsAt - Date.now()) + 50));
    expect((await request<any>(r.app, 'GET', '/announcements')).body.announcements).toEqual([]);
  }, 15_000);

  it('aucune annonce : liste vide, sans créer de données', async () => {
    rig = await startAdmin();
    const res = await request<any>(rig.app, 'GET', '/announcements');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ announcements: [] });
  });

  it('limitée par IP comme les autres lectures publiques : 429 au-delà de la limite', async () => {
    process.env.LASTADDON_READ_RATE_LIMIT = '3';
    const r = (rig = await startAdmin());
    for (let i = 0; i < 3; i++) expect((await request(r.app, 'GET', '/announcements')).status).toBe(200);
    const limited = await request<any>(r.app, 'GET', '/announcements');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('boîte de contrôle : éléments écartés', () => {
  it('écartement persistant, idempotent et audité ; clé trop longue ou avec caractère de contrôle refusée', async () => {
    const r = (rig = await startAdmin());
    const first = await r.call<any>('POST', '/admin/inbox/report:42/dismiss');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect((await r.call('POST', '/admin/inbox/report:42/dismiss')).status).toBe(200);
    expect((await r.backend.admin().listDismissedKeys()).filter((key) => key === 'report:42')).toHaveLength(1);

    expect((await r.call('POST', `/admin/inbox/${'k'.repeat(120)}/dismiss`)).status).toBe(200);
    expect((await r.call('POST', `/admin/inbox/${'k'.repeat(121)}/dismiss`)).status).toBe(400);
    expect((await r.call('POST', '/admin/inbox/a%0Ab/dismiss')).status).toBe(400);

    const audit = await r.call<any>('GET', '/admin/audit?action=inbox.dismiss');
    expect(audit.body.entries.map((e: any) => e.target)).toContain('report:42');
  });
});
