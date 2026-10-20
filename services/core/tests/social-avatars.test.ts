// Avatars réels dans le social et le salon : GET /user/social/me, vues d'amis, tickets du salon (col:…), avatar d'invité.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guestIdentity, signGuestToken, verifyGuestToken } from '../src/party/guest.js';
import { signTicket, verifyTicket } from '../src/party/ticket.js';
import { guestAvatarOf, isAvatarValue } from '../src/user/avatar.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, type Cast, castOf, HOOK_TIMEOUT_MS, type MeBody } from './social-v2-harness.js';

const SECRET = 'guest-test-secret-with-more-than-32-chars';
const ROOM = 'room-0123456789abcdef';
const T0 = 1_800_000_000_000;
const COL = 'col:marvel-heros:spider-man';

describe('formats d’avatar', () => {
  it('isAvatarValue : dicebear, hero et collection ; rien d’autre', () => {
    for (const ok of ['dicebear:lorelei:abc', 'hero:heros:Aegis', COL]) expect(isAvatarValue(ok)).toBe(true);
    for (const bad of ['', 'https://evil.example/a.png', 'col:../x:y', 'col:a', 3, null, 'hero:inconnu:x', 'x'.repeat(300)]) expect(isAvatarValue(bad)).toBe(false);
  });

  it('guestAvatarOf : dicebear/hero, collections enfants seulement, jamais d’URL', () => {
    expect(guestAvatarOf('hero:heros:Aegis')).toBe('hero:heros:Aegis');
    expect(guestAvatarOf('dicebear:lorelei:abc')).toBe('dicebear:lorelei:abc');
    expect(guestAvatarOf('col:inconnue:x')).toBeUndefined();
    expect(guestAvatarOf('https://evil.example/a.png')).toBeUndefined();
    expect(guestAvatarOf('javascript:alert(1)')).toBeUndefined();
    expect(guestAvatarOf(undefined)).toBeUndefined();
    expect(guestAvatarOf('a'.repeat(500))).toBeUndefined();
  });
});

describe('ticket du salon et jeton d’invité', () => {
  it('le ticket garde un avatar de collection (col:…), il était écarté', () => {
    const { ticket } = signTicket(ROOM, { accountId: 'a-1', username: 'greg', avatarColor: '#3b82f6', avatar: COL }, T0, SECRET);
    expect(verifyTicket(ticket, ROOM, T0, SECRET)).toEqual({ accountId: 'a-1', username: 'greg', avatarColor: '#3b82f6', avatar: COL });
  });

  it('le ticket écarte un avatar de format inconnu', () => {
    const { ticket } = signTicket(ROOM, { accountId: 'a-1', username: 'greg', avatarColor: '#3b82f6', avatar: 'https://evil.example/a.png' }, T0, SECRET);
    expect(verifyTicket(ticket, ROOM, T0, SECRET)).toEqual({ accountId: 'a-1', username: 'greg', avatarColor: '#3b82f6' });
  });

  it('le jeton d’invité porte l’avatar choisi ; absent ou hors liste blanche : ignoré', async () => {
    const withAvatar = await signGuestToken(ROOM, T0, SECRET, { gid: 'abcdefghijklmnop', avatar: 'hero:heros:Aegis' });
    expect(await verifyGuestToken(withAvatar.token, ROOM, T0, SECRET)).toEqual({ guestId: 'abcdefghijklmnop', avatar: 'hero:heros:Aegis' });
    const plain = await signGuestToken(ROOM, T0, SECRET, { gid: 'abcdefghijklmnop' });
    expect(await verifyGuestToken(plain.token, ROOM, T0, SECRET)).toEqual({ guestId: 'abcdefghijklmnop' });
    const forged = await signGuestToken(ROOM, T0, SECRET, { gid: 'abcdefghijklmnop', avatar: 'https://evil.example/a.png' });
    expect(await verifyGuestToken(forged.token, ROOM, T0, SECRET)).toEqual({ guestId: 'abcdefghijklmnop' });
  });

  it('identité d’invité avec avatar', () => {
    expect(guestIdentity('abcdefghijklmnop', 'Léa', 'hero:heros:Aegis')).toMatchObject({ username: 'Léa', avatar: 'hero:heros:Aegis', guest: true });
    expect(guestIdentity('abcdefghijklmnop', 'Léa')).not.toHaveProperty('avatar');
  });
});

describe('social : avatar du profil renvoyé partout', () => {
  let app: RunningApp;
  let cast: Cast;
  beforeEach(async () => {
    app = await startApp({});
    cast = await castOf(app);
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await app.close();
  });

  it('GET /user/social/me renvoie l’avatar du profil agissant, et la vue d’ami des autres aussi', async () => {
    expect((await as<MeBody>(app, cast.alice, 'GET', '/user/social/me')).body).not.toHaveProperty('avatar');
    const set = await as(app, cast.alice, 'PATCH', `/user/profiles/${cast.alice.profile}`, { body: { avatar: COL } });
    expect(set.status).toBe(200);
    const me = await as<MeBody & { avatar?: string }>(app, cast.alice, 'GET', '/user/social/me');
    expect(me.body.avatar).toBe(COL);
    await befriend(app, cast.alice, cast.bob);
    const friends = await as<{ friends: { pid: string; avatar?: string }[] }>(app, cast.bob, 'GET', '/user/social/friends');
    expect(friends.body.friends.find((f) => f.pid === cast.alice.pid)?.avatar).toBe(COL);
  }, HOOK_TIMEOUT_MS);
});
