import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openUserDb, wrapSqlite } from '../src/platform/node/user-db.js';
import { migrate, MIGRATIONS } from '../src/user/migrations.js';
import { HANDLE_TAG_ALPHABET, PID_ALPHABET, type RandomBytes, syncProfileIdentity } from '../src/user/social-handles.js';
import type { SqlDb } from '../src/user/sql.js';
import { type ProfileEditableFields, type ProfileFields, UserStore } from '../src/user/store.js';

// Node uniquement (node:sqlite) : la logique de handle est couverte côté Workers par social-handles.test.ts.

const NOW = '2026-05-01T10:00:00.000Z';
const TAG_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const PID_PATTERN = /^[A-Z2-7]{16}$/;

interface Identity {
  id: string;
  handle_name: string | null;
  handle_key: string | null;
  handle_tag: string | null;
  pid: string | null;
}

function identityOf(db: SqlDb, id: string): Identity {
  return db.prepare('SELECT id, handle_name, handle_key, handle_tag, pid FROM profiles WHERE id = ?').get(id) as unknown as Identity;
}

function addAccount(db: SqlDb, id: string, owner = false): void {
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', ?, ?)").run(
    id,
    id,
    owner ? 1 : 0,
    NOW,
  );
}

function adult(name: string): ProfileFields {
  return { name, avatarColor: '#000000', avatar: null, isKid: false, kidMaxAge: null, pinHash: null, allowedCatalogs: [] };
}

function editable(name: string, isKid = false): ProfileEditableFields {
  return { name, avatarColor: '#000000', avatar: null, isKid, kidMaxAge: isKid ? 12 : null, allowedCatalogs: [] };
}

function setup(): { db: SqlDb; store: UserStore } {
  const db = openUserDb(':memory:');
  addAccount(db, 'a1', true);
  addAccount(db, 'a2');
  return { db, store: new UserStore(db) };
}

/** Insertion brute d'un profil adulte (sans passer par le store, donc sans identité). */
function rawAdult(db: SqlDb, id: string, accountId: string, name: string): void {
  db.prepare(
    "INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, allowed_catalogs, created_at) VALUES (?, ?, ?, '#000000', 0, '[]', ?)",
  ).run(id, accountId, name, NOW);
}

/** Générateur scripté : un octet par appel, dans l'ordre. Épuisé, il échoue au lieu de boucler. */
function scripted(values: number[]): RandomBytes {
  const queue = [...values];
  return (bytes) => {
    const next = queue.shift();
    if (next === undefined) throw new Error('suite aléatoire épuisée');
    bytes[0] = next;
  };
}

const tagBytes = (tag: string): number[] => [...tag].map((symbol) => HANDLE_TAG_ALPHABET.indexOf(symbol));
const pidBytes = (pid: string): number[] => [...pid].map((symbol) => PID_ALPHABET.indexOf(symbol));

describe('identité sociale des profils', () => {
  it('profil adulte : handle Nom#TAG et pid attribués ; profil enfant : aucun identifiant', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    store.insertProfile('a1', 'k1', { ...adult('Petit'), isKid: true, kidMaxAge: 12 }, NOW);
    const greg = identityOf(db, 'p1');
    expect(greg.handle_name).toBe('Greg');
    expect(greg.handle_key).toBe('greg');
    expect(greg.handle_tag).toMatch(TAG_PATTERN);
    expect(greg.pid).toMatch(PID_PATTERN);
    expect(identityOf(db, 'k1')).toEqual({ id: 'k1', handle_name: null, handle_key: null, handle_tag: null, pid: null });
  });

  it('unicité : même nom normalisé => tags distincts ; l’index unique refuse un doublon brut', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    store.insertProfile('a2', 'p2', adult('greg'), NOW);
    store.insertProfile('a2', 'p3', adult(' GREG '), NOW);
    const ids = ['p1', 'p2', 'p3'].map((id) => identityOf(db, id));
    expect(new Set(ids.map((identity) => identity.handle_key)).size).toBe(1);
    expect(new Set(ids.map((identity) => identity.handle_tag)).size).toBe(3);
    expect(new Set(ids.map((identity) => identity.pid)).size).toBe(3);
    expect(() => db.prepare("UPDATE profiles SET handle_tag = ? WHERE id = 'p2'").run(String(ids[0]?.handle_tag))).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE profiles SET pid = ? WHERE id = 'p2'").run(String(ids[0]?.pid))).toThrow(/UNIQUE/);
  });

  it('collision de tag : le tag déjà pris est écarté, un autre est tiré', () => {
    const { db } = setup();
    rawAdult(db, 'p1', 'a1', 'Greg');
    syncProfileIdentity(db, 'a1', 'p1', 'Greg', false, scripted([...pidBytes('AAAAAAAAAAAAAAAA'), ...tagBytes('A7K2')]));
    rawAdult(db, 'p2', 'a2', 'Greg');
    const taken = String(identityOf(db, 'p1').handle_tag);
    // Premier tirage : même tag que p1 (collision) ; second tirage : BCDE.
    syncProfileIdentity(db, 'a2', 'p2', 'Greg', false, scripted([...pidBytes('BBBBBBBBBBBBBBBB'), ...tagBytes(taken), ...tagBytes('BCDE')]));
    expect(identityOf(db, 'p1').handle_tag).toBe('A7K2');
    expect(identityOf(db, 'p2').handle_tag).toBe('BCDE');
  });

  it('collision de pid : le pid déjà pris est écarté, un autre est tiré', () => {
    const { db } = setup();
    rawAdult(db, 'p1', 'a1', 'Greg');
    syncProfileIdentity(db, 'a1', 'p1', 'Greg', false, scripted([...pidBytes('AAAAAAAAAAAAAAAA'), ...tagBytes('A7K2')]));
    rawAdult(db, 'p2', 'a2', 'Ana');
    const takenPid = String(identityOf(db, 'p1').pid);
    syncProfileIdentity(db, 'a2', 'p2', 'Ana', false, scripted([...pidBytes(takenPid), ...pidBytes('ZZZZZZZZZZZZZZZZ'), ...tagBytes('CDEF')]));
    expect(identityOf(db, 'p2').pid).toBe('ZZZZZZZZZZZZZZZZ');
    expect(identityOf(db, 'p2').handle_tag).toBe('CDEF');
  });

  it('renommage : nom et clé changent, tag et pid gardés', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    const before = identityOf(db, 'p1');
    store.updateProfile('a1', 'p1', editable('Gregoire'));
    const after = identityOf(db, 'p1');
    expect(after.handle_name).toBe('Gregoire');
    expect(after.handle_key).toBe('gregoire');
    expect(after.handle_tag).toBe(before.handle_tag);
    expect(after.pid).toBe(before.pid);
  });

  it('renommage en un nom déjà porté avec le même tag : nouveau tag, pid inchangé', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    const tagOfGreg = String(identityOf(db, 'p1').handle_tag);
    // Un autre profil porte « Lou » avec le tag de p1 (nom différent, donc pas de collision à sa création).
    rawAdult(db, 'p2', 'a2', 'Lou');
    syncProfileIdentity(db, 'a2', 'p2', 'Lou', false, scripted([...pidBytes('BBBBBBBBBBBBBBBB'), ...tagBytes(tagOfGreg)]));
    const pidOfGreg = identityOf(db, 'p1').pid;
    store.updateProfile('a1', 'p1', editable('Lou'));
    const renamed = identityOf(db, 'p1');
    expect(renamed.handle_key).toBe('lou');
    expect(renamed.handle_tag).toMatch(TAG_PATTERN);
    expect(renamed.handle_tag).not.toBe(identityOf(db, 'p2').handle_tag);
    expect(renamed.pid).toBe(pidOfGreg);
  });

  it('profil devenu enfant : identité, amitiés et présence retirées ; redevenu adulte : nouvelle identité', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    store.insertProfile('a2', 'p2', adult('Ana'), NOW);
    const [low, high] = [String(identityOf(db, 'p1').pid), String(identityOf(db, 'p2').pid)].sort();
    db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', 1)").run(
      low,
      high,
      String(identityOf(db, 'p1').pid),
    );
    db.prepare("INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES (?, 'online', NULL, 1)").run(identityOf(db, 'p1').pid);

    store.updateProfile('a1', 'p1', editable('Greg', true));
    expect(identityOf(db, 'p1')).toEqual({ id: 'p1', handle_name: null, handle_key: null, handle_tag: null, pid: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_friendships').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_presence').get()?.n).toBe(0);

    store.updateProfile('a1', 'p1', editable('Greg', false));
    expect(identityOf(db, 'p1').pid).toMatch(PID_PATTERN);
    expect(identityOf(db, 'p1').handle_tag).toMatch(TAG_PATTERN);
  });

  it('clés étrangères sur pid : suppression d’un profil => ses amitiés et sa présence partent avec lui', () => {
    const { db, store } = setup();
    store.insertProfile('a1', 'p1', adult('Greg'), NOW);
    store.insertProfile('a2', 'p2', adult('Ana'), NOW);
    const pidGreg = String(identityOf(db, 'p1').pid);
    const pidAna = String(identityOf(db, 'p2').pid);
    const [low, high] = [pidGreg, pidAna].sort();
    db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', 1)").run(
      low,
      high,
      pidGreg,
    );
    db.prepare("INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES (?, 'dnd', NULL, 1)").run(pidAna);
    // Une amitié entre deux pid inconnus est refusée (clés étrangères).
    expect(() =>
      db
        .prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES ('AAAAAAAAAAAAAAAA', 'ZZZZZZZZZZZZZZZZ', 'AAAAAAAAAAAAAAAA', 'pending', 1)")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM profiles WHERE id = 'p2'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_friendships').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_presence').get()?.n).toBe(0);
  });
});

describe('migration v13 : données sociales reprises sur les profils principaux', () => {
  it('amitiés compte↔compte -> profils principaux ; présence -> principal ; enfants sans identité', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 12));
    addAccount(db, 'a1', true);
    addAccount(db, 'a2');
    addAccount(db, 'a3');
    const insertProfile = (id: string, accountId: string, name: string, isKid: boolean, createdAt: string): void => {
      db.prepare(
        "INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at) VALUES (?, ?, ?, '#000000', ?, ?, '[]', ?)",
      ).run(id, accountId, name, isKid ? 1 : 0, isKid ? 12 : null, createdAt);
    };
    // a1 : un enfant (le plus ancien), puis le principal « Greg », puis un second adulte.
    insertProfile('k1', 'a1', 'Petit', true, '2026-01-01T00:00:00.000Z');
    insertProfile('p1', 'a1', 'Greg', false, '2026-01-02T10:00:00.000Z');
    insertProfile('p1b', 'a1', 'Greg Two', false, '2026-01-03T10:00:00.000Z');
    insertProfile('p2', 'a2', 'Ana', false, '2026-01-05T08:00:00.000Z');
    // a3 : seulement un enfant, donc aucun profil principal.
    insertProfile('k3', 'a3', 'Lilou', true, '2026-01-06T08:00:00.000Z');
    db.prepare("INSERT INTO friendships (low_id, high_id, requested_by, status, created_at) VALUES ('a1', 'a2', 'a2', 'accepted', '2026-02-01T12:00:00.123Z')").run();
    db.prepare("INSERT INTO friendships (low_id, high_id, requested_by, status, created_at) VALUES ('a1', 'a3', 'a1', 'pending', '2026-02-02T09:00:00.000Z')").run();
    db.prepare("INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES ('a1', 'p1', '2026-03-01T00:00:00.500Z', NULL, 1)").run();
    db.prepare("INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES ('a2', 'p2', '2026-03-01T00:00:01.000Z', NULL, 0)").run();
    db.prepare("INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES ('a3', 'k3', '2026-03-01T00:00:02.000Z', NULL, 0)").run();

    migrate(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(MIGRATIONS.length);
    const pidOf = (id: string): string => String(identityOf(db, id).pid);
    expect(identityOf(db, 'k1').pid).toBeNull();
    expect(identityOf(db, 'k3').pid).toBeNull();
    expect(pidOf('p1')).toMatch(PID_PATTERN);
    expect(pidOf('p1b')).toMatch(PID_PATTERN);
    expect(identityOf(db, 'p1b').handle_name).toBe('Greg Two');

    // Une seule amitié migrée : celle entre les principaux de a1 (Greg) et a2 (Ana). Celle de a3 n’a pas de principal.
    const [low, high] = [pidOf('p1'), pidOf('p2')].sort();
    expect(db.prepare('SELECT low_pid, high_pid, requested_by, status, created_at FROM profile_friendships').all()).toEqual([
      { low_pid: low, high_pid: high, requested_by: pidOf('p2'), status: 'accepted', created_at: Date.parse('2026-02-01T12:00:00.123Z') },
    ]);

    // Présence : rattachée au principal ; le statut invisible vient de l’ancien drapeau ; aucune pour a3.
    const presence = db.prepare('SELECT profile_pid, status, watching, updated_at FROM profile_presence').all();
    expect(presence).toHaveLength(2);
    expect(presence).toEqual(
      expect.arrayContaining([
        { profile_pid: pidOf('p1'), status: 'invisible', watching: null, updated_at: Date.parse('2026-03-01T00:00:00.500Z') },
        { profile_pid: pidOf('p2'), status: 'online', watching: null, updated_at: Date.parse('2026-03-01T00:00:01.000Z') },
      ]),
    );

    // Anciennes tables conservées pour les routes de compatibilité.
    expect(db.prepare('SELECT COUNT(*) AS n FROM friendships').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM presence').get()?.n).toBe(3);
  });
});
