import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApp, createApp } from '../src/app.js';
import { openUserDb } from '../src/platform/node/user-db.js';
import type { SqlDb } from '../src/user/sql.js';
import { type ProfileFields, type ProgressWrite, UserStore } from '../src/user/store.js';
import { countryCode, MIN_STARTS, RETENTION_DAYS, shiftDay, titleStartKey, utcDay } from '../src/user/title-starts.js';
import { DEFAULT_USER_RATE_LIMITS, SECRET } from './harness-core.js';

const NOW = '2026-10-19T10:00:00.000Z';
const DAY = '2026-10-19';
const PASSWORD = 'mot-de-passe-test-1';

afterEach(() => {
  vi.unstubAllEnvs();
});

const fields: ProfileFields = {
  name: 'Greg',
  avatarColor: '#112233',
  avatar: null,
  isKid: false,
  kidMaxAge: null,
  pinHash: null,
  allowedCatalogs: [],
};

function freshStore(): { db: SqlDb; store: UserStore } {
  const db = openUserDb(':memory:');
  return { db, store: new UserStore(db) };
}

/** Compte « username » avec le profil « username-p1 » (et les profils « username-<id> » demandés). */
function account(store: UserStore, username: string, extra: string[] = []): string {
  const result = store.createAccount({ username, passwordHash: 'h', allowSignup: true, now: NOW });
  if (!result.ok) throw new Error('compte non créé');
  store.insertProfile(result.account.id, `${username}-p1`, fields, NOW);
  for (const id of extra) store.insertProfile(result.account.id, `${username}-${id}`, fields, NOW);
  return `${username}-p1`;
}

function progress(overrides: Partial<ProgressWrite> & Pick<ProgressWrite, 'profileId'>): ProgressWrite {
  return {
    type: 'movie',
    tmdbId: 550,
    imdbId: null,
    season: 0,
    episode: 0,
    positionSec: 10,
    durationSec: 100,
    updatedAt: NOW,
    finished: false,
    country: 'CH',
    ...overrides,
  };
}

interface StartRow {
  day: string;
  country: string;
  key: string;
  n: number;
}

function starts(db: SqlDb): StartRow[] {
  return db.prepare('SELECT day, country, key, n FROM title_starts ORDER BY day, country, key').all() as unknown as StartRow[];
}

describe('fonctions pures : pays, jours, clés', () => {
  it('pays : code à deux lettres en majuscules, sinon XX (absent, invalide, Tor, non-chaîne)', () => {
    expect(countryCode('ch')).toBe('CH');
    expect(countryCode('FR')).toBe('FR');
    expect(countryCode(undefined)).toBe('XX');
    expect(countryCode(null)).toBe('XX');
    expect(countryCode('')).toBe('XX');
    expect(countryCode('FRA')).toBe('XX');
    expect(countryCode('T1')).toBe('XX');
    expect(countryCode(42)).toBe('XX');
  });

  it('jour UTC : une heure locale est ramenée en UTC', () => {
    expect(utcDay('2026-10-20T01:30:00+02:00')).toBe('2026-10-19');
    expect(utcDay(NOW)).toBe(DAY);
  });

  it('décalage de jours en calendrier UTC (passage de mois et d’année)', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDay(DAY, -RETENTION_DAYS)).toBe('2026-07-21');
  });

  it('clé d’un titre : type et référence, sans saison ni épisode', () => {
    expect(titleStartKey('series', 'tmdb:1399')).toBe('series|tmdb:1399');
    expect(titleStartKey('movie', 'imdb:tt0133093')).toBe('movie|imdb:tt0133093');
  });
});

describe('lancements : première progression du compte sur un titre', () => {
  it('première progression : n = 1, pays et clé du titre, colonnes sans donnée de compte', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    store.upsertProgress(progress({ profileId: alice }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'movie|tmdb:550', n: 1 }]);
    const columns = (db.prepare('PRAGMA table_info(title_starts)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toEqual(['day', 'country', 'key', 'n']);
  });

  it('même compte, même série, autres épisodes et autre saison : toujours n = 1', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    const series = { type: 'series' as const, tmdbId: 1399 };
    store.upsertProgress(progress({ profileId: alice, ...series, season: 1, episode: 1 }));
    store.upsertProgress(progress({ profileId: alice, ...series, season: 1, episode: 2, updatedAt: '2026-10-19T11:00:00.000Z' }));
    store.upsertProgress(progress({ profileId: alice, ...series, season: 2, episode: 1, updatedAt: '2026-10-19T12:00:00.000Z' }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'series|tmdb:1399', n: 1 }]);
  });

  it('deuxième compte sur le même titre : n = 2', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    const bob = account(store, 'bob');
    store.upsertProgress(progress({ profileId: alice }));
    store.upsertProgress(progress({ profileId: bob }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'movie|tmdb:550', n: 2 }]);
  });

  it('autre profil du même compte : pas de nouveau lancement, le compte ne compte qu’une fois', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice', ['p2']);
    store.upsertProgress(progress({ profileId: alice }));
    store.upsertProgress(progress({ profileId: 'alice-p2' }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'movie|tmdb:550', n: 1 }]);
  });

  it('un second pays pour le même compte et le même titre ne compte pas (ce n’est pas une première progression)', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    store.upsertProgress(progress({ profileId: alice, country: 'CH' }));
    store.upsertProgress(progress({ profileId: alice, country: 'FR' }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'movie|tmdb:550', n: 1 }]);
  });

  it('écriture sans pays (import Stremio) : aucun lancement compté, la progression reste enregistrée', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    store.importMany([], [progress({ profileId: alice, tmdbId: 603, country: undefined })]);
    store.upsertProgress({ ...progress({ profileId: alice, tmdbId: 604 }), country: undefined });
    expect(starts(db)).toEqual([]);
    expect(store.progressForTitle(alice, 'movie', 'tmdb:603')).toHaveLength(1);
  });

  it('pays inconnu : compté sous XX', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    store.upsertProgress(progress({ profileId: alice, country: countryCode(undefined) }));
    expect(starts(db)).toEqual([{ day: DAY, country: 'XX', key: 'movie|tmdb:550', n: 1 }]);
  });

  it('suppression du compte : l’agrégat reste (aucune clé étrangère)', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    store.upsertProgress(progress({ profileId: alice }));
    const { id } = db.prepare("SELECT id FROM accounts WHERE username = 'alice'").get() as { id: string };
    store.deleteAccount(id);
    expect(starts(db)).toEqual([{ day: DAY, country: 'CH', key: 'movie|tmdb:550', n: 1 }]);
  });
});

describe('topStarts : lecture anonymisée', () => {
  /**
   * Cinq comptes. movie:1 en CH : 4 comptes aujourd’hui. movie:2 en CH : 2 comptes hier et 1 aujourd’hui. movie:3 en CH :
   * 2 comptes (sous le seuil). movie:4 en FR : 5 comptes.
   */
  function seeded(): UserStore {
    const { store } = freshStore();
    const yesterday = shiftDay(DAY, -1);
    const [a1, a2, a3, a4, a5] = ['a1', 'a2', 'a3', 'a4', 'a5'].map((name) => account(store, name)) as [string, string, string, string, string];
    for (const profileId of [a1, a2, a3, a4]) store.upsertProgress(progress({ profileId, tmdbId: 1 }));
    store.upsertProgress(progress({ profileId: a1, tmdbId: 2, updatedAt: `${yesterday}T10:00:00.000Z` }));
    store.upsertProgress(progress({ profileId: a2, tmdbId: 2, updatedAt: `${yesterday}T11:00:00.000Z` }));
    store.upsertProgress(progress({ profileId: a3, tmdbId: 2 }));
    store.upsertProgress(progress({ profileId: a1, tmdbId: 3 }));
    store.upsertProgress(progress({ profileId: a2, tmdbId: 3 }));
    for (const profileId of [a1, a2, a3, a4, a5]) store.upsertProgress(progress({ profileId, tmdbId: 4, country: 'FR' }));
    return store;
  }

  it('seuil MIN_STARTS = 3, tri par nombre décroissant, cumul sur la fenêtre, pays filtré', () => {
    expect(MIN_STARTS).toBe(3);
    const store = seeded();
    expect(store.topStarts('CH', shiftDay(DAY, -1), 10)).toEqual([
      { key: 'movie|tmdb:1', n: 4 },
      { key: 'movie|tmdb:2', n: 3 },
    ]);
    expect(store.topStarts('FR', shiftDay(DAY, -1), 10)).toEqual([{ key: 'movie|tmdb:4', n: 5 }]);
  });

  it('fenêtre commençant aujourd’hui : seuls les lancements du jour comptent, le seuil s’applique', () => {
    expect(seeded().topStarts('CH', DAY, 10)).toEqual([{ key: 'movie|tmdb:1', n: 4 }]);
  });

  it('limite, pays en minuscules, pays sans titre au seuil', () => {
    const store = seeded();
    expect(store.topStarts('ch', shiftDay(DAY, -1), 1)).toEqual([{ key: 'movie|tmdb:1', n: 4 }]);
    expect(store.topStarts('DE', shiftDay(DAY, -30), 10)).toEqual([]);
  });
});

describe('rétention : lignes de plus de 90 jours supprimées, au plus une purge par jour', () => {
  it('à l’écriture d’un lancement : plus de 90 jours retirées, exactement 90 jours conservées', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    const insert = db.prepare('INSERT INTO title_starts (day, country, key, n) VALUES (?, ?, ?, ?)');
    insert.run(shiftDay(DAY, -91), 'CH', 'movie|tmdb:9', 5);
    insert.run(shiftDay(DAY, -90), 'CH', 'movie|tmdb:8', 5);
    insert.run(shiftDay(DAY, -10), 'CH', 'movie|tmdb:7', 5);
    store.upsertProgress(progress({ profileId: alice, tmdbId: 550 }));
    expect(starts(db).map((row) => row.key).sort()).toEqual(['movie|tmdb:550', 'movie|tmdb:7', 'movie|tmdb:8']);
    expect(starts(db).some((row) => row.key === 'movie|tmdb:9')).toBe(false);
  });

  it('au plus une purge par jour : une ligne ancienne ajoutée plus tard le même jour reste jusqu’au lendemain', () => {
    const { db, store } = freshStore();
    const alice = account(store, 'alice');
    const bob = account(store, 'bob');
    store.upsertProgress(progress({ profileId: alice, tmdbId: 550 }));
    db.prepare('INSERT INTO title_starts (day, country, key, n) VALUES (?, ?, ?, ?)').run(shiftDay(DAY, -120), 'CH', 'movie|tmdb:9', 1);
    store.upsertProgress(progress({ profileId: bob, tmdbId: 551 }));
    expect(starts(db).some((row) => row.key === 'movie|tmdb:9')).toBe(true);
  });
});

describe('route PUT /user/profiles/:id/progress : pays transmis par l’hôte', () => {
  it('pays de l’hôte en majuscules ; sans pays, XX ; un lancement par compte et par titre', async () => {
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-starts-'));
    const file = join(dir, 'laststream.db');
    const api = createApp({
      secret: SECRET,
      allowPlain: false,
      userDbPath: file,
      userRateLimits: DEFAULT_USER_RATE_LIMITS,
      thumbs: { ffmpeg: null },
    });
    const send = async (method: string, path: string, body: unknown, token?: string, country?: string): Promise<Response> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      // Le pays arrive par l'environnement de l'hôte (Workers : request.cf) ; absent sous Node.
      const env = country === undefined ? {} : { country };
      return api.fetch(new Request(`http://app.test${path}`, { method, headers, body: JSON.stringify(body) }), env);
    };
    try {
      for (const username of ['alice', 'bob']) {
        expect((await send('POST', '/user/register', { username, password: PASSWORD })).status).toBe(201);
      }
      const tokenOf = async (username: string): Promise<string> => {
        const res = await send('POST', '/user/login', { username, password: PASSWORD });
        return ((await res.json()) as { token: string }).token;
      };
      const aliceToken = await tokenOf('alice');
      const bobToken = await tokenOf('bob');
      const profileOf = async (token: string): Promise<string> =>
        ((await (await send('POST', '/user/profiles', { name: 'Greg' }, token)).json()) as { id: string }).id;
      const aliceProfile = await profileOf(aliceToken);
      const bobProfile = await profileOf(bobToken);

      const movie = { type: 'movie', tmdbId: 550, positionSec: 10, durationSec: 100 };
      const episode = { type: 'series', tmdbId: 1399, season: 1, episode: 1, positionSec: 10, durationSec: 100 };
      const put = (profile: string, token: string, body: unknown, country?: string) =>
        send('PUT', `/user/profiles/${profile}/progress`, body, token, country);

      expect((await put(aliceProfile, aliceToken, movie, 'ch')).status).toBe(200);
      expect((await put(aliceProfile, aliceToken, { ...movie, positionSec: 50 }, 'ch')).status).toBe(200);
      expect((await put(aliceProfile, aliceToken, episode, 'CH')).status).toBe(200);
      expect((await put(aliceProfile, aliceToken, { ...episode, episode: 2 }, 'CH')).status).toBe(200);
      expect((await put(bobProfile, bobToken, movie, 'CH')).status).toBe(200);
      expect((await put(bobProfile, bobToken, { ...movie, tmdbId: 603 })).status).toBe(200);
    } finally {
      closeApp(api);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT country, key, n FROM title_starts ORDER BY country, key').all();
      expect(rows).toEqual([
        { country: 'CH', key: 'movie|tmdb:550', n: 2 },
        { country: 'CH', key: 'series|tmdb:1399', n: 1 },
        { country: 'XX', key: 'movie|tmdb:603', n: 1 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
