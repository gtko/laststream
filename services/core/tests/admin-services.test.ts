/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importableKeys } from '../src/admin/ops-services.js';
import { encodeConfig } from '../src/config/codec.js';
import { SECRET } from './harness-core.js';
import { inviteAndRegister, request, startAdmin, type AdminRig } from './admin-harness.js';

/* Clés des services gérées dans l'administration : lecture masquée, écriture et import depuis le compte, sous élévation. */

let rig: AdminRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
  vi.unstubAllEnvs();
});

const TMDB = 'tmdb-jeton-admin-0123456789abcdef';
const OPENROUTER = 'sk-or-admin-0123456789abcdef';

/** Enregistre la configuration du compte propriétaire (profil principal), comme le fait l'app. */
async function putAccountConfig(r: AdminRig, services: Record<string, string>): Promise<void> {
  const config = encodeConfig({ services }, SECRET);
  const res = await request(r.app, 'PUT', '/user/account/config', { token: r.owner.token, headers: { 'x-profile-id': r.owner.profile }, body: { config } });
  expect(res.status).toBe(200);
}

describe('/admin/services', () => {
  it('lecture : état masqué, origine (base, variable, aucune), jamais la valeur', async () => {
    vi.stubEnv('MDBLIST_API_KEY', 'mdblist-variable-0123456789');
    rig = await startAdmin();
    const res = await rig.call<any>('GET', '/admin/services');
    expect(res.status).toBe(200);
    expect(res.body.services.mdblistApiKey).toEqual({ set: true, last4: '…6789', source: 'env' });
    expect(res.body.services.tmdbToken).toEqual({ set: false, source: 'none' });
    expect(res.body.services.openrouterModel).toEqual({ set: false, source: 'none' });
    expect(JSON.stringify(res.body)).not.toContain('mdblist-variable');
  });

  it('écriture : élévation exigée, puis clé enregistrée, effaçable, auditée sans valeur', async () => {
    rig = await startAdmin();
    const denied = await rig.call<any>('PUT', '/admin/services', { body: { tmdbToken: TMDB } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('elevation_required');
    const elevation = await rig.elevate();
    const put = await rig.call<any>('PUT', '/admin/services', { elevation, body: { tmdbToken: TMDB, openrouterModel: 'anthropic/claude-test' } });
    expect(put.status).toBe(200);
    expect(put.body.services.tmdbToken).toEqual({ set: true, last4: '…cdef', source: 'db' });
    expect(put.body.services.openrouterModel).toEqual({ set: true, value: 'anthropic/claude-test', source: 'db' });
    expect(JSON.stringify(put.body)).not.toContain(TMDB);
    const cleared = await rig.call<any>('PUT', '/admin/services', { elevation, body: { tmdbToken: null } });
    expect(cleared.body.services.tmdbToken).toEqual({ set: false, source: 'none' });
    const audit = await rig.call<any>('GET', '/admin/audit?action=services.update');
    expect(audit.body.entries).toHaveLength(2);
    expect(JSON.stringify(audit.body)).not.toContain(TMDB);
    expect(audit.body.entries.map((e: any) => e.detail)).toEqual(expect.arrayContaining([
      { set: ['tmdbToken', 'openrouterModel'], cleared: [] },
      { set: [], cleared: ['tmdbToken'] },
    ]));
  });

  it('écriture : champ inconnu ou corps vide refusés (400)', async () => {
    rig = await startAdmin();
    const elevation = await rig.elevate();
    expect((await rig.call('PUT', '/admin/services', { elevation, body: { inconnu: 'x' } })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/services', { elevation, body: {} })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/services', { elevation, body: { tmdbToken: 'x'.repeat(501) } })).status).toBe(400);
  });

  it('import : reprend les clés du compte propriétaire, qui servent ensuite aux tests des fournisseurs', async () => {
    rig = await startAdmin();
    await putAccountConfig(rig, { tmdbToken: TMDB, openrouterApiKey: OPENROUTER, openrouterModel: 'openai/gpt-4o' });
    const before = await rig.call<any>('GET', '/admin/providers');
    expect(before.body.providers.find((p: any) => p.id === 'tmdb').testable).toBe(false);
    const elevation = await rig.elevate();
    const res = await rig.call<any>('POST', '/admin/services/import', { elevation });
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual(['tmdbToken', 'openrouterApiKey', 'openrouterModel']);
    expect(res.body.services.tmdbToken).toMatchObject({ set: true, source: 'db' });
    expect(res.body.services.openrouterApiKey).toMatchObject({ set: true, source: 'db' });
    expect(res.body.services.openrouterModel).toEqual({ set: true, value: 'openai/gpt-4o', source: 'db' });
    expect(JSON.stringify(res.body)).not.toContain(TMDB);
    expect(JSON.stringify(res.body)).not.toContain(OPENROUTER);
    const after = await rig.call<any>('GET', '/admin/providers');
    expect(after.body.providers.find((p: any) => p.id === 'tmdb').testable).toBe(true);
    expect(after.body.providers.find((p: any) => p.id === 'openrouter').testable).toBe(true);
    expect((await rig.call<any>('GET', '/admin/audit?action=services.import')).body.entries[0].detail).toEqual({ imported: ['tmdbToken', 'openrouterApiKey', 'openrouterModel'] });
  });

  it('import : élévation exigée ; compte sans configuration : 404', async () => {
    rig = await startAdmin();
    expect((await rig.call<any>('POST', '/admin/services/import')).body.error).toBe('elevation_required');
    const res = await rig.call<any>('POST', '/admin/services/import', { elevation: await rig.elevate() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_config_missing');
  });

  it('réservé au propriétaire : un autre compte reçoit 403', async () => {
    rig = await startAdmin();
    const other = await inviteAndRegister(rig.app, rig.owner, 'invitee');
    const res = await request(rig.app, 'GET', '/admin/services', { token: other.token, headers: { 'x-profile-id': other.profile } });
    expect(res.status).toBe(403);
  });
});

describe('importableKeys', () => {
  it('garde les clés non vides ; le modèle seulement avec une clé OpenRouter', () => {
    expect(importableKeys({ tmdbToken: ' abc ', mdblistApiKey: '', openrouterModel: 'openai/gpt-4o-mini', autre: 'x' })).toEqual({ tmdbToken: 'abc' });
    expect(importableKeys({ openrouterApiKey: 'k', openrouterModel: 'm' })).toEqual({ openrouterApiKey: 'k', openrouterModel: 'm' });
  });
});
