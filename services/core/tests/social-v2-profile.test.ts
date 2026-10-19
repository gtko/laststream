import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FriendView, FriendsOverview, SocialProfileView } from '../src/user/social-v2-store.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/** Profil social étendu (contrat S1) : écriture et validation, cooldown du tag, expiration du statut, droits. */

const TAG_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_PID = 'AAAAAAAAAAAAAAAA';

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  app = await startApp({});
  cast = await castOf(app);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const read = (who: Persona) => as<SocialProfileView>(app, who, 'GET', '/user/social/profile');
const write = (who: Persona, body: unknown) => as<SocialProfileView | ErrorBodyV2>(app, who, 'PUT', '/user/social/profile', { body });
const friendsOf = (who: Persona) => as<FriendsOverview>(app, who, 'GET', '/user/social/friends');
const profileOfFriend = (who: Persona, pid: string) => as<SocialProfileView | ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/profile`);
const findFriend = (list: FriendView[], pid: string): FriendView | undefined => list.find((friend) => friend.pid === pid);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

describe('lecture et écriture du profil (GET / PUT /user/social/profile)', () => {
  it('profil initial : identité, favoris vides, chiffres à zéro, aucun champ optionnel', async () => {
    const res = await read(cast.alice);
    expect(res.status).toBe(200);
    expect(res.body.pid).toBe(cast.alice.pid);
    expect(res.body.handle.full).toBe(cast.alice.full);
    expect(res.body.favorites).toEqual([]);
    expect(res.body.stats).toEqual({ hoursWatched: 0, notes: 0, friends: 0 });
    for (const absent of ['bio', 'customStatus', 'banner', 'avatar', 'tagChangeableAt', 'friendSince']) {
      expect(res.body).not.toHaveProperty(absent);
    }
  });

  it('écriture partielle : un champ envoyé ne touche pas les autres ; bio null la retire', async () => {
    expect((await write(cast.alice, { bio: 'Cinéphile du mardi' })).status).toBe(200);
    const color = await write(cast.alice, { avatarColor: '#112233' });
    expect(color.status).toBe(200);
    expect(color.body).toMatchObject({ bio: 'Cinéphile du mardi', avatarColor: '#112233' });
    const cleared = await write(cast.alice, { bio: null });
    expect(cleared.body).not.toHaveProperty('bio');
    expect(cleared.body).toMatchObject({ avatarColor: '#112233' });
  });

  it('bio : 140 caractères au plus, sans caractère de contrôle', async () => {
    const tooLong = await write(cast.alice, { bio: 'a'.repeat(141) });
    expect(tooLong.status).toBe(400);
    expect((tooLong.body as ErrorBodyV2).issues).toContain('bio:too_long');
    const control = await write(cast.alice, { bio: 'ligne\u0007' });
    expect((control.body as ErrorBodyV2).issues).toContain('bio:control_char');
    expect((await write(cast.alice, { bio: 'a'.repeat(140) })).status).toBe(200);
  });

  it('statut personnalisé : emoji d’un seul graphème, texte ≤ 60, échéance dans le futur', async () => {
    const now = Date.now();
    const notEmoji = await write(cast.alice, { customStatus: { emoji: 'ab', text: 'ok' } });
    expect((notEmoji.body as ErrorBodyV2).issues).toContain('customStatus.emoji:not_emoji');
    const longText = await write(cast.alice, { customStatus: { text: 'x'.repeat(61) } });
    expect((longText.body as ErrorBodyV2).issues).toContain('customStatus.text:too_long');
    const past = await write(cast.alice, { customStatus: { text: 'ok', expiresAt: now - 1000 } });
    expect((past.body as ErrorBodyV2).issues).toContain('customStatus.expiresAt:past');
    const empty = await write(cast.alice, { customStatus: { text: '   ' } });
    expect((empty.body as ErrorBodyV2).issues).toContain('customStatus:empty');

    const expiresAt = now + DAY_MS;
    const ok = await write(cast.alice, { customStatus: { emoji: '🎬', text: 'En séance', expiresAt } });
    expect(ok.status).toBe(200);
    expect((ok.body as SocialProfileView).customStatus).toEqual({ emoji: '🎬', text: 'En séance', expiresAt });
  });

  it('nom : règles du handle (2 à 20 caractères) ; renommer garde le tag', async () => {
    const before = (await read(cast.alice)).body.handle;
    expect((await write(cast.alice, { name: 'A' })).status).toBe(400);
    expect((await write(cast.alice, { name: 'Nom#TAG' })).status).toBe(400);
    const renamed = await write(cast.alice, { name: 'Greg Deux' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as SocialProfileView).handle).toEqual({ name: 'Greg Deux', tag: before.tag, full: `Greg Deux#${before.tag}` });
  });

  it('champs inconnus ou couleur invalide refusés (400 invalid_body)', async () => {
    const unknown = await write(cast.alice, { avatar: 'dicebear:adventurer:abc' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as ErrorBodyV2).error).toBe('invalid_body');
    expect((await write(cast.alice, { avatarColor: 'rouge' })).status).toBe(400);
  });

  it('favoris : 4 au plus, sans doublon, ordre conservé ; bannière en chemin TMDB seulement', async () => {
    const fav = (tmdbId: number) => ({ type: 'movie', tmdbId, title: `Film ${tmdbId}` });
    const five = await write(cast.alice, { favorites: [1, 2, 3, 4, 5].map(fav) });
    expect(five.status).toBe(400);
    const dupe = await write(cast.alice, { favorites: [fav(7), fav(8), fav(7)] });
    expect((dupe.body as ErrorBodyV2).issues).toContain('favorites.2:duplicate');
    const ordered = await write(cast.alice, { favorites: [fav(9), fav(3)] });
    expect((ordered.body as SocialProfileView).favorites.map((item) => item.tmdbId)).toEqual([9, 3]);

    const remote = await write(cast.alice, { banner: { type: 'movie', tmdbId: 5, backdrop: 'https://evil.example/x.jpg', title: 'Film' } });
    expect(remote.status).toBe(400);
    const banner = await write(cast.alice, { banner: { type: 'series', tmdbId: 5, backdrop: '/abc123.jpg', title: 'Série' } });
    expect((banner.body as SocialProfileView).banner).toEqual({ type: 'series', tmdbId: 5, backdrop: '/abc123.jpg', title: 'Série' });
  });
});

describe('changement de tag (POST /user/social/profile/tag)', () => {
  it('nouveau tag différent, visible sur le profil ; ancien handle introuvable ; 429 pendant 30 jours', async () => {
    const before = (await read(cast.alice)).body.handle;
    const changed = await as<SocialProfileView>(app, cast.alice, 'POST', '/user/social/profile/tag');
    expect(changed.status).toBe(200);
    expect(changed.body.handle.tag).toMatch(TAG_PATTERN);
    expect(changed.body.handle.tag).not.toBe(before.tag);
    expect(changed.body.handle.name).toBe(before.name);
    const changeableAt = changed.body.tagChangeableAt ?? 0;
    expect(changeableAt - Date.now()).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(changeableAt - Date.now()).toBeLessThanOrEqual(30 * DAY_MS);

    const oldHandle = await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/requests', { body: { handle: before.full } });
    expect(oldHandle.status).toBe(404);

    const again = await as<ErrorBodyV2>(app, cast.alice, 'POST', '/user/social/profile/tag');
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('tag_cooldown');
    expect((await read(cast.alice)).body.handle.tag).toBe(changed.body.handle.tag);
  });

  it('changer son tag ne touche pas le handle des autres profils', async () => {
    const bobBefore = (await read(cast.bob)).body.handle;
    await as(app, cast.alice, 'POST', '/user/social/profile/tag');
    expect((await read(cast.bob)).body.handle).toEqual(bobBefore);
  });
});

describe('statut personnalisé : expiration', () => {
  it('visible par les amis jusqu’à l’échéance, puis absent', async () => {
    await befriend(app, cast.bob, cast.alice);
    const expiresAt = Date.now() + 3000;
    expect((await write(cast.alice, { customStatus: { text: 'En séance', expiresAt } })).status).toBe(200);

    const before = await friendsOf(cast.bob);
    expect(findFriend(before.body.friends, cast.alice.pid)?.customStatus).toEqual({ text: 'En séance', expiresAt });

    const wait = expiresAt + 50 - Date.now();
    if (wait > 0) await sleep(wait);
    const after = await friendsOf(cast.bob);
    expect(findFriend(after.body.friends, cast.alice.pid)).not.toHaveProperty('customStatus');
    expect((await profileOfFriend(cast.bob, cast.alice.pid)).body).not.toHaveProperty('customStatus');
  });
});

describe('droits sur le profil d’un ami (GET /user/social/friends/:pid/profile)', () => {
  it('ami : profil complet, « depuis » et points communs ; pas de délai de tag', async () => {
    await befriend(app, cast.bob, cast.alice);
    const res = await profileOfFriend(cast.bob, cast.alice.pid);
    expect(res.status).toBe(200);
    const body = res.body as SocialProfileView;
    expect(body.pid).toBe(cast.alice.pid);
    expect(body.handle.full).toBe(cast.alice.full);
    expect(typeof body.friendSince).toBe('number');
    expect(body.commonTitles).toBe(0);
    expect(body.mutualFriends).toBe(0);
    expect(body).not.toHaveProperty('tagChangeableAt');
  });

  it('foyer : profil visible, sans « depuis » (pas d’amitié)', async () => {
    const res = await profileOfFriend(cast.alice, cast.alice2.pid);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('friendSince');
    expect((res.body as SocialProfileView).handle.full).toBe(cast.alice2.full);
  });

  it('étranger, demande en attente, pid inconnu, pid mal formé et enfant : 404 friend_not_found', async () => {
    const stranger = await profileOfFriend(cast.carol, cast.alice.pid);
    expect(stranger.status).toBe(404);
    expect((stranger.body as ErrorBodyV2).error).toBe('friend_not_found');

    const pending = await as(app, cast.carol, 'POST', '/user/social/requests', { body: { handle: cast.alice.full } });
    expect(pending.status).toBe(201);
    expect((await profileOfFriend(cast.carol, cast.alice.pid)).status).toBe(404);

    expect((await profileOfFriend(cast.bob, UNKNOWN_PID)).status).toBe(404);
    const malformed = await profileOfFriend(cast.bob, 'pas-un-pid');
    expect(malformed.status).toBe(404);
    expect((malformed.body as ErrorBodyV2).error).toBe('friend_not_found');
  });

  it('profil enfant : aucune route sociale (403 kid_profile)', async () => {
    const res = await as<ErrorBodyV2>(app, cast.kid, 'GET', `/user/social/friends/${cast.alice.pid}/profile`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
    expect((await as<ErrorBodyV2>(app, cast.kid, 'GET', '/user/social/profile')).status).toBe(403);
  });
});

describe('champs ajoutés à FriendView', () => {
  it('favori et sourdine à faux par défaut ; statut et avatar exposés quand ils existent', async () => {
    await befriend(app, cast.bob, cast.alice);
    const list = await friendsOf(cast.bob);
    const alice = findFriend(list.body.friends, cast.alice.pid);
    expect(alice).toMatchObject({ favorite: false, muted: false, household: false });
    expect(alice).not.toHaveProperty('nickname');

    await write(cast.alice, { customStatus: { emoji: '🍿', text: 'Soirée film', expiresAt: Date.now() + DAY_MS } });
    const withStatus = await friendsOf(cast.bob);
    expect(findFriend(withStatus.body.friends, cast.alice.pid)?.customStatus).toMatchObject({ emoji: '🍿', text: 'Soirée film' });
  });

  it('réponse d’acceptation : FriendView avec favori et sourdine à faux', async () => {
    await as(app, cast.bob, 'POST', '/user/social/requests', { body: { handle: cast.alice.full } });
    const accepted = await as<{ friend: FriendView }>(app, cast.alice, 'POST', `/user/social/requests/${cast.bob.pid}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.friend).toMatchObject({ pid: cast.bob.pid, favorite: false, muted: false });
  });
});
