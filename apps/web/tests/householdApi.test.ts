import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkHouseholdInvite, createHouseholdInvite, householdErrorCode, listHouseholdInvites, redeemHouseholdInvite, removeProfileLogin, revokeHouseholdInvite,
} from '../src/data/householdApi';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { reloadSession, setActiveProfile, setSession } from '../src/data/session';
import { UserApiError } from '../src/data/userApi';

/* Client des invitations au foyer : chemins, en-têtes (compte, profil acteur, anonyme) et codes d'erreur propagés. */

const BASE = 'http://srv.test';
const SESSION_TOKEN = 'tok-session-' + 'z'.repeat(24);
const TOKEN = 'aZ0_-'.repeat(8) + 'aZ0_';

type Reply = { status?: number; body?: unknown; reject?: boolean };
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
  setActiveProfile('main-h');
  replies = [];
  calls = [];
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('création du lien (session du compte, profil acteur adulte)', () => {
  it('POST /user/profiles/:id/household-invite : durée, profil acteur par X-Profile-Id (profil actif par défaut), jeton de session', async () => {
    replies = [{ status: 201, body: { id: 'h1', token: TOKEN, expiresAt: '2026-10-23T00:00:00.000Z' } }];
    const out = await createHouseholdInvite('inv-1', 72);
    expect(out).toEqual({ id: 'h1', token: TOKEN, expiresAt: '2026-10-23T00:00:00.000Z' });
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/profiles/inv-1/household-invite');
    expect(JSON.parse(c.body)).toEqual({ ttlHours: 72 });
    expect(c.headers['x-profile-id']).toBe('main-h');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('profil acteur explicite (adulte non principal) et durée par défaut', async () => {
    replies = [{ status: 201, body: { id: 'h2', token: TOKEN, expiresAt: 'x' } }];
    await createHouseholdInvite('inv-1', undefined, 'adulte-2');
    const c = calls[0];
    expect(c.headers['x-profile-id']).toBe('adulte-2');
    expect(JSON.parse(c.body)).toEqual({});
  });

  it('403 du serveur (profil verrouillé) : code propagé dans une erreur typée', async () => {
    replies = [{ status: 403, body: { error: 'profile_locked' } }];
    const err = await createHouseholdInvite('inv-1', 24).catch((e) => e);
    expect(err).toBeInstanceOf(UserApiError);
    expect(err.code).toBe('profile_locked');
    expect(householdErrorCode(err)).toBe('profile_locked');
  });
});

describe('gestion des liens (session du compte)', () => {
  it('GET /user/household-invites : liste sans en-tête de profil', async () => {
    replies = [{ body: { invites: [{ id: 'h1', profileId: 'inv-1', profileName: 'Invitée', createdAt: 'a', expiresAt: 'b', state: 'pending' }] } }];
    const out = await listHouseholdInvites();
    expect(out.invites[0].state).toBe('pending');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/user/household-invites');
    expect(calls[0].headers['x-profile-id']).toBeUndefined();
    expect(calls[0].headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('DELETE /user/household-invites/:id : 204 sans corps, identifiant encodé', async () => {
    replies = [{ status: 204 }];
    await expect(revokeHouseholdInvite('a/b')).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('/user/household-invites/a%2Fb');
  });
});

describe('ouverture et validation du lien (anonymes)', () => {
  it('GET /user/household-invites/check?token= : sans session ni en-tête de profil, rien consommé', async () => {
    replies = [{ body: { state: 'ok', inviter: { name: 'Hôte', avatar: null }, profile: { name: 'Invitée', avatar: 'dicebear:adventurer:x' }, expiresAt: 'e', backdrops: ['https://img/1.jpg'] } }];
    const out = await checkHouseholdInvite(TOKEN);
    expect(out.state).toBe('ok');
    expect(out.backdrops).toHaveLength(1);
    expect(calls[0].url).toBe('/user/household-invites/check?token=' + encodeURIComponent(TOKEN));
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers['x-profile-id']).toBeUndefined();
  });

  it('POST /user/household-invites/redeem : seuls les champs du contrat partent, sans session ; renvoie la session verrouillée', async () => {
    replies = [{ body: { token: 'tok-r-' + 'q'.repeat(24), expiresAt: 'e', profileId: 'inv-1' } }];
    const out = await redeemHouseholdInvite({ token: TOKEN, login: 'invitee', password: 'motdepasse1', name: 'Invitée', extra: 'non' } as never);
    expect(out.profileId).toBe('inv-1');
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/user/household-invites/redeem');
    expect(c.headers.authorization).toBeUndefined();
    expect(JSON.parse(c.body)).toEqual({ token: TOKEN, login: 'invitee', password: 'motdepasse1', name: 'Invitée' });
  });

  it('redeem sans nom : le champ name est absent du corps', async () => {
    replies = [{ body: { token: 't', expiresAt: 'e', profileId: 'inv-1' } }];
    await redeemHouseholdInvite({ token: TOKEN, login: 'invitee', password: 'motdepasse1' });
    expect(JSON.parse(calls[0].body)).not.toHaveProperty('name');
  });

  it('erreurs du redeem : code serveur propagé (login_taken, expired), codes inconnus en other', async () => {
    replies = [{ status: 409, body: { error: 'login_taken' } }];
    const taken = await redeemHouseholdInvite({ token: TOKEN, login: 'hote', password: 'motdepasse1' }).catch((e) => e);
    expect(taken).toBeInstanceOf(UserApiError);
    expect(taken.status).toBe(409);
    expect(householdErrorCode(taken)).toBe('login_taken');

    replies = [{ status: 410, body: { error: 'expired' } }];
    const expired = await redeemHouseholdInvite({ token: TOKEN, login: 'a1', password: 'motdepasse1' }).catch((e) => e);
    expect(householdErrorCode(expired)).toBe('expired');

    replies = [{ status: 418, body: { error: 'teapot' } }];
    const other = await redeemHouseholdInvite({ token: TOKEN, login: 'a1', password: 'motdepasse1' }).catch((e) => e);
    expect(householdErrorCode(other)).toBe('other');
  });

  it('rate_limited et réseau : codes lisibles par l’interface', async () => {
    replies = [{ status: 429, body: { error: 'rate_limited' } }];
    const limited = await checkHouseholdInvite(TOKEN).catch((e) => e);
    expect(householdErrorCode(limited)).toBe('rate_limited');

    replies = [{ reject: true }];
    const net = await checkHouseholdInvite(TOKEN).catch((e) => e);
    expect(net).toBeInstanceOf(UserApiError);
    expect(householdErrorCode(net)).toBe('network');
    expect(householdErrorCode(new Error('x'))).toBe('other');
  });
});

describe('retrait de l’accès (DELETE /user/profiles/:id/login)', () => {
  it('204 sans corps : profil acteur par défaut (profil actif), jeton de session', async () => {
    replies = [{ status: 204 }];
    await expect(removeProfileLogin('inv-1')).resolves.toBeUndefined();
    const c = calls[0];
    expect(c.method).toBe('DELETE');
    expect(c.url).toBe('/user/profiles/inv-1/login');
    expect(c.headers['x-profile-id']).toBe('main-h');
    expect(c.headers.authorization).toBe('Bearer ' + SESSION_TOKEN);
  });

  it('profil acteur explicite et identifiant encodé', async () => {
    replies = [{ status: 204 }];
    await removeProfileLogin('a/b', 'adulte-2');
    expect(calls[0].url).toBe('/user/profiles/a%2Fb/login');
    expect(calls[0].headers['x-profile-id']).toBe('adulte-2');
  });

  it('404 no_login : code propagé dans une erreur typée', async () => {
    replies = [{ status: 404, body: { error: 'no_login' } }];
    const err = await removeProfileLogin('inv-1').catch((e) => e);
    expect(err).toBeInstanceOf(UserApiError);
    expect(householdErrorCode(err)).toBe('no_login');
  });
});

describe('codes d’erreur des routes foyer reconnus par l’interface', () => {
  it.each(['principal_profile', 'kid_profile', 'adult_profile_required', 'pin_required', 'invalid_body', 'profile_not_found', 'no_login'])(
    '%s est un code connu (et non « other »)',
    (code) => {
      expect(householdErrorCode(new UserApiError(400, code))).toBe(code);
    },
  );
});
