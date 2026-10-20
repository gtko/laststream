import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { AdminStore } from '../src/user/admin-store.js';
import { deviceLabel, storedUserAgent, USER_AGENT_MAX_LENGTH } from '../src/user/session-device.js';
import type { SqlDb } from '../src/user/sql.js';
import { SESSION_TOUCH_INTERVAL_MS, UserStore } from '../src/user/store.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { type LoginBody, PASSWORD, request } from './user-harness.js';

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const DESKTOP_APP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) laststream-desktop/1.4.0 Chrome/125.0.0.0 Electron/31.0.0 Safari/537.36';

describe('libellé d appareil (fonction pure)', () => {
  it.each([
    ['Android Chrome', ANDROID_CHROME, 'Android · Chrome'],
    ['iPhone Safari', IPHONE_SAFARI, 'iPhone · Safari'],
    ['iPhone Chrome (CriOS)', IPHONE_SAFARI.replace('Version/17.4', 'CriOS/125.0.6422.80'), 'iPhone · Chrome'],
    ['iPad', IPHONE_SAFARI.replace('iPhone', 'iPad'), 'iPad · Safari'],
    ['Windows Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0', 'Windows · Edge'],
    ['Windows Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0', 'Windows · Firefox'],
    ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 'macOS · Safari'],
    ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0', 'Linux · Firefox'],
    ['application de bureau Laststream', DESKTOP_APP, 'Windows · Laststream Desktop'],
    ['client HTTP générique', 'node', null],
    ['absent', null, null],
    ['vide', '   ', null],
  ])('%s', (_name, userAgent, expected) => {
    expect(deviceLabel(userAgent)).toBe(expected);
  });

  it('user-agent stocké : espaces retirés, tronqué à 200 caractères, null si vide', () => {
    expect(storedUserAgent(`  ${'x'.repeat(300)}  `)).toBe('x'.repeat(USER_AGENT_MAX_LENGTH));
    expect(storedUserAgent('   ')).toBeNull();
    expect(storedUserAgent(undefined)).toBeNull();
    expect(USER_AGENT_MAX_LENGTH).toBe(200);
  });
});

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const INSERT_ALICE = "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01T00:00:00.000Z')";

function sessionRow(db: SqlDb, tokenHash: string): { user_agent: string | null; last_seen_at: number | null } | undefined {
  return db.prepare('SELECT user_agent, last_seen_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
    | { user_agent: string | null; last_seen_at: number | null }
    | undefined;
}

describe('sessions : user-agent et dernière activité (store)', () => {
  let db: SqlDb;
  let store: UserStore;

  beforeEach(() => {
    db = openUserDb(':memory:');
    db.prepare(INSERT_ALICE).run();
    store = new UserStore(db);
  });
  afterEach(() => {
    db.close();
  });

  it('user-agent renseigné à la connexion, tronqué à 200 caractères ; absent ou vide : NULL', () => {
    store.startSession('a1', 'long', at(0), FAR_FUTURE, 'y'.repeat(300));
    store.startSession('a1', 'vide', at(0), FAR_FUTURE, '   ');
    store.startSession('a1', 'sans', at(0), FAR_FUTURE);
    expect(sessionRow(db, 'long')?.user_agent).toBe('y'.repeat(USER_AGENT_MAX_LENGTH));
    expect(sessionRow(db, 'vide')?.user_agent).toBeNull();
    expect(sessionRow(db, 'sans')?.user_agent).toBeNull();
  });

  it('rotation : la nouvelle session garde le user-agent de la requête', () => {
    store.startSession('a1', 'old', at(0), FAR_FUTURE, ANDROID_CHROME);
    expect(store.rotateSession('old', 'new', 'a1', at(1), FAR_FUTURE, IPHONE_SAFARI)).toBe(true);
    expect(sessionRow(db, 'old')).toBeUndefined();
    expect(sessionRow(db, 'new')?.user_agent).toBe(IPHONE_SAFARI);
  });

  it('dernière activité : jamais écrite à la connexion, puis au plus une fois toutes les 5 min', () => {
    expect(SESSION_TOUCH_INTERVAL_MS).toBe(5 * 60_000);
    store.startSession('a1', 'h1', at(0), FAR_FUTURE, null);
    expect(sessionRow(db, 'h1')?.last_seen_at).toBeNull();

    expect(store.accountForSession('h1', at(1))?.id).toBe('a1');
    expect(sessionRow(db, 'h1')?.last_seen_at).toBe(Date.parse(at(1)));

    // Quatre minutes plus tard : aucune écriture (la valeur reste celle de la minute 1).
    expect(store.accountForSession('h1', at(5))?.id).toBe('a1');
    expect(sessionRow(db, 'h1')?.last_seen_at).toBe(Date.parse(at(1)));

    // Cinq minutes écoulées : la dernière activité est mise à jour.
    expect(store.accountForSession('h1', at(6))?.id).toBe('a1');
    expect(sessionRow(db, 'h1')?.last_seen_at).toBe(Date.parse(at(6)));
  });

  it('session expirée : aucune résolution, aucune écriture', () => {
    store.startSession('a1', 'expire', at(0), at(10), null);
    expect(store.accountForSession('expire', at(20))).toBeUndefined();
    expect(sessionRow(db, 'expire')?.last_seen_at).toBeNull();
  });

  it('vue administrateur : libellé d appareil et dernière activité (ou date de connexion)', () => {
    store.startSession('a1', 'android', at(0), FAR_FUTURE, ANDROID_CHROME);
    store.startSession('a1', 'iphone', at(1), FAR_FUTURE, IPHONE_SAFARI);
    store.startSession('a1', 'inconnu', at(2), FAR_FUTURE, 'node');
    store.accountForSession('iphone', at(7));

    const sessions = new AdminStore(db).accountDetail('a1')?.sessions ?? [];
    const byDevice = (device: string | null) => sessions.find((session) => session.device === device);
    expect(sessions).toHaveLength(3);
    expect(byDevice('Android · Chrome')).toMatchObject({ createdAt: at(0), lastSeenAt: at(0), expiresAt: FAR_FUTURE });
    expect(byDevice('iPhone · Safari')).toMatchObject({ createdAt: at(1), lastSeenAt: at(7) });
    expect(byDevice(null)).toMatchObject({ createdAt: at(2), lastSeenAt: at(2) });
    expect(JSON.stringify(sessions)).not.toMatch(/token|hash/i);
  });
});

describe('connexion et rafraîchissement : user-agent enregistré (HTTP)', () => {
  let dir: string;
  let file: string;
  let app: RunningApp;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lastaddon-sessions-'));
    file = join(dir, 'laststream.db');
    app = await startApp({ userDbPath: file });
    await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('login : user-agent de la requête gardé (tronqué), dernière activité absente tant que la session n est pas utilisée', async () => {
    const res = await request<LoginBody>(app, 'POST', '/user/login', {
      body: { username: 'alice', password: PASSWORD },
      headers: { 'user-agent': `${ANDROID_CHROME}${'z'.repeat(300)}` },
    });
    expect(res.status).toBe(200);
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT user_agent, last_seen_at FROM sessions').all() as { user_agent: string; last_seen_at: number | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_agent).toBe(`${ANDROID_CHROME}${'z'.repeat(300)}`.slice(0, USER_AGENT_MAX_LENGTH));
      expect(rows[0]?.last_seen_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refresh : la session renouvelée garde le user-agent de la requête', async () => {
    const { token } = (await request<LoginBody>(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).body;
    const res = await request<LoginBody>(app, 'POST', '/user/refresh', { token, headers: { 'user-agent': IPHONE_SAFARI } });
    expect(res.status).toBe(200);
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT user_agent, last_seen_at FROM sessions').all() as { user_agent: string; last_seen_at: number | null }[];
      expect(rows.map((row) => row.user_agent)).toEqual([IPHONE_SAFARI]);
      expect(rows[0]?.last_seen_at).toBeNull();
    } finally {
      db.close();
    }
  });
});
