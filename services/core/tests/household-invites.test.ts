import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { addKidProfile, bootstrapOwner, type Member } from './social-harness.js';
import { type ErrorBody, type LoginBody, createProfileVia, PASSWORD, request } from './user-harness.js';

interface Created {
  id: string;
  token: string;
  expiresAt: string;
}

interface ListBody {
  invites: { id: string; profileId: string; profileName: string; createdAt: string; expiresAt: string; state: string; usedAt?: string }[];
  linkedProfileIds: string[];
}

interface CheckBody {
  state: 'ok' | 'expired' | 'used' | 'revoked' | 'unknown';
  inviter?: { name: string; avatar: string | null; avatarColor: string };
  profile?: { name: string; avatar: string | null; avatarColor: string };
  expiresAt?: string;
  backdrops: string[];
}

interface RedeemBody {
  token: string;
  expiresAt: string;
  profileId: string;
}

interface MeBody {
  account: { id: string; username: string; isOwner: boolean; role: string };
  lockedProfileId: string | null;
}

const HOUR = 3600 * 1000;
const TOO_SHORT = 'mot';

let app: RunningApp;
/** Propriétaire : son profil « alice » est le profil principal (et le profil administrateur). */
let alice: Member;
/** Profil adulte non principal, cible des invitations. */
let marie: string;
/** Profil adulte non principal, pour les cas « identifiant déjà pris par un profil ». */
let sam: string;
/** Profil enfant du compte. */
let kid: string;

beforeEach(async () => {
  vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
  app = await startApp({});
  alice = await bootstrapOwner(app);
  marie = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Marie' })).body.id;
  sam = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Sam' })).body.id;
  kid = await addKidProfile(app, alice);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await app.close();
});

const mainHeader = () => ({ 'x-profile-id': alice.profile });

const createInvite = (profileId: string, body?: Record<string, unknown>, actor: string = alice.profile, token: string = alice.token) =>
  request<Created | ErrorBody>(app, 'POST', `/user/profiles/${profileId}/household-invite`, {
    token,
    body: body ?? {},
    headers: { 'x-profile-id': actor },
  });

/** Crée un lien pour Marie et renvoie son jeton (lien valide 72 h par défaut). */
async function linkForMarie(body?: Record<string, unknown>): Promise<Created> {
  const res = await createInvite(marie, body);
  if (res.status !== 201) throw new Error(`lien non créé (${res.status})`);
  return res.body as Created;
}

const check = (token: string) => request<CheckBody>(app, 'GET', `/user/household-invites/check?token=${encodeURIComponent(token)}`);

const redeem = (token: string, login: string, password: string = PASSWORD, name?: string) =>
  request<RedeemBody | ErrorBody>(app, 'POST', '/user/household-invites/redeem', {
    body: { token, login, password, ...(name === undefined ? {} : { name }) },
  });

const listInvites = (token: string = alice.token) => request<ListBody>(app, 'GET', '/user/household-invites', { token });
const meOf = (token: string) => request<MeBody>(app, 'GET', '/user/me', { token });
const loginWith = (username: string, password: string = PASSWORD) =>
  request<LoginBody | ErrorBody>(app, 'POST', '/user/login', { body: { username, password } });

/** Consomme le lien de Marie avec l'identifiant « marie.hub » : renvoie la session verrouillée. */
async function marieLoggedIn(): Promise<string> {
  const link = await linkForMarie();
  const res = await redeem(link.token, 'marie.hub');
  if (res.status !== 201) throw new Error(`consommation refusée (${res.status})`);
  return (res.body as RedeemBody).token;
}

const minutesFrom = (iso: string | undefined): number => Math.round((Date.parse(iso ?? '') - Date.now()) / 60_000);

describe('création d’une invitation sur un profil du foyer', () => {
  it('durée de 24, 72 ou 168 heures ; 72 heures par défaut', async () => {
    for (const hours of [24, 72, 168]) {
      const res = await createInvite(marie, { ttlHours: hours });
      expect(res.status).toBe(201);
      expect(Math.abs(Date.parse((res.body as Created).expiresAt) - Date.now() - hours * HOUR)).toBeLessThan(10_000);
    }
    const dflt = await createInvite(marie);
    expect(dflt.status).toBe(201);
    expect(minutesFrom((dflt.body as Created).expiresAt)).toBeGreaterThan(72 * 60 - 2);
    expect(minutesFrom((dflt.body as Created).expiresAt)).toBeLessThanOrEqual(72 * 60);
  });

  it('une durée hors de 24, 72, 168 est refusée', async () => {
    const res = await createInvite(marie, { ttlHours: 48 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_body' });
  });

  it('refuse un profil enfant, le profil principal, et un profil déjà doté d’un identifiant', async () => {
    expect(await createInvite(kid)).toMatchObject({ status: 400, body: { error: 'kid_profile' } });
    expect(await createInvite(alice.profile)).toMatchObject({ status: 400, body: { error: 'principal_profile' } });
    await redeem((await linkForMarie()).token, 'marie.hub');
    expect(await createInvite(marie)).toMatchObject({ status: 409, body: { error: 'profile_has_login' } });
  });

  it('le créateur doit être un profil adulte du compte (X-Profile-Id)', async () => {
    expect((await createInvite(marie, undefined, kid)).body).toEqual({ error: 'adult_profile_required' });
    const noHeader = await request<ErrorBody>(app, 'POST', `/user/profiles/${marie}/household-invite`, { token: alice.token, body: {} });
    expect(noHeader.body).toEqual({ error: 'adult_profile_required' });
  });

  it('profil inconnu : 404', async () => {
    expect((await createInvite('profil-inexistant')).status).toBe(404);
  });
});

describe('un seul lien actif par profil', () => {
  it('créer un nouveau lien révoque le précédent', async () => {
    const first = await linkForMarie();
    const second = await linkForMarie();
    expect(first.token).not.toBe(second.token);
    const states = Object.fromEntries((await listInvites()).body.invites.map((invite) => [invite.id, invite.state]));
    expect(states[first.id]).toBe('revoked');
    expect(states[second.id]).toBe('pending');
    expect((await check(first.token)).body.state).toBe('revoked');
    expect((await check(second.token)).body.state).toBe('ok');
  });
});

describe('vérification d’un lien (sans le consommer)', () => {
  it('ok, avec le profil invité, le créateur et les affiches de sa bibliothèque', async () => {
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/movie/603`, {
      token: alice.token,
      body: { title: 'Matrix', poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg' },
    });
    const link = await linkForMarie();
    const res = await check(link.token);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ok');
    expect(res.body.profile).toMatchObject({ name: 'Marie' });
    expect(res.body.inviter).toMatchObject({ name: 'alice' });
    expect(res.body.backdrops).toEqual(['https://image.tmdb.org/t/p/w500/matrix.jpg']);
    expect(res.body.expiresAt).toBe(link.expiresAt);
    // Vérifier ne consomme rien : le lien reste utilisable.
    expect((await check(link.token)).body.state).toBe('ok');
    expect((await redeem(link.token, 'marie.hub')).status).toBe(201);
  });

  it('inconnu : état « unknown », sans affiches', async () => {
    const res = await check('a'.repeat(43));
    expect(res.body).toEqual({ state: 'unknown', backdrops: [] });
  });

  it('utilisé après consommation, révoqué après révocation', async () => {
    const used = await linkForMarie();
    await redeem(used.token, 'marie.hub');
    expect((await check(used.token)).body.state).toBe('used');
    // Marie a déjà un identifiant : le lien révoqué est celui de Sam.
    const revoked = (await createInvite(sam)).body as Created;
    await request(app, 'DELETE', `/user/household-invites/${revoked.id}`, { token: alice.token });
    expect((await check(revoked.token)).body.state).toBe('revoked');
  });

  it('expiré passé l’échéance (sans consommer)', async () => {
    const link = await linkForMarie({ ttlHours: 24 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * HOUR);
    expect((await check(link.token)).body.state).toBe('expired');
    expect((await redeem(link.token, 'marie.hub')).body).toEqual({ error: 'expired' });
    expect((await listInvites()).body.invites[0]?.state).toBe('expired');
  });
});

describe('consommation d’un lien (redeem)', () => {
  it('crée l’identifiant, marque le lien utilisé et renvoie une session verrouillée sur le profil', async () => {
    const link = await linkForMarie();
    const res = await redeem(link.token, 'Marie.Hub');
    expect(res.status).toBe(201);
    const body = res.body as RedeemBody;
    expect(body.profileId).toBe(marie);
    expect(typeof body.token).toBe('string');
    expect((await meOf(body.token)).body.lockedProfileId).toBe(marie);
    const used = (await listInvites()).body.invites.find((invite) => invite.id === link.id);
    expect(used).toMatchObject({ state: 'used' });
    expect(used?.usedAt).toBeDefined();
    // Le lien ne sert qu'une fois.
    expect((await redeem(link.token, 'autre.nom')).body).toEqual({ error: 'used' });
  });

  it('l’identifiant d’invité permet de se connecter : session verrouillée sur le profil', async () => {
    await redeem((await linkForMarie()).token, 'marie.hub');
    const res = await loginWith('marie.hub');
    expect(res.status).toBe(200);
    expect((await meOf((res.body as LoginBody).token)).body.lockedProfileId).toBe(marie);
    expect((await loginWith('marie.hub', 'mauvais-mot-de-passe')).body).toEqual({ error: 'invalid_credentials' });
  });

  it('mot de passe trop court ou identifiant mal formé : refus sans rien consommer', async () => {
    const link = await linkForMarie();
    expect((await redeem(link.token, 'marie.hub', TOO_SHORT)).body).toEqual({ error: 'weak_password' });
    expect((await redeem(link.token, 'ma')).body).toEqual({ error: 'bad_login' });
    expect((await redeem(link.token, 'a b c')).body).toEqual({ error: 'bad_login' });
    expect((await check(link.token)).body.state).toBe('ok');
  });

  it('login_taken contre un nom de compte existant, sans consommer le lien', async () => {
    const link = await linkForMarie();
    const res = await redeem(link.token, 'alice');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'login_taken' });
    expect((await check(link.token)).body.state).toBe('ok');
    expect((await redeem(link.token, 'marie.hub')).status).toBe(201);
  });

  it('login_taken contre le login d’un autre profil', async () => {
    await redeem((await linkForMarie()).token, 'marie.hub');
    const samLink = await createInvite(sam);
    expect(samLink.status).toBe(201);
    const res = await redeem((samLink.body as Created).token, 'marie.hub');
    expect(res.body).toEqual({ error: 'login_taken' });
  });

  it('un nom choisi renomme le profil ; une révocation refuse la consommation (410 revoked)', async () => {
    const link = await linkForMarie();
    expect((await redeem(link.token, 'marie.hub', PASSWORD, 'Marianne')).status).toBe(201);
    const profiles = await request<{ profiles: { id: string; name: string }[] }>(app, 'GET', '/user/profiles', { token: alice.token });
    expect(profiles.body.profiles.find((p) => p.id === marie)?.name).toBe('Marianne');

    const revoked = await createInvite(sam);
    await request(app, 'DELETE', `/user/household-invites/${(revoked.body as Created).id}`, { token: alice.token });
    expect((await redeem((revoked.body as Created).token, 'sam.hub')).body).toEqual({ error: 'revoked' });
  });

  it('lien inconnu : 404 unknown ; lien expiré : 410 expired', async () => {
    expect((await redeem('b'.repeat(43), 'inconnu.hub')).body).toEqual({ error: 'unknown' });
    expect((await redeem('b'.repeat(43), 'inconnu.hub')).status).toBe(404);
    const link = await linkForMarie({ ttlHours: 24 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * HOUR);
    const res = await redeem(link.token, 'marie.hub');
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'expired' });
  });
});

describe('session verrouillée', () => {
  it('refusée sur un autre profil que le sien (403 profile_locked)', async () => {
    const token = await marieLoggedIn();
    const other = await request<ErrorBody>(app, 'GET', `/user/profiles/${alice.profile}/library`, { token });
    expect(other).toMatchObject({ status: 403, body: { error: 'profile_locked' } });
    const own = await request(app, 'GET', `/user/profiles/${marie}/library`, { token });
    expect(own.status).toBe(200);
  });

  it('refusée sur la gestion des profils, des invitations, des quotas et de la configuration', async () => {
    const token = await marieLoggedIn();
    const headers = { 'x-profile-id': marie };
    expect((await request<ErrorBody>(app, 'POST', '/user/profiles', { token, body: { name: 'Intrus' }, headers })).body).toEqual({ error: 'profile_locked' });
    expect((await request<ErrorBody>(app, 'DELETE', `/user/profiles/${sam}`, { token, headers })).body).toEqual({ error: 'profile_locked' });
    expect((await request<ErrorBody>(app, 'PATCH', `/user/profiles/${marie}`, { token, body: { name: 'Autre' }, headers })).body).toEqual({
      error: 'profile_locked',
    });
    expect((await createInvite(marie, undefined, marie, token)).body).toEqual({ error: 'profile_locked' });
    expect((await request<ErrorBody>(app, 'GET', '/user/household-invites', { token })).body).toEqual({ error: 'profile_locked' });
    expect((await request<ErrorBody>(app, 'PUT', `/user/accounts/alice/invite-quota`, { token, body: { quota: 9 } })).body).toEqual({
      error: 'profile_locked',
    });
    expect((await request<ErrorBody>(app, 'PUT', '/user/account/config', { token, body: { config: null }, headers })).body).toEqual({
      error: 'profile_locked',
    });
  });

  it('n’ouvre pas l’administration du propriétaire, même avec le profil administrateur', async () => {
    const token = await marieLoggedIn();
    const res = await request<ErrorBody>(app, 'GET', '/admin/me', { token, headers: mainHeader() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'profile_locked' });
    // Le propriétaire, lui, y accède.
    expect((await request(app, 'GET', '/admin/me', { token: alice.token, headers: mainHeader() })).status).toBe(200);
  });

  it('la présence ne parle que pour le profil verrouillé', async () => {
    const token = await marieLoggedIn();
    expect(
      (await request<ErrorBody>(app, 'PUT', '/user/social/presence', { token, headers: { 'x-profile-id': alice.profile }, body: {} })).body,
    ).toEqual({ error: 'profile_locked' });
    expect((await request(app, 'PUT', '/user/social/presence', { token, headers: { 'x-profile-id': marie }, body: {} })).status).toBe(204);
  });

  it('le verrou survit au renouvellement de session', async () => {
    const token = await marieLoggedIn();
    const refreshed = await request<LoginBody>(app, 'POST', '/user/refresh', { token });
    expect(refreshed.status).toBe(200);
    expect((await meOf((refreshed.body as LoginBody).token)).body.lockedProfileId).toBe(marie);
    expect((await meOf(token)).status).toBe(401);
  });

  it('une session libre n’a pas de profil verrouillé', async () => {
    expect((await meOf(alice.token)).body.lockedProfileId).toBeNull();
  });
});

describe('identifiants et inscription', () => {
  it('register refuse un nom déjà pris par un identifiant de profil', async () => {
    await redeem((await linkForMarie()).token, 'marie.hub');
    const res = await request<ErrorBody>(app, 'POST', '/user/register', { body: { username: 'marie.hub', password: PASSWORD } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'username_taken' });
  });
});

describe('liste : profils liés à un identifiant', () => {
  it('linkedProfileIds : vide avant consommation, puis le profil invité', async () => {
    expect((await listInvites()).body.linkedProfileIds).toEqual([]);
    await redeem((await linkForMarie()).token, 'marie.hub');
    expect((await listInvites()).body.linkedProfileIds).toEqual([marie]);
  });

  it('linkedProfileIds reste complet au-delà de la fenêtre de 30 jours, la liste des liens non', async () => {
    await redeem((await linkForMarie()).token, 'marie.hub');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 24 * HOUR);
    const list = await listInvites();
    expect(list.body.invites).toEqual([]);
    expect(list.body.linkedProfileIds).toEqual([marie]);
  });
});

describe('révocation', () => {
  it('révoque un lien en attente ; un lien utilisé ne se révoque pas ; un id inconnu : 404', async () => {
    const link = await linkForMarie();
    expect((await request(app, 'DELETE', `/user/household-invites/${link.id}`, { token: alice.token })).status).toBe(204);
    expect((await check(link.token)).body.state).toBe('revoked');
    expect((await request(app, 'DELETE', '/user/household-invites/inconnu', { token: alice.token })).status).toBe(404);
    const used = await linkForMarie();
    await redeem(used.token, 'marie.hub');
    expect((await request<ErrorBody>(app, 'DELETE', `/user/household-invites/${used.id}`, { token: alice.token })).body).toEqual({
      error: 'invite_used',
    });
    // Le login créé reste valable.
    expect((await loginWith('marie.hub')).status).toBe(200);
  });

  it('la liste donne le nom du profil et l’état de chaque lien', async () => {
    const link = await linkForMarie();
    const list = await listInvites();
    expect(list.body.invites).toEqual([
      expect.objectContaining({ id: link.id, profileId: marie, profileName: 'Marie', state: 'pending' }),
    ]);
  });
});

describe('périmètre d’une session verrouillée : parrainage, amis, identité, profils', () => {
  const denied = { error: 'profile_locked' };

  it('parrainage et amis au niveau du compte : 403 profile_locked', async () => {
    const token = await marieLoggedIn();
    // Un autre profil que celui du verrou (ici le principal) : refusé par la route v2, avant toute lecture du corps.
    const other = { 'x-profile-id': alice.profile };
    expect((await request<ErrorBody>(app, 'GET', '/user/invites', { token })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'PUT', '/user/invites/x/sent', { token, body: { sent: true } })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'DELETE', '/user/invites/x', { token })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'GET', '/user/social/friends', { token, headers: other })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'POST', '/user/social/requests', { token, headers: other, body: { handle: 'bob' } })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'DELETE', '/user/social/friends/AAAAAAAAAAAAAAAA', { token, headers: other })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'GET', '/user/friends/alice/library', { token })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'DELETE', '/user/social/presence', { token, headers: other })).body).toEqual(denied);
    expect((await request<ErrorBody>(app, 'PUT', '/user/social/status', { token, headers: other, body: { status: 'invisible' } })).body).toEqual(denied);
  });

  it('lien public avec invitation réservée refusé ; lien sans invitation et amis de profil autorisés, pour ce profil seulement', async () => {
    const token = await marieLoggedIn();
    const withInvite = await request<ErrorBody>(app, 'POST', '/user/social/share-links', {
      token,
      headers: { 'x-profile-id': marie },
      body: { type: 'movie', tmdbId: 603, title: 'Matrix', withInvite: true },
    });
    expect(withInvite.status).toBe(403);
    expect(withInvite.body).toEqual(denied);
    const own = await request<ErrorBody>(app, 'POST', '/user/social/share-links', {
      token,
      headers: { 'x-profile-id': marie },
      body: { type: 'movie', tmdbId: 603, title: 'Matrix', withInvite: false },
    });
    expect(own.status).toBe(201);
    const mine = await request<{ links: unknown[] }>(app, 'GET', '/user/social/share-links', { token, headers: { 'x-profile-id': marie } });
    expect(mine.status).toBe(200);
    expect(mine.body.links).toHaveLength(1);
    // Un autre profil du compte n'agit pas depuis cette session, ni en lecture ni en écriture.
    const other = await request<ErrorBody>(app, 'GET', '/user/social/share-links', { token, headers: { 'x-profile-id': alice.profile } });
    expect(other.body).toEqual(denied);
    const friends = await request(app, 'GET', '/user/social/friends', { token, headers: { 'x-profile-id': marie } });
    expect(friends.status).toBe(200);
    const otherFriends = await request<ErrorBody>(app, 'GET', '/user/social/friends', { token, headers: { 'x-profile-id': alice.profile } });
    expect(otherFriends.body).toEqual(denied);
  });

  it('/user/me : le login de l’invité remplace le pseudo du compte hôte', async () => {
    const token = await marieLoggedIn();
    const me = await meOf(token);
    expect(me.body.account).toMatchObject({ username: 'marie.hub', isOwner: false, role: 'member' });
    expect(me.body.lockedProfileId).toBe(marie);
    expect(JSON.stringify(me.body)).not.toContain('alice');
  });

  it('/user/profiles : une session verrouillée ne liste que son profil ; le propriétaire voit tout le compte', async () => {
    const token = await marieLoggedIn();
    const list = await request<{ profiles: { id: string; isMainProfile: boolean; isAdminProfile: boolean }[] }>(app, 'GET', '/user/profiles', { token });
    expect(list.body.profiles.map((p) => p.id)).toEqual([marie]);
    expect(list.body.profiles[0]).toMatchObject({ isMainProfile: false, isAdminProfile: false });
    const owner = await request<{ profiles: unknown[] }>(app, 'GET', '/user/profiles', { token: alice.token });
    expect(owner.body.profiles).toHaveLength(4);
  });
});

describe('suppression du profil invité', () => {
  it('supprime son identifiant et les sessions verrouillées dessus', async () => {
    const link = await createInvite(sam);
    const redeemed = await redeem((link.body as Created).token, 'sam.hub');
    const samToken = (redeemed.body as RedeemBody).token;
    expect((await meOf(samToken)).status).toBe(200);
    const deleted = await request(app, 'DELETE', `/user/profiles/${sam}`, { token: alice.token, headers: mainHeader() });
    expect(deleted.status).toBe(204);
    expect((await loginWith('sam.hub')).body).toEqual({ error: 'invalid_credentials' });
    expect((await meOf(samToken)).status).toBe(401);
    // L’identifiant est de nouveau libre.
    expect((await request(app, 'POST', '/user/register', { body: { username: 'sam.hub', password: PASSWORD } })).status).toBe(201);
  });
});
