import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMolotovWithPassword, MolotovAuthError } from '../src/data/molotovAuth';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { reloadSession, setActiveProfile, setSession } from '../src/data/session';

/* Connexion du client Molotov par email et mot de passe : `POST /user/account/molotov/signin` et refus parlants. */

describe('connexion par email et mot de passe', () => {
  const BASE = 'http://srv.test';
  const SESSION_TOKEN = 'tok-session-' + 'z'.repeat(24);
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
    const st = await connectMolotovWithPassword('alice@example.test', 'mot-de-passe');
    expect(st.connected).toBe(true);
    expect(st.tier).toBe('premium');
    expect(st.email).toBe('alice@example.test');
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
  });

  it('vérification en deux étapes : MolotovAuthError mfa_required', async () => {
    replies = [{ status: 401, body: { error: 'mfa_required' } }];
    const err = await connectMolotovWithPassword('alice@example.test', 'mot-de-passe').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MolotovAuthError);
    expect((err as MolotovAuthError).code).toBe('mfa_required');
  });
});
