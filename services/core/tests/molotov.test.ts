import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptJson } from '../src/config/codec.js';
import { MOLOTOV_API, MOLOTOV_HEADERS, MOLOTOV_UA } from '../src/user/molotov.js';
import { json, mockUpstream, SECRET, type MockUpstream } from './harness-core.js';
import { addKidProfile, request, startAdmin, type AdminRig } from './admin-harness.js';
import { createProfileVia, type ErrorBody } from './user-harness.js';

const asProfile = (profile: string) => ({ 'x-profile-id': profile });

const ID_TOKEN = 'jeton-molotov-id-token';
const REFRESH_TOKEN = 'jeton-molotov-refresh';
const NEW_ID_TOKEN = 'jeton-molotov-id-token-neuf';
const NEW_REFRESH_TOKEN = 'jeton-molotov-refresh-neuf';
const MFA_TOKEN = 'jeton-mfa';
const NEW_MFA_TOKEN = 'jeton-mfa-neuf';
const MFA_CODE = '123456';
const DRM_TOKEN = 'jeton-drm';
const CHALLENGE = Buffer.from('challenge-widevine-binaire', 'utf8');
const LICENSE_BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);

const CATALOGUE = {
  pages: [
    {
      title: 'En direct',
      items: [
        { channel_id: 'ch-2', name: 'Canal B', logo: 'https://img.example/b.png' },
        {
          channel_id: 'ch-1',
          name: 'Canal A',
          callSign: 'CANAL-A',
          logoOnDarkUrl: 'https://img.example/a.png',
          group: 'Général',
          program: { title: 'Émission A' },
        },
        { channel_id: 'ch-3' },
        { name: 'Sans identifiant' },
      ],
    },
  ],
};

const ASSET = {
  stream: { url: 'https://cdn.example/master.mpd', packagingProtocol: 'dash', drmProtected: true },
  drm: { provider: 'irdeto', scheme: 'widevine', licenseUrl: `${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x`, token: DRM_TOKEN },
  heartbeat: { method: 'POST', url: `${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-1&id=LIVE_1&type=live`, payload: { passback: { a: 1 }, pdt: '@', progress: '@' } },
};

interface StatusBody {
  connected: boolean;
  tier: string | null;
  userId: string | null;
  profileId: string | null;
  email: string | null;
  channelCount: number;
  updatedAt: number | null;
}

interface ChannelsBody {
  channels: Array<{ id: string; name: string; callSign: string | null; logo: string | null; group: string | null; live: boolean; program: string | null }>;
  fetchedAt: number;
  rawChannelCount: number;
}

interface PlayBody {
  channelId: string;
  manifestUrl: string;
  drm: { scheme: string | null; licenseUrl: string | null; licenseToken: string | null };
  heartbeatUrl: string | null;
  heartbeatPayload: Record<string, unknown> | null;
  assetId: string | null;
  expiresAt: number;
}

describe('compte Molotov', () => {
  let rig: AdminRig;
  let upstream: MockUpstream;
  /** Corps binaires reçus par l'API (relais de licence). */
  let binaryBodies: Uint8Array[] = [];
  /** Nombre d'appels à `/papi/v1/config` : le premier renvoie 401 (session expirée). */
  let configCalls = 0;
  /** Réponse de `PUT /v2/signin`, pilotée par les tests (identifiants acceptés, refusés, ou vérification en deux étapes). */
  let signinReply: () => Response = () => json({ idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN });
  /** Réponse de `PUT /mfa/verify`, pilotée par les tests (code accepté ou refusé). */
  let verifyReply: () => Response = () => json({ idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN });
  /** Réponse de `PUT /mfa/email/resend`, pilotée par les tests (le jeton de défi peut changer). */
  let resendReply: () => Response = () => json({ payload: { token: NEW_MFA_TOKEN } });

  beforeAll(async () => {
    upstream = mockUpstream({
      [`${MOLOTOV_API}/profile`]: () => json({ userId: 'user-1', profileId: 'prof-1', email: 'alice@example.test' }),
      [`${MOLOTOV_API}/users/tier`]: () => json({ tier: 'premium' }),
      [`${MOLOTOV_API}/papi/v1/page/live-tv`]: () => json(CATALOGUE),
      [`${MOLOTOV_API}/papi/v1/main-navigation`]: () => json({ ok: true }),
      [`${MOLOTOV_API}/vapi/asset/v1`]: () => json(ASSET),
      [`${MOLOTOV_API}/vapi/heartbeat/v2`]: () => json({ ok: true }),
      [`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license`]: () => new Response(LICENSE_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      [`${MOLOTOV_API}/refresh`]: () => json({ idToken: NEW_ID_TOKEN, refreshToken: NEW_REFRESH_TOKEN }),
      [`${MOLOTOV_API}/oauth/google`]: () => json({ error: 'invalid_google_client' }, 400),
      [`${MOLOTOV_API}/v2/signin`]: () => signinReply(),
      [`${MOLOTOV_API}/mfa/verify`]: () => verifyReply(),
      [`${MOLOTOV_API}/mfa/email/resend`]: () => resendReply(),
      [`${MOLOTOV_API}/papi/v1/config`]: () => {
        configCalls += 1;
        return configCalls === 1 ? json({ error: 'expired' }, 401) : json({ ok: true });
      },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.body instanceof Uint8Array) binaryBodies.push(new Uint8Array(init.body));
      return upstream.fetch(input, init);
    };
    rig = await startAdmin({ fetch: fetchImpl });
  });

  afterAll(async () => {
    await rig.app.close();
  });

  const connect = () =>
    request(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN },
    });

  /** Ligne chiffrée du compte propriétaire, lue hors API. */
  const storedRow = async (): Promise<{ accountId: string; tokens: string; profile: string | null } | null> => {
    const accounts = await rig.backend.admin().listAccounts({ limit: 50 } as never);
    for (const account of accounts.accounts) {
      const row = await rig.backend.users().getMolotovAccount(account.id);
      if (row !== null) return { accountId: account.id, tokens: row.tokens, profile: row.profile };
    }
    return null;
  };

  it('sans session : 401 ; corps vide : 400 ; profil secondaire : 403', async () => {
    expect((await request(rig.app, 'GET', '/user/account/molotov')).status).toBe(401);
    expect((await request(rig.app, 'PUT', '/user/account/molotov', { body: {} })).status).toBe(401);
    const empty = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: {},
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('invalid_body');
    const secondary = await createProfileVia(rig.app, rig.owner.token, { name: 'Second' });
    const kid = await addKidProfile(rig.app, rig.owner);
    for (const profile of [secondary.body.id, kid, undefined]) {
      const res = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
        token: rig.owner.token,
        headers: profile === undefined ? {} : asProfile(profile),
        body: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('main_profile_required');
    }
  });

  it('connexion puis état du compte (jamais les jetons)', async () => {
    const put = await connect();
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });
    const res = await request<StatusBody>(rig.app, 'GET', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(res.body.userId).toBe('user-1');
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
  });

  it('credentials : jetons en clair pour l\'appel direct depuis l\'appareil', async () => {
    await connect();
    const res = await request<{ idToken: string; refreshToken: string; expiresAt: number | null }>(rig.app, 'GET', '/user/account/molotov/credentials', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.idToken).toBe(ID_TOKEN);
    expect(res.body.refreshToken).toBe(REFRESH_TOKEN);
    const secondary = await request(rig.app, 'GET', '/user/account/molotov/credentials', { token: rig.owner.token });
    expect(secondary.status).toBe(403);
  });

  it('catalogue : extraction défensive des chaînes', async () => {
    await connect();
    const res = await request<ChannelsBody>(rig.app, 'GET', '/user/account/molotov/channels', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body.channels.map((channel) => channel.id)).toEqual(['ch-1', 'ch-2']);
    expect(res.body.channels[0]?.name).toBe('Canal A');
    expect(res.body.channels[0]?.logo).toBe('https://img.example/a.png');
    expect(res.body.channels[0]?.callSign).toBe('CANAL-A');
    expect(res.body.channels[0]?.program).toBe('Émission A');
    expect(res.body.channels[0]?.live).toBe(true);
    expect(res.body.rawChannelCount).toBe(3);
    expect(res.body.fetchedAt).toBeGreaterThan(0);
  });

  it('lecture : manifeste, DRM et battement de cœur', async () => {
    await connect();
    const res = await request<PlayBody>(rig.app, 'POST', '/user/account/molotov/play', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.manifestUrl).toBe('https://cdn.example/master.mpd');
    expect(res.body.drm.scheme).toBe('widevine');
    expect(res.body.drm.licenseUrl).toBe(`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x`);
    expect(res.body.drm.licenseToken).toBe(DRM_TOKEN);
    expect(res.body.heartbeatUrl).toBe(`${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-1&id=LIVE_1&type=live`);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    expect(res.body.channelId).toBe('ch-1');
    expect(res.body.assetId).toBe('LIVE_1');
  });

  it('heartbeat : progression relayée vers l\'API', async () => {
    await connect();
    const res = await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', assetId: 'LIVE_1', progress: 12345 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    expect(call?.url.searchParams.get('channelId')).toBe('ch-1');
    expect(call?.url.searchParams.get('id')).toBe('LIVE_1');
    expect(call?.url.searchParams.get('type')).toBe('live');
    const sent = JSON.parse(call?.body ?? '{}') as { passback: unknown; pdt: number; progress: number };
    expect(sent.progress).toBe(12345);
    expect(typeof sent.pdt).toBe('number');
  });

  it('heartbeat : la charge utile amont n\'est pas ré-encapsulée', async () => {
    await connect();
    await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', progress: 42, payload: { passback: { a: 1 }, pdt: '@', progress: '@' } },
    });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    const sent = JSON.parse(call?.body ?? '{}') as { passback: { a: number }; pdt: number; progress: number };
    expect(sent.passback).toEqual({ a: 1 });
    expect(sent.progress).toBe(42);
    expect(typeof sent.pdt).toBe('number');
  });

  it('heartbeat : un assetId absent n\'est pas envoyé comme « undefined »', async () => {
    await connect();
    await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', progress: 7 },
    });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    expect(call?.url.searchParams.has('id')).toBe(false);
  });

  it('le relais exige le profil principal', async () => {
    await connect();
    const kid = await addKidProfile(rig.app, rig.owner);
    const res = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config', {
      token: rig.owner.token,
      headers: asProfile(kid),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('main_profile_required');
  });

  it('un client Google refusé par l\'API est remonté tel quel', async () => {
    const res = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { googleToken: 'jeton-google' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('google_token_rejected');
  });

  it('connexion par email/mot de passe : session enregistrée, profil amont récupéré', async () => {
    signinReply = () => json({ type: 'SUCCESS', payload: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN } });
    const res = await request<StatusBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(res.body.userId).toBe('user-1');
    expect(res.body.updatedAt).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
    const signin = upstream.callsTo(`${MOLOTOV_API}/v2/signin`).at(-1);
    expect(signin?.method).toBe('PUT');
    expect(JSON.parse(signin?.body ?? '{}')).toEqual({ username: 'alice@example.test', password: 'mot-de-passe' });
    expect(signin?.headers['content-type']).toBe('application/json');
    expect(signin?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(signin?.headers['origin']).toBe('https://app.molotov.tv');
    expect(signin?.headers['authorization']).toBeUndefined();
    const profile = upstream.callsTo(`${MOLOTOV_API}/profile`).at(-1);
    expect(profile?.headers['authorization']).toBe(`Bearer ${ID_TOKEN}`);
  });

  it('identifiants invalides : 401 invalid_credentials, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    signinReply = () => json({ code: 'INVALID_USERNAME_PASSWORD' }, 401);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'faux' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(await storedRow()).toBeNull();
  });

  it('limite de débit amont : 429 rate_limited', async () => {
    signinReply = () => json({ code: 'CHILL_PLZ' }, 429);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  it('connexion avec vérification en deux étapes : 200 mfa_required, jeton de défi, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    signinReply = () => json({ type: 'MFA', payload: { token: MFA_TOKEN } });
    const res = await request<{ status: string; mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ status: 'mfa_required', mfaToken: MFA_TOKEN });
    expect(await storedRow()).toBeNull();
    const signin = upstream.callsTo(`${MOLOTOV_API}/v2/signin`).at(-1);
    expect(signin?.method).toBe('PUT');
    expect(JSON.parse(signin?.body ?? '{}')).toEqual({ username: 'alice@example.test', password: 'mot-de-passe' });
    expect(signin?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(signin?.headers['origin']).toBe('https://app.molotov.tv');
    expect(signin?.headers['authorization']).toBeUndefined();
  });

  it('vérification du code : 200 connecté, jetons chiffrés au repos', async () => {
    verifyReply = () => json({ payload: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN } });
    const res = await request<StatusBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: MFA_CODE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
    const verify = upstream.callsTo(`${MOLOTOV_API}/mfa/verify`).at(-1);
    expect(verify?.method).toBe('PUT');
    expect(JSON.parse(verify?.body ?? '{}')).toEqual({ code: MFA_CODE });
    expect(verify?.headers['x-mfa-token']).toBe(MFA_TOKEN);
    expect(verify?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(verify?.headers['authorization']).toBeUndefined();
    const row = await storedRow();
    expect(row).not.toBeNull();
    expect(row?.tokens).not.toContain(ID_TOKEN);
    expect(row?.tokens).not.toContain(REFRESH_TOKEN);
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(ID_TOKEN);
    expect(plain.refreshToken).toBe(REFRESH_TOKEN);
  });

  it('code refusé par l\'API (4xx) : 401 invalid_code, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    verifyReply = () => json({ code: 'INVALID_CODE' }, 401);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: '000000' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_code');
    expect(JSON.stringify(res.body)).not.toContain(MFA_TOKEN);
    expect(await storedRow()).toBeNull();
  });

  it('trop d\'essais (CHILL_PLZ) : 429 rate_limited', async () => {
    verifyReply = () => json({ code: 'CHILL_PLZ' }, 429);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: MFA_CODE },
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  it('renvoi du code : 200 avec le jeton renvoyé (changement ou conservation)', async () => {
    resendReply = () => json({ payload: { token: NEW_MFA_TOKEN } });
    const res = await request<{ mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin/resend', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ mfaToken: NEW_MFA_TOKEN });
    const call = upstream.callsTo(`${MOLOTOV_API}/mfa/email/resend`).at(-1);
    expect(call?.method).toBe('PUT');
    expect(call?.body).toBe('');
    expect(call?.headers['x-mfa-token']).toBe(MFA_TOKEN);
    expect(call?.headers['authorization']).toBeUndefined();
    resendReply = () => json({ ok: true });
    const kept = await request<{ mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin/resend', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: NEW_MFA_TOKEN },
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual({ mfaToken: NEW_MFA_TOKEN });
  });

  it('relais : chemin hors liste refusé, URL absolue refusée, en-têtes x-* et Authorization relayés', async () => {
    await connect();
    const unknown = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/admin/users', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unsupported_path');
    const absolute = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config&query=url=https://evil.example/x', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(absolute.status).toBe(400);
    expect(absolute.body.error).toBe('invalid_body');
    const ok = await request<{ ok: boolean }>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/main-navigation&query=a=1', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const call = upstream.callsTo(`${MOLOTOV_API}/papi/v1/main-navigation`).at(-1);
    expect(call?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(call?.headers['x-client-version']).toBe(MOLOTOV_HEADERS['x-client-version']);
    expect(call?.headers['x-drm-scheme']).toBe('widevine');
    expect(call?.headers['origin']).toBe('https://app.molotov.tv');
    expect(call?.headers['user-agent']).toBe(MOLOTOV_UA);
    expect(call?.headers['authorization']).toBe(`Bearer ${ID_TOKEN}`);
    expect(call?.url.searchParams.get('a')).toBe('1');
    expect((await request(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/main-navigation')).status).toBe(401);
  });

  it('relais licence : octets bruts, hôte imposé', async () => {
    await connect();
    binaryBodies = [];
    const res = await fetch(`${rig.app.baseUrl}/user/account/molotov/license`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rig.owner.token}`,
        'x-profile-id': rig.owner.profile,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        licenseUrl: `${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x&ls_session=abc`,
        token: DRM_TOKEN,
        challenge: CHALLENGE.toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LICENSE_BYTES);
    expect(binaryBodies[0]).toEqual(new Uint8Array(CHALLENGE));
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license`).at(-1);
    expect(call?.headers['authorization']).toBe(`Bearer ${DRM_TOKEN}`);
    expect(call?.headers['content-type']).toBe('application/octet-stream');
    const refused = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/license', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: {
        licenseUrl: 'https://irdeto.fubo.tv/licenseServer/widevine/v1/FuboTV/license',
        token: DRM_TOKEN,
        challenge: CHALLENGE.toString('base64'),
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_body');
  });

  it('chiffrement au repos : les jetons stockés sont opaques et se rejouent', async () => {
    await connect();
    const row = await storedRow();
    expect(row).not.toBeNull();
    expect(row?.tokens).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row?.tokens).not.toContain(ID_TOKEN);
    expect(row?.tokens).not.toContain(REFRESH_TOKEN);
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(ID_TOKEN);
    expect(plain.refreshToken).toBe(REFRESH_TOKEN);
    expect(row?.profile).not.toBeNull();
    expect(row?.profile).not.toContain('alice@example.test');
  });

  it('401 amont : rafraîchissement puis rejeu, jetons réécrits', async () => {
    await connect();
    configCalls = 0;
    const res = await request<{ ok: boolean }>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const refresh = upstream.callsTo(`${MOLOTOV_API}/refresh`).at(-1);
    expect(refresh?.headers['authorization']).toBe(`Bearer ${REFRESH_TOKEN}`);
    const row = await storedRow();
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(NEW_ID_TOKEN);
    expect(plain.refreshToken).toBe(NEW_REFRESH_TOKEN);
  });

  it('relais désactivé (LASTADDON_MOLOTOV_RELAY=0) : 403 relay_disabled', async () => {
    await connect();
    vi.stubEnv('LASTADDON_MOLOTOV_RELAY', '0');
    try {
      for (const [method, path] of [
        ['GET', '/user/account/molotov/relay?path=/papi/v1/config'],
        ['GET', '/user/account/molotov/channels'],
        ['POST', '/user/account/molotov/play'],
        ['POST', '/user/account/molotov/heartbeat'],
        ['POST', '/user/account/molotov/license'],
      ] as const) {
        const res = await request<ErrorBody>(rig.app, method, path, {
          token: rig.owner.token,
          headers: asProfile(rig.owner.profile),
          body: method === 'POST' ? { channelId: 'ch-1', assetId: 'LIVE_1', progress: 1 } : undefined,
        });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('relay_disabled');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('déconnexion : la ligne disparaît et l\'état repasse à non connecté', async () => {
    await connect();
    const res = await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const status = await request<StatusBody>(rig.app, 'GET', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(status.body.connected).toBe(false);
    expect(status.body.updatedAt).toBeNull();
  });
});
