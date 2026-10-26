import { afterEach, describe, expect, it } from 'vitest';
import type { MetaAdmin } from '../src/admin/cache-types.js';
import type { MetaKind } from '../src/lt/meta-policy.js';
import { platform, platformInstalled } from '../src/platform/index.js';
import { inviteAndRegister, request, startAdmin, type AdminRig } from './admin-harness.js';

let rig: AdminRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

/** Fiches partagées simulées : chaque suppression est consignée ; `deleted` est le nombre de couches annoncé. */
function fakeMetaAdmin(deleted = 3): MetaAdmin & { calls: { kind: MetaKind; tmdbId: number }[] } {
  const calls: { kind: MetaKind; tmdbId: number }[] = [];
  return {
    calls,
    deleteFiche: (kind, tmdbId) => {
      calls.push({ kind, tmdbId });
      return Promise.resolve(deleted);
    },
  };
}

describe('DELETE /admin/meta/:type/:id', () => {
  // La plateforme décide de la présence de R2 : sous Node elle n'en fournit pas (501), sous Workers elle lie META (200).
  const platformHasMeta = platformInstalled() && platform().metaAdmin !== undefined;

  it.skipIf(platformHasMeta)('501 meta_admin_unavailable hors Workers (pas de R2 fournie)', async () => {
    rig = await startAdmin();
    const res = await rig.call<{ error: string }>('DELETE', '/admin/meta/movie/7', { elevation: await rig.elevate() });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('meta_admin_unavailable');
  });

  it.runIf(platformHasMeta)('sur Workers, R2 META fournie par la plateforme : 200 et nombre de couches supprimées (0 pour une fiche absente)', async () => {
    rig = await startAdmin();
    const res = await rig.call<{ deleted: number }>('DELETE', '/admin/meta/movie/7', { elevation: await rig.elevate() });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
  });

  it('type ou identifiant invalide : erreur de validation, aucune suppression', async () => {
    const metaAdmin = fakeMetaAdmin();
    rig = await startAdmin({ metaAdmin });
    const elevation = await rig.elevate();
    const invalides = ['/admin/meta/film/7', '/admin/meta/tv/7', '/admin/meta/movie/0', '/admin/meta/movie/-3', '/admin/meta/series/abc', '/admin/meta/series/1234567890'];
    for (const path of invalides) {
      const res = await rig.call<{ error: string }>('DELETE', path, { elevation });
      expect(res.status, path).toBe(400);
      expect(res.body.error, path).toBe('invalid_body');
    }
    expect(metaAdmin.calls).toHaveLength(0);
  });

  it('série : deleteFiche(tv, identifiant) et nombre de couches supprimées', async () => {
    const metaAdmin = fakeMetaAdmin(5);
    rig = await startAdmin({ metaAdmin });
    const res = await rig.call<{ deleted: number }>('DELETE', '/admin/meta/series/123', { elevation: await rig.elevate() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 5 });
    expect(metaAdmin.calls).toEqual([{ kind: 'tv', tmdbId: 123 }]);
  });

  it('film : deleteFiche(movie, identifiant)', async () => {
    const metaAdmin = fakeMetaAdmin(2);
    rig = await startAdmin({ metaAdmin });
    const res = await rig.call<{ deleted: number }>('DELETE', '/admin/meta/movie/7', { elevation: await rig.elevate() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    expect(metaAdmin.calls).toEqual([{ kind: 'movie', tmdbId: 7 }]);
  });

  it('refus sans élévation ni session propriétaire, comme la purge de cache', async () => {
    const metaAdmin = fakeMetaAdmin();
    rig = await startAdmin({ metaAdmin });
    expect((await rig.call('DELETE', '/admin/meta/movie/7')).status).toBe(403);
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    expect((await request(rig.app, 'DELETE', '/admin/meta/movie/7', { token: bob.token })).status).toBe(403);
    expect(metaAdmin.calls).toHaveLength(0);
  });

  it('audit meta.delete : cible type/identifiant saisi, acteur propriétaire', async () => {
    rig = await startAdmin({ metaAdmin: fakeMetaAdmin() });
    await rig.call('DELETE', '/admin/meta/series/123', { elevation: await rig.elevate() });
    const audit = await rig.call<{ entries: { action: string; target: string; actor: string }[] }>('GET', '/admin/audit?action=meta.delete');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({ target: 'series/123', actor: 'alice' });
  });
});
