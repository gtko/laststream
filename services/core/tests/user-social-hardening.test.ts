import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { signLiveTicket } from '../src/party/ticket.js';
import { SECRET } from './lt-harness.js';
import { handleSocialLiveWs } from '../src/user/social-v2-live-ws.js';
import { SOCIAL_LIVE_EXP_HEADER, SOCIAL_LIVE_NONCE_HEADER, SOCIAL_LIVE_PID_HEADER } from '../src/user/social-v2-live.js';
import { consumeLiveTicketNonce, isLiveEligible } from '../src/user/social-v2-live-tickets.js';
import { syncProfileIdentity } from '../src/user/social-handles.js';
import { SocialStore } from '../src/user/social-store.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';
import { isSingleEmoji, presenceSchema } from '../src/user/social-v2-validation.js';
import { MIGRATIONS } from '../src/user/migrations.js';
import type { SqlDb } from '../src/user/sql.js';
import { type ProfileFields, UserStore } from '../src/user/store.js';

/** Node uniquement (node:sqlite). Durcissement Social v2 : révocation legacy, ticket live à usage unique, validation, quota des demandes. */

const NOW = '2026-05-01T10:00:00.000Z';

const adult = (name: string): ProfileFields => ({ name, avatarColor: '#000000', avatar: null, isKid: false, kidMaxAge: null, pinHash: null, allowedCatalogs: [] });

function account(db: SqlDb, id: string): void {
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', 0, ?)").run(id, id, NOW);
}

const pidOf = (db: SqlDb, profileId: string): string => (db.prepare('SELECT pid FROM profiles WHERE id = ?').get(profileId) as { pid: string }).pid;
const legacyCount = (db: SqlDb): number => Number((db.prepare('SELECT COUNT(*) AS n FROM friendships').get() as { n: number }).n);

/** a1 (principal p1, second adulte p1b) et a2 (principal p2). */
function twoAccounts(): { db: SqlDb; users: UserStore; p1: string; p1b: string; p2: string } {
  const db = openUserDb(':memory:');
  account(db, 'a1');
  account(db, 'a2');
  const users = new UserStore(db);
  users.insertProfile('a1', 'p1', adult('Greg'), '2026-01-01T00:00:00.000Z');
  users.insertProfile('a1', 'p1b', adult('Greg Deux'), '2026-01-02T00:00:00.000Z');
  users.insertProfile('a2', 'p2', adult('Ana'), '2026-01-03T00:00:00.000Z');
  return { db, users, p1: pidOf(db, 'p1'), p1b: pidOf(db, 'p1b'), p2: pidOf(db, 'p2') };
}

function friendV2(db: SqlDb, a: string, b: string): void {
  const [low, high] = a < b ? [a, b] : [b, a];
  db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', 1)").run(low, high, low);
}

const friendLegacy = (db: SqlDb): void => {
  db.prepare("INSERT INTO friendships (low_id, high_id, requested_by, status, created_at) VALUES ('a1', 'a2', 'a2', 'accepted', ?)").run(NOW);
};

describe('révocation de l amitié legacy', () => {
  it('removeFriend v2 entre profils principaux supprime aussi l amitié compte-compte', () => {
    const { db, p1, p2 } = twoAccounts();
    friendV2(db, p1, p2);
    friendLegacy(db);
    expect(new SocialV2Store(db).removeFriend(p1, p2)).toBe(true);
    expect(legacyCount(db)).toBe(0);
  });

  it('removeFriend v2 avec un profil non principal laisse l amitié legacy', () => {
    const { db, p1b, p2 } = twoAccounts();
    friendV2(db, p1b, p2);
    friendLegacy(db);
    expect(new SocialV2Store(db).removeFriend(p1b, p2)).toBe(true);
    expect(legacyCount(db)).toBe(1);
  });

  it('un profil principal qui devient enfant (clearIdentity) emporte l amitié legacy', () => {
    const { db, p1, p2 } = twoAccounts();
    friendV2(db, p1, p2);
    friendLegacy(db);
    syncProfileIdentity(db, 'a1', 'p1', 'Greg', true);
    expect(legacyCount(db)).toBe(0);
  });

  it('la suppression du profil principal emporte l amitié legacy', () => {
    const { db, users, p1, p2 } = twoAccounts();
    friendV2(db, p1, p2);
    friendLegacy(db);
    expect(users.deleteProfile('a1', 'p1')).toBe(true);
    expect(legacyCount(db)).toBe(0);
  });

  it('la suppression d un profil non principal laisse l amitié legacy', () => {
    const { db, users, p1b, p2 } = twoAccounts();
    friendV2(db, p1b, p2);
    friendLegacy(db);
    expect(users.deleteProfile('a1', 'p1b')).toBe(true);
    expect(legacyCount(db)).toBe(1);
  });

  it('listFriends legacy masque titre et présence d un compte dont le profil principal est invisible en v2', () => {
    const { db, p2 } = twoAccounts();
    friendLegacy(db);
    const legacy = new SocialStore(db);
    legacy.setPresence('a2', null, { type: 'movie', title: 'Matrix' } as never, false, NOW);
    const visible = legacy.listFriends('a1', NOW).friends[0];
    expect(visible?.status).toBe('watching');
    db.prepare("INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES (?, 'invisible', NULL, 1)").run(p2);
    const hidden = legacy.listFriends('a1', NOW).friends[0];
    expect(hidden?.status).toBe('offline');
    expect(hidden?.watching).toBeNull();
  });
});

describe('ticket du flux temps réel : usage unique', () => {
  it('migration v16 en tête', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(16);
  });

  it('un nonce ne se consomme qu une fois, les échus sont purgés, un ticket échu est refusé', () => {
    const db = openUserDb(':memory:');
    expect(consumeLiveTicketNonce(db, 'n1', 2000, 1000)).toBe(true);
    expect(consumeLiveTicketNonce(db, 'n1', 2000, 1500)).toBe(false);
    expect(consumeLiveTicketNonce(db, 'n2', 900, 1000)).toBe(false);
    expect(consumeLiveTicketNonce(db, 'n3', 5000, 2000)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM live_ticket_nonces').get() as { n: number }).n).toBe(1);
  });

  it('profil supprimé ou inconnu : inéligible', () => {
    const { db, users, p1 } = twoAccounts();
    expect(isLiveEligible(db, p1)).toBe(true);
    expect(isLiveEligible(db, 'ABCDEFGHIJKLMNOP')).toBe(false);
    users.deleteProfile('a1', 'p1');
    expect(isLiveEligible(db, p1)).toBe(false);
  });

  it('le Worker transmet nonce et échéance du ticket et écrase les en-têtes forgés', async () => {
    const now = Date.now();
    const { ticket } = signLiveTicket('ABCDEFGHIJKLMNOP', 'compte-1', now, SECRET);
    let seen: Request | undefined;
    const res = await handleSocialLiveWs(
      new Request(`https://worker.test/user/social/live?ticket=${ticket}`, {
        headers: { upgrade: 'websocket', [SOCIAL_LIVE_PID_HEADER]: 'FORGE', [SOCIAL_LIVE_NONCE_HEADER]: 'forge', [SOCIAL_LIVE_EXP_HEADER]: '99' },
      }),
      {
        secret: SECRET,
        ip: '10.0.0.1',
        now,
        forward: (forwarded) => {
          seen = forwarded;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      },
    );
    expect(res.status).toBe(204);
    expect(seen?.headers.get(SOCIAL_LIVE_PID_HEADER)).toBe('ABCDEFGHIJKLMNOP');
    expect(seen?.headers.get(SOCIAL_LIVE_NONCE_HEADER)).not.toBe('forge');
    expect(seen?.headers.get(SOCIAL_LIVE_NONCE_HEADER)?.length).toBeGreaterThan(5);
    expect(Number(seen?.headers.get(SOCIAL_LIVE_EXP_HEADER))).toBeGreaterThan(now);
  });
});

describe('validation', () => {
  const base = { type: 'movie', tmdbId: 1, title: 'Matrix', pos: 1, paused: false, at: 1 };
  const watching = (extra: Record<string, unknown> = {}) => ({ watching: { ...base, ...extra } });

  it('affiche : TMDB en https ou chemin du site, sinon supprimée sans erreur', () => {
    const poster = (value: string): string | undefined => presenceSchema.parse(watching({ poster: value })).watching?.poster;
    expect(poster('https://image.tmdb.org/t/p/w500/a.jpg')).toBe('https://image.tmdb.org/t/p/w500/a.jpg');
    expect(poster('/posters/a.jpg')).toBe('/posters/a.jpg');
    for (const bad of ['http://image.tmdb.org/a.jpg', 'https://evil.example/a.jpg', '//evil.example/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'a.jpg', '']) {
      expect(poster(bad)).toBeUndefined();
    }
    expect(presenceSchema.safeParse(watching()).success).toBe(true);
  });

  it('titre de plus de 200 caractères : refusé', () => {
    expect(presenceSchema.safeParse(watching({ title: 'x'.repeat(201) })).success).toBe(false);
    expect(presenceSchema.safeParse(watching({ title: 'x'.repeat(200) })).success).toBe(true);
  });

  it('isSingleEmoji : un graphème plafonné à 16 unités de code', () => {
    expect(isSingleEmoji('👍')).toBe(true);
    expect(isSingleEmoji('👨‍👩‍👧‍👦')).toBe(true);
    expect(isSingleEmoji(`👍${'́'.repeat(40)}`)).toBe(false);
  });
});
