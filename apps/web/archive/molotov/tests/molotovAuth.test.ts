import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectMolotovWithPassword,
  MolotovAuthError,
  resendMolotovMfa,
  verifyMolotovMfa,
} from '../src/data/molotovAuth';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { reloadSession, setActiveProfile, setSession } from '../src/data/session';

/* Connexion du client Molotov par email et mot de passe : `POST /user/account/molotov/signin` et refus parlants.
 * Vérification en deux étapes : défi (`mfa_required`), vérification du code (`/signin/verify`) et renvoi (`/signin/resend`). */

describe('connexion par email et mot de passe', () => {
  const BASE = 'http://srv.test';
  const SESSION_TOKEN = 'tok-session-' + 'z'.repeat(24);
  const MFA_TOKEN = 'jeton-mfa';
  const NEW_MFA_TOKEN = 'jeton-mfa-neuf';
  type Reply = { status?: number; body?: unknown };
  let replies: Reply[] = [];
  let calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: '' }));
    reloadSettings();
    reloadSession();
    setSession(SESSION_TOKEN, new Date(Date.now() + 3e9).toISOString(), 'hote');
    setActiveProfile('main-m');
    replies = [];
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url).replace(BASE, ''),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: String(init?.body ?? ''),
      });
      const next = replies.shift();
      return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('connexion OK : POST /account/molotov/signin avec email et mot de passe', async () => {
    replies = [{ body: { connected: true, tier: 'premium', email: 'alice@example.test', channelCount: 12 } }];
    const res = await connectMolotovWithPassword('alice@example.test', 'mot-de-passe');
    expect(res).toEqual({ status: { connected: true, tier: 'premium', email: 'alice@example.test', channelCount: 12 } });
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/signin');
    expect(JSON.parse(c.body)).toEqual({ email: 'alice@example.test', password: 'mot-de-passe' });
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('identifiants invalides : MolotovAuthError invalid_credentials', async () => {
    replies = [{ status: 401, body: { error: 'invalid_credentials' } }];
    const err = await connectMolotovWithPassword('alice@example.test', 'faux').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MolotovAuthError);
    expect((err as MolotovAuthError).code).toBe('invalid_credentials');
    expect((err as MolotovAuthError).message).toBe('Email ou mot de passe Molotov incorrect.');
  });

  it('vérification en deux étapes : connexion puis verify, statut renvoyé', async () => {
    replies = [
      { body: { status: 'mfa_required', mfaToken: MFA_TOKEN } },
      { body: { connected: true, tier: 'premium', email: 'alice@example.test', channelCount: 12 } },
    ];
    const first = await connectMolotovWithPassword('alice@example.test', 'mot-de-passe');
    expect(first).toEqual({ mfaToken: MFA_TOKEN });
    const status = await verifyMolotovMfa(MFA_TOKEN, '123456');
    expect(status.connected).toBe(true);
    expect(status.email).toBe('alice@example.test');
    expect(status.tier).toBe('premium');
    const verify = calls[1];
    expect(verify.method).toBe('POST');
    expect(verify.url).toBe('/user/account/molotov/signin/verify');
    expect(JSON.parse(verify.body)).toEqual({ mfaToken: MFA_TOKEN, code: '123456' });
    expect(verify.headers['x-profile-id']).toBe('main-m');
    expect(verify.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('code refusé (401) : MolotovAuthError invalid_code', async () => {
    replies = [{ status: 401, body: { error: 'invalid_code' } }];
    const err = await verifyMolotovMfa(MFA_TOKEN, '000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MolotovAuthError);
    expect((err as MolotovAuthError).code).toBe('invalid_code');
    expect((err as MolotovAuthError).message).toBe('Code incorrect ou expiré.');
  });

  it('trop d\'essais (429) : MolotovAuthError rate_limited', async () => {
    replies = [{ status: 429, body: { error: 'rate_limited' } }];
    const err = await verifyMolotovMfa(MFA_TOKEN, '123456').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MolotovAuthError);
    expect((err as MolotovAuthError).code).toBe('rate_limited');
    expect((err as MolotovAuthError).message).toBe('Trop d\'essais : réessaie dans quelques minutes.');
  });

  it('renvoi du code : POST /signin/resend avec le jeton de défi', async () => {
    replies = [{ body: { mfaToken: NEW_MFA_TOKEN } }];
    const token = await resendMolotovMfa(MFA_TOKEN);
    expect(token).toBe(NEW_MFA_TOKEN);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/account/molotov/signin/resend');
    expect(JSON.parse(c.body)).toEqual({ mfaToken: MFA_TOKEN });
    expect(c.headers['x-profile-id']).toBe('main-m');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });
});
