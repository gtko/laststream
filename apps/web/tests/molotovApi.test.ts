import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectMolotov, disconnectMolotov, getMolotovChannels, getMolotovCredentials, getMolotovEpg, getMolotovPlay, getMolotovStatus, postMolotovLicense,
  resendMolotovMfa, signinMolotov, verifyMolotovMfa,
} from '../src/data/molotovApi';
import type { MolotovChannelDto, MolotovCredentials, MolotovDrm, MolotovEpgChannel, MolotovEpgProgram, MolotovPlay, MolotovStatus } from '../src/data/molotovApi';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { reloadSession, setActiveProfile, setSession } from '../src/data/session';

/* Client Molotov : routes serveur du contrat (§8) — URL, corps, en-têtes — et relais binaire de la licence. */

const BASE = 'http://srv.test';
const SESSION_TOKEN = 'tok-session-' + 'z'.repeat(24);

type Reply = { status?: number; body?: unknown; bytes?: Uint8Array; reject?: boolean };
let replies: Reply[] = [];
let calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

function fakeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url).replace(BASE, ''),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: String(init?.body ?? ''),
    });
    const next = replies.shift();
    if (next?.reject) throw new TypeError('network down');
    if (next?.bytes) {
      return new Response(next.bytes.buffer as ArrayBuffer, { status: next.status ?? 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (!next || next.status === 204) return new Response(null, { status: next?.status ?? 204 });
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: '' }));
  reloadSettings();
  reloadSession();
  setSession(SESSION_TOKEN, new Date(Date.now() + 3e9).toISOString(), 'hote');
  setActiveProfile('main-m');
  replies = [];
  calls = [];
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('état de la connexion Molotov', () => {
  it('GET /user/account/molotov : profil principal, jeton de session', async () => {
    replies = [{ body: { connected: true, tier: 'premium', channelCount: 42, email: 'a@b.c' } }];
    const st: MolotovStatus = await getMolotovStatus();
    expect(st.connected).toBe(true);
    expect(st.tier).toBe('premium');
    expect(st.channelCount).toBe(42);
    const c = calls[0];
    expect(c.method).toBe('GET');
    expect(c.url).toBe('/user/account/molotov');
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('GET /user/account/molotov/credentials : jetons pour les appels directs', async () => {
    replies = [{ body: { idToken: 'molotov-id', refreshToken: 'molotov-refresh', expiresAt: '2026-10-23T00:00:00.000Z' } }];
    const creds: MolotovCredentials = await getMolotovCredentials();
    expect(creds.idToken).toBe('molotov-id');
    expect(creds.refreshToken).toBe('molotov-refresh');
    expect(calls[0].url).toBe('/user/account/molotov/credentials');
  });

  it('PUT /user/account/molotov : jetons Molotov envoyés tels quels', async () => {
    replies = [{ body: { ok: true } }];
    await connectMolotov({ idToken: 'molotov-id', refreshToken: 'molotov-refresh' });
    const c = calls[0];
    expect(c.method).toBe('PUT');
    expect(c.url).toBe('/user/account/molotov');
    expect(JSON.parse(c.body)).toEqual({ idToken: 'molotov-id', refreshToken: 'molotov-refresh' });
  });

  it('DELETE /user/account/molotov : déconnexion', async () => {
    replies = [{ body: { ok: true } }];
    await disconnectMolotov();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('/user/account/molotov');
  });
});

describe('catalogue', () => {
  it('GET /user/account/molotov/channels : catalogue compact du serveur', async () => {
    replies = [{ body: { channels: [{ id: 'c1', name: 'France 2', group: 'France' }], fetchedAt: '2026-10-22T00:00:00.000Z' } }];
    const list: MolotovChannelDto[] = await getMolotovChannels();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('France 2');
    expect(calls[0].url).toBe('/user/account/molotov/channels');
  });
});

describe('guide TV', () => {
  it('GET /user/account/molotov/epg : guide compact du serveur, profil principal', async () => {
    const program: MolotovEpgProgram = {
      id: 'p1',
      title: 'Journal',
      start: '2026-10-23T14:00:00Z',
      end: '2026-10-23T15:00:00Z',
      type: 'episode',
      desc: 'Les infos',
      image: 'https://img.example/p1.jpg',
    };
    replies = [{ body: { channels: [{ id: '600046', name: 'TF1', logo: 'https://img.example/tf1.png', callSign: 'tf1', programs: [program] }], fetchedAt: 1 } }];
    const list: MolotovEpgChannel[] = await getMolotovEpg(true);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('TF1');
    expect(list[0].programs).toEqual([program]);
    const c = calls[0];
    expect(c.method).toBe('GET');
    expect(c.url).toBe('/user/account/molotov/epg');
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('mémoisé dix minutes, rechargé ensuite', async () => {
    const base = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      replies = [
        { body: { channels: [{ id: '600046', name: 'TF1', programs: [] }] } },
        { body: { channels: [{ id: '600047', name: 'France 2', programs: [] }] } },
      ];
      const first = await getMolotovEpg(true);
      const again = await getMolotovEpg();
      expect(again).toBe(first);
      expect(calls).toHaveLength(1);
      spy.mockReturnValue(base + 11 * 60 * 1000);
      const fresh = await getMolotovEpg();
      expect(fresh[0].id).toBe('600047');
      expect(calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('lecture', () => {
  it('POST /user/account/molotov/play : manifeste, licence et heartbeat', async () => {
    replies = [{ body: {
      manifestUrl: 'https://cdn.example/master.mpd',
      drm: { scheme: 'widevine', licenseUrl: 'https://api-eu.fubo.tv/vapi/v1/drm/irdeto-proxy/license', licenseToken: 'tok' },
      heartbeatUrl: 'https://api-eu.fubo.tv/vapi/heartbeat/v2?channelId=c1&id=LIVE_1&type=live',
      expiresAt: '2026-10-22T01:00:00.000Z',
    } }];
    const play: MolotovPlay = await getMolotovPlay('c1');
    expect(play.manifestUrl).toBe('https://cdn.example/master.mpd');
    const drm: MolotovDrm | null = play.drm;
    expect(drm?.scheme).toBe('widevine');
    expect(drm?.licenseToken).toBe('tok');
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/play');
    expect(JSON.parse(c.body)).toEqual({ channelId: 'c1' });
  });
});

describe('licence Widevine', () => {
  it('POST /user/account/molotov/license : corps (url, jeton, challenge) et licence binaire renvoyée', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    replies = [{ bytes }];
    const buf = await postMolotovLicense({ licenseUrl: 'https://api-eu.fubo.tv/lic', token: 'tok', challenge: 'Y2hhbGxlbmdl' });
    expect(buf.byteLength).toBe(4);
    expect(new Uint8Array(buf)).toEqual(bytes);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/license');
    expect(JSON.parse(c.body)).toEqual({ licenseUrl: 'https://api-eu.fubo.tv/lic', token: 'tok', challenge: 'Y2hhbGxlbmdl' });
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('erreur du relais : le code remonte', async () => {
    replies = [{ status: 502, body: { error: 'license_failed' } }];
    await expect(postMolotovLicense({ licenseUrl: 'https://api-eu.fubo.tv/lic', token: 'tok', challenge: 'x' })).rejects.toThrow();
    expect(calls[0].url).toBe('/user/account/molotov/license');
  });
});

describe('vérification en deux étapes', () => {
  it('POST /account/molotov/signin : défi mfa_required ramené tel quel', async () => {
    replies = [{ body: { status: 'mfa_required', mfaToken: 'jeton-mfa' } }];
    const res = await signinMolotov({ email: 'alice@example.test', password: 'mot-de-passe' });
    expect(res).toEqual({ mfaRequired: true, mfaToken: 'jeton-mfa' });
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/signin');
    expect(JSON.parse(c.body)).toEqual({ email: 'alice@example.test', password: 'mot-de-passe' });
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('POST /account/molotov/signin : état du compte sans défi', async () => {
    replies = [{ body: { connected: true, tier: 'premium', channelCount: 3 } }];
    const res = await signinMolotov({ email: 'alice@example.test', password: 'mot-de-passe' });
    expect(res).toEqual({ status: { connected: true, tier: 'premium', channelCount: 3 } });
  });

  it('POST /account/molotov/signin/verify : corps { mfaToken, code }, état renvoyé', async () => {
    replies = [{ body: { connected: true, tier: 'premium', email: 'alice@example.test' } }];
    const st: MolotovStatus = await verifyMolotovMfa({ mfaToken: 'jeton-mfa', code: '123456' });
    expect(st.connected).toBe(true);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/signin/verify');
    expect(JSON.parse(c.body)).toEqual({ mfaToken: 'jeton-mfa', code: '123456' });
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('POST /account/molotov/signin/resend : corps { mfaToken }, jeton renvoyé', async () => {
    replies = [{ body: { mfaToken: 'jeton-mfa-neuf' } }];
    const res = await resendMolotovMfa({ mfaToken: 'jeton-mfa' });
    expect(res).toEqual({ mfaToken: 'jeton-mfa-neuf' });
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/signin/resend');
    expect(JSON.parse(c.body)).toEqual({ mfaToken: 'jeton-mfa' });
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });
});
