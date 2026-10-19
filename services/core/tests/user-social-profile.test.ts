import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { activeCustomStatus, SocialV2Store, TAG_COOLDOWN_MS } from '../src/user/social-v2-store.js';
import type { SqlDb } from '../src/user/sql.js';
import { type ProfileEditableFields, type ProfileFields, UserStore } from '../src/user/store.js';

// Node uniquement (base SQLite locale, horloge injectée) : cooldown du tag, expiration du statut, réglages par ami,
// points communs, chiffres et effet de la perte d'identité. Les routes HTTP sont couvertes par social-v2-profile.test.ts.

const NOW = '2026-05-01T10:00:00.000Z';
const T0 = Date.parse(NOW);

function addAccount(db: SqlDb, id: string, owner = false): void {
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', ?, ?)").run(id, id, owner ? 1 : 0, NOW);
}

function adult(name: string): ProfileFields {
  return { name, avatarColor: '#000000', avatar: null, isKid: false, kidMaxAge: null, pinHash: null, allowedCatalogs: [] };
}

function editable(name: string, isKid = false): ProfileEditableFields {
  return { name, avatarColor: '#000000', avatar: null, isKid, kidMaxAge: isKid ? 12 : null, allowedCatalogs: [] };
}

interface Who {
  id: string;
  pid: string;
  key: string;
  tag: string;
}

function whoOf(db: SqlDb, id: string): Who {
  const row = db.prepare('SELECT id, pid, handle_key, handle_tag FROM profiles WHERE id = ?').get(id) as unknown as {
    id: string;
    pid: string;
    handle_key: string;
    handle_tag: string;
  };
  return { id: row.id, pid: row.pid, key: row.handle_key, tag: row.handle_tag };
}

function setup(): { db: SqlDb; users: UserStore; social: SocialV2Store; greg: Who; maman: Who; bob: Who; carol: Who } {
  const db = openUserDb(':memory:');
  addAccount(db, 'a1', true);
  addAccount(db, 'a2');
  addAccount(db, 'a3');
  const users = new UserStore(db);
  users.insertProfile('a1', 'greg', adult('Greg'), NOW);
  users.insertProfile('a1', 'maman', adult('Maman'), NOW);
  users.insertProfile('a2', 'bob', adult('Bob'), NOW);
  users.insertProfile('a3', 'carol', adult('Carol'), NOW);
  const social = new SocialV2Store(db);
  return { db, users, social, greg: whoOf(db, 'greg'), maman: whoOf(db, 'maman'), bob: whoOf(db, 'bob'), carol: whoOf(db, 'carol') };
}

/** Amitié acceptée à l'instant `at` : `from` demande, `to` accepte. */
function befriend(social: SocialV2Store, from: Who, to: Who, at: number): void {
  social.requestFriend(from.pid, to.key, to.tag, at);
  social.acceptRequest(to.pid, from.pid, at + 1);
}

/** Titre dans la bibliothèque d'un profil (film, visibilité donnée). */
function addTitle(db: SqlDb, profileId: string, titleRef: string, visibility: 'private' | 'friends'): void {
  db.prepare("INSERT INTO library_items (profile_id, type, title_ref, tmdb_id, title, added_at, removed, visibility) VALUES (?, 'movie', ?, 1, 'Film', ?, 0, ?)").run(
    profileId,
    titleRef,
    NOW,
    visibility,
  );
}

describe('changement de tag : cooldown de 30 jours', () => {
  it('le premier changement est libre ; le suivant est refusé jusqu’au terme exact', () => {
    const { social, greg } = setup();
    const first = social.changeTag(greg.pid, T0);
    expect(first.result).toBe('ok');
    const tag = first.result === 'ok' ? first.tag : '';
    expect(tag).not.toBe(greg.tag);

    expect(social.changeTag(greg.pid, T0 + TAG_COOLDOWN_MS - 1000)).toEqual({ result: 'cooldown', retryAfterSec: 1 });
    expect(social.changeTag(greg.pid, T0 + TAG_COOLDOWN_MS - 1)).toEqual({ result: 'cooldown', retryAfterSec: 1 });
    const second = social.changeTag(greg.pid, T0 + TAG_COOLDOWN_MS);
    expect(second.result).toBe('ok');
    expect(second.result === 'ok' && second.tag !== tag).toBe(true);
  });

  it('tagChangeableAt : présent pour soi pendant le blocage, absent après, absent pour un autre', () => {
    const { social, greg, bob } = setup();
    social.changeTag(greg.pid, T0);
    expect(social.profileOf(greg.pid, T0 + 10)?.tagChangeableAt).toBe(T0 + TAG_COOLDOWN_MS);
    expect(social.profileOf(greg.pid, T0 + TAG_COOLDOWN_MS)).not.toHaveProperty('tagChangeableAt');
    expect(social.changeTag('UNKNOWNPID234567', T0)).toEqual({ result: 'unknown' });
    befriend(social, greg, bob, T0);
    expect(social.friendProfileOf(bob.pid, greg.pid, T0 + 10)).not.toHaveProperty('tagChangeableAt');
  });
});

describe('statut personnalisé : expiration', () => {
  it('actif avant l’échéance, absent à l’échéance, sur le profil comme dans les amis', () => {
    const { social, greg, bob } = setup();
    befriend(social, bob, greg, T0);
    social.updateSocialProfile(greg.pid, { customStatus: { emoji: '🎬', text: 'Ciné', expiresAt: T0 + 1000 } });
    expect(social.profileOf(greg.pid, T0 + 999)?.customStatus).toEqual({ emoji: '🎬', text: 'Ciné', expiresAt: T0 + 1000 });
    expect(social.profileOf(greg.pid, T0 + 1000)?.customStatus).toBeUndefined();
    expect(social.listFriends(bob.pid, T0 + 999).friends[0]?.customStatus).toMatchObject({ text: 'Ciné' });
    expect(social.listFriends(bob.pid, T0 + 1000).friends[0]).not.toHaveProperty('customStatus');
  });

  it('activeCustomStatus : sans échéance, toujours actif ; JSON illisible ignoré', () => {
    expect(activeCustomStatus(JSON.stringify({ text: 'Toujours' }), T0 + 10 * TAG_COOLDOWN_MS)).toEqual({ text: 'Toujours' });
    expect(activeCustomStatus('{pas du json', T0)).toBeUndefined();
    expect(activeCustomStatus(null, T0)).toBeUndefined();
  });
});

describe('réglages par ami (profile_relations)', () => {
  it('favori, surnom et sourdine lus depuis la relation ; défauts sans ligne', () => {
    const { db, social, greg, bob, carol } = setup();
    befriend(social, greg, bob, T0);
    befriend(social, greg, carol, T0);
    db.prepare("INSERT INTO profile_relations (owner_pid, target_pid, favorite, nickname, muted) VALUES (?, ?, 1, 'Bobby', 1)").run(greg.pid, bob.pid);

    const view = social.listFriends(greg.pid, T0).friends;
    expect(view.find((friend) => friend.pid === bob.pid)).toMatchObject({ favorite: true, muted: true, nickname: 'Bobby', household: false });
    const plain = view.find((friend) => friend.pid === carol.pid);
    expect(plain).toMatchObject({ favorite: false, muted: false });
    expect(plain).not.toHaveProperty('nickname');
    expect(social.listFriends(bob.pid, T0).friends[0]).toMatchObject({ favorite: false, muted: false });
  });

  it('une amitié retirée efface les réglages du couple ; devenir enfant efface toutes les relations du profil', () => {
    const { db, users, social, greg, bob, maman } = setup();
    befriend(social, greg, bob, T0);
    db.prepare('INSERT INTO profile_relations (owner_pid, target_pid, favorite) VALUES (?, ?, 1)').run(greg.pid, bob.pid);
    db.prepare('INSERT INTO profile_relations (owner_pid, target_pid, favorite) VALUES (?, ?, 1)').run(maman.pid, greg.pid);
    expect(social.removeFriend(greg.pid, bob.pid)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_relations WHERE owner_pid = ? OR target_pid = ?').get(greg.pid, bob.pid)).toEqual({ n: 0 });

    db.prepare('INSERT INTO profile_relations (owner_pid, target_pid, favorite) VALUES (?, ?, 1)').run(greg.pid, maman.pid);
    users.updateProfile('a1', greg.id, editable('Greg', true));
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_relations WHERE owner_pid = ? OR target_pid = ?').get(greg.pid, greg.pid)).toEqual({ n: 0 });
  });
});

describe('profil social : chiffres, points communs, avatar', () => {
  it('stats : heures regardées (progression), notes posées, amis acceptés', () => {
    const { db, social, greg, bob, carol } = setup();
    befriend(social, greg, bob, T0);
    befriend(social, carol, greg, T0);
    db.prepare(
      "INSERT INTO progress (profile_id, type, title_ref, tmdb_id, season, episode, position_sec, duration_sec, updated_at, finished) VALUES (?, 'movie', 'tmdb:1', 1, 0, 0, 5400, 7200, ?, 0)",
    ).run(greg.id, NOW);
    expect(social.addNote(greg.pid, { type: 'movie', tmdbId: 1 }, 10, 'text', 'Bien', T0).result).toBe('ok');
    expect(social.profileOf(greg.pid, T0)?.stats).toEqual({ hoursWatched: 1.5, notes: 1, friends: 2 });
  });

  it('amis en commun et « depuis » ; titres communs limités aux titres « friends » pour un ami', () => {
    const { db, social, greg, bob, carol, maman } = setup();
    addTitle(db, greg.id, 'tmdb:1', 'private');
    addTitle(db, greg.id, 'tmdb:2', 'private');
    addTitle(db, bob.id, 'tmdb:1', 'friends');
    addTitle(db, bob.id, 'tmdb:2', 'private');
    addTitle(db, maman.id, 'tmdb:2', 'private');
    befriend(social, greg, bob, T0);
    befriend(social, carol, greg, T0);
    befriend(social, carol, bob, T0 + 500);

    const friendView = social.friendProfileOf(greg.pid, bob.pid, T0 + 1000);
    expect(friendView?.commonTitles).toBe(1);
    expect(friendView?.mutualFriends).toBe(1);
    expect(friendView?.friendSince).toBe(T0 + 1);
    expect(social.friendProfileOf(greg.pid, maman.pid, T0)?.commonTitles).toBe(1);
    expect(social.friendProfileOf(greg.pid, maman.pid, T0)).not.toHaveProperty('friendSince');
  });

  it('avatar existant exposé sur le profil, sur l’ami et sur la note', () => {
    const { db, users, social, greg, bob } = setup();
    befriend(social, greg, bob, T0);
    users.updateProfile('a1', greg.id, { ...editable('Greg'), avatar: 'dicebear:adventurer:abc123' });
    expect(social.profileOf(greg.pid, T0)?.avatar).toBe('dicebear:adventurer:abc123');
    expect(social.listFriends(bob.pid, T0).friends[0]?.avatar).toBe('dicebear:adventurer:abc123');
    const note = social.addNote(greg.pid, { type: 'movie', tmdbId: 1 }, 1, 'emoji', '🎬', T0);
    expect(note.result === 'ok' && note.note.author.avatar).toBe('dicebear:adventurer:abc123');
  });
});
