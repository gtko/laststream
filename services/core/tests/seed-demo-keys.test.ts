import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeConfig, encodeConfig } from '../src/config/codec.js';
import { openUserDb } from '../src/platform/node/user-db.js';
import { hashSecret } from '../src/user/crypto.js';
import { UserStore } from '../src/user/store.js';
import {
  applyDemoKeys,
  assertLocalDbTarget,
  DEMO_KEYS_MAP_PATH,
  DemoKeysError,
  describeDemoKeys,
  loadDemoKeyMap,
  localServerOrigin,
  prepareDemoKeys,
  runDemoServiceTest,
  SECRET_SERVICE_FIELDS,
} from '../scripts/seed-demo-keys.js';

// Valeurs factices uniquement : aucune clé réelle n'entre dans ces tests. Chaque « clé » commence par « fake- ».
const SECRET = 'fake-secret-for-tests-only-0123456789abcdef';
const SERVER = 'http://127.0.0.1:7000';
const tmpRoot = mkdtempSync(join(tmpdir(), 'seed-demo-keys-test-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Fausse commande op : chaque référence renvoie « fake-<CHAMP> » suivi d'un saut de ligne, comme op read. */
function fakeOp(calls: string[] = []): (reference: string) => Promise<string> {
  return async (reference) => {
    calls.push(reference);
    return `fake-${reference.slice(reference.lastIndexOf('/') + 1)}\n`;
  };
}

/** Fausse commande op où un champ est absent de l'item. */
function opWithout(field: string): (reference: string) => Promise<string> {
  const op = fakeOp();
  return async (reference) => {
    if (reference.endsWith(`/${field}`)) throw new Error(`fake-leak : champ ${field} introuvable`);
    return op(reference);
  };
}

function prepareOptions(overrides: Partial<Parameters<typeof prepareDemoKeys>[0]> = {}): Parameters<typeof prepareDemoKeys>[0] {
  return { mapPath: DEMO_KEYS_MAP_PATH, vault: undefined, serverUrl: SERVER, secret: SECRET, runOp: fakeOp(), ...overrides };
}

function writeMap(name: string, content: unknown): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

async function accountFixture(): Promise<{ db: ReturnType<typeof openUserDb>; users: UserStore; accountId: string }> {
  const db = openUserDb(':memory:');
  const users = new UserStore(db);
  const created = users.createAccount({
    username: 'demo',
    passwordHash: await hashSecret('fake-password'),
    allowSignup: true,
    now: new Date().toISOString(),
  });
  if (!created.ok) throw new Error('fixture : création de compte refusée');
  return { db, users, accountId: created.account.id };
}

describe('localServerOrigin', () => {
  it('accepte localhost, 127.0.0.1 et [::1]', () => {
    expect(localServerOrigin('http://127.0.0.1:7000')).toBe('http://127.0.0.1:7000');
    expect(localServerOrigin('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(localServerOrigin('http://[::1]:7000')).toBe('http://[::1]:7000');
  });

  it('refuse production, *.workers.dev, les faux locaux et les identifiants dans l’URL, sans reprendre l’URL', () => {
    const refused = [
      'https://lastaddon.workers.dev',
      'https://addon.example.com',
      'http://127.0.0.1.nip.io:7000',
      'http://user:pw@127.0.0.1:7000',
      'ftp://127.0.0.1:21',
      'pas une url',
    ];
    for (const raw of refused) {
      let message = '';
      try {
        localServerOrigin(raw);
      } catch (error) {
        expect(error).toBeInstanceOf(DemoKeysError);
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('workers.dev');
      expect(message).not.toContain('user:pw');
      expect(message).not.toContain('example.com');
    }
  });
});

describe('assertLocalDbTarget', () => {
  it('accepte une base dans LASTADDON_DATA_DIR, et dans data/ par défaut', () => {
    const dataDir = join(tmpRoot, 'data-local');
    expect(() => assertLocalDbTarget(join(dataDir, 'laststream.db'), dataDir, tmpRoot)).not.toThrow();
    expect(() => assertLocalDbTarget(join(tmpRoot, 'data', 'laststream.db'), undefined, tmpRoot)).not.toThrow();
  });

  it('refuse une base hors de LASTADDON_DATA_DIR, les remontées, le dossier lui-même et les URL', () => {
    const dataDir = join(tmpRoot, 'data-local');
    expect(() => assertLocalDbTarget(join(tmpRoot, 'autre', 'laststream.db'), dataDir, tmpRoot)).toThrow(DemoKeysError);
    expect(() => assertLocalDbTarget(join(dataDir, '..', 'laststream.db'), dataDir, tmpRoot)).toThrow(DemoKeysError);
    expect(() => assertLocalDbTarget(dataDir, dataDir, tmpRoot)).toThrow(DemoKeysError);
    expect(() => assertLocalDbTarget(':memory:', dataDir, tmpRoot)).toThrow(DemoKeysError);
    expect(() => assertLocalDbTarget('libsql://base.example.com/laststream.db', dataDir, tmpRoot)).toThrow(DemoKeysError);
  });
});

describe('loadDemoKeyMap', () => {
  it('la correspondance versionnée couvre exactement les services secrets, uniquement par références', () => {
    const refs = loadDemoKeyMap(DEMO_KEYS_MAP_PATH);
    expect(Object.keys(refs).sort()).toEqual([...SECRET_SERVICE_FIELDS].sort());
    for (const ref of Object.values(refs)) expect(ref).toMatch(/^op:\/\/[^/]+\/[^/]+\/[^/]+$/);
    expect(JSON.stringify(refs).toLowerCase()).not.toContain('debrid');
  });

  it('refuse AllDebrid, les clés inconnues, une valeur à la place d’une référence et les champs en trop', () => {
    const debrid = writeMap('debrid.json', { refs: { 'debrid.apiKey': 'op://Private/Stremio API/ALLDEBRID' } });
    expect(() => loadDemoKeyMap(debrid)).toThrow(/AllDebrid exclu/);

    const unknown = writeMap('unknown.json', { refs: { notAService: 'op://Private/Stremio API/X' } });
    expect(() => loadDemoKeyMap(unknown)).toThrow(/refusée/);

    const value = writeMap('value.json', { refs: { tmdbToken: 'fake-value-in-map' } });
    let message = '';
    try {
      loadDemoKeyMap(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('invalide');
    expect(message).not.toContain('fake-value-in-map');

    const extra = writeMap('extra.json', { refs: {}, extra: true });
    expect(() => loadDemoKeyMap(extra)).toThrow(/invalide/);
  });
});

describe('prepareDemoKeys', () => {
  it('lit chaque clé via op, ignore un champ absent et ne laisse aucune valeur dans les sorties', async () => {
    const plan = await prepareDemoKeys(prepareOptions({ runOp: opWithout('FANART_API_KEY') }));
    expect(plan.services.tmdbToken).toBe('fake-TMDB_TOKEN');
    expect(plan.configured).toContain('tmdbToken');
    expect(plan.configured).not.toContain('fanartApiKey');
    expect(plan.ignored).toEqual([expect.objectContaining({ service: 'fanartApiKey', field: 'FANART_API_KEY' })]);
    expect(plan.serverOrigin).toBe(SERVER);
    // Le message d'erreur de op (qui contient « fake-leak ») n'est jamais repris.
    expect(JSON.stringify(plan.ignored)).not.toContain('fake-leak');
    expect(describeDemoKeys(plan, { status: 'skipped', reason: 'serveur local injoignable' }).join('\n')).not.toContain('fake-');
  });

  it('utilise le coffre de LASTADDON_OP_VAULT et refuse un nom de coffre contenant « / »', async () => {
    const calls: string[] = [];
    await prepareDemoKeys(prepareOptions({ vault: 'Coffre Test', runOp: fakeOp(calls) }));
    expect(calls.length).toBe(SECRET_SERVICE_FIELDS.length);
    expect(calls.every((ref) => ref.startsWith('op://Coffre Test/Stremio API/'))).toBe(true);

    await expect(prepareDemoKeys(prepareOptions({ vault: 'a/b' }))).rejects.toThrow(DemoKeysError);
  });

  it('refuse un serveur non local, et un secret absent, avant toute lecture 1Password', async () => {
    const calls: string[] = [];
    await expect(
      prepareDemoKeys(prepareOptions({ serverUrl: 'https://lastaddon.workers.dev', runOp: fakeOp(calls) })),
    ).rejects.toThrow(DemoKeysError);
    await expect(prepareDemoKeys(prepareOptions({ secret: undefined, runOp: fakeOp(calls) }))).rejects.toThrow(/LASTADDON_SECRET absent/);
    expect(calls).toHaveLength(0);
  });

  it('signale une CLI op absente, et refuse quand aucune valeur n’est lue', async () => {
    const missingBinary = async () => {
      throw Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    };
    await expect(prepareDemoKeys(prepareOptions({ runOp: missingBinary }))).rejects.toThrow(/introuvable/);

    const denied = async () => {
      throw new Error('fake-leak : non connecté');
    };
    let message = '';
    try {
      await prepareDemoKeys(prepareOptions({ runOp: denied }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('aucune clé lue');
    expect(message).not.toContain('fake-leak');
  });

  it('ignore une valeur vide renvoyée par op', async () => {
    const emptyTmdb = async (reference: string) => (reference.endsWith('/TMDB_TOKEN') ? '\n' : fakeOp()(reference));
    const plan = await prepareDemoKeys(prepareOptions({ runOp: emptyTmdb }));
    expect(plan.configured).not.toContain('tmdbToken');
    expect(plan.ignored).toEqual([expect.objectContaining({ service: 'tmdbToken', reason: 'vide ou invalide' })]);
  });
});

describe('applyDemoKeys', () => {
  it('enregistre la configuration chiffrée sans valeur en clair, et les clés se relisent avec le secret', async () => {
    const fixture = await accountFixture();
    try {
      const plan = await prepareDemoKeys(prepareOptions({ runOp: opWithout('FANART_API_KEY') }));
      const { encoded, warnings } = applyDemoKeys(fixture.users, fixture.accountId, plan);
      expect(fixture.users.getAccountConfig(fixture.accountId)).toBe(encoded);
      expect(encoded).not.toContain('fake-');
      const config = decodeConfig(encoded, SECRET, { allowPlain: false });
      expect(config.services.tmdbToken).toBe('fake-TMDB_TOKEN');
      expect(config.services.fanartApiKey).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });

  it('conserve les réglages, retire AllDebrid et supprime les clés absentes de 1Password', async () => {
    const fixture = await accountFixture();
    try {
      const previous = encodeConfig(
        {
          maxResults: 42,
          services: { fanartApiKey: 'fake-stale-fanart-key', tmdbToken: 'fake-old-tmdb-token' },
          debrid: { service: 'alldebrid', apiKey: 'fake-alldebrid-key' },
        },
        SECRET,
      );
      fixture.users.setAccountConfig(fixture.accountId, previous);
      const plan = await prepareDemoKeys(prepareOptions({ runOp: opWithout('FANART_API_KEY') }));
      const { encoded, warnings } = applyDemoKeys(fixture.users, fixture.accountId, plan);
      const config = decodeConfig(encoded, SECRET, { allowPlain: false });
      expect(config.maxResults).toBe(42);
      expect(config.debrid).toBeUndefined();
      expect(config.services.fanartApiKey).toBeUndefined();
      expect(config.services.tmdbToken).toBe('fake-TMDB_TOKEN');
      expect(warnings.join(' ')).toContain('AllDebrid');
      expect(warnings.join(' ')).not.toContain('fake-');
      expect(encoded).not.toContain('fake-alldebrid');
    } finally {
      fixture.db.close();
    }
  });

  it('remplace une configuration existante illisible, avec un avertissement', async () => {
    const fixture = await accountFixture();
    try {
      fixture.users.setAccountConfig(fixture.accountId, 'abcdef');
      const plan = await prepareDemoKeys(prepareOptions());
      const { encoded, warnings } = applyDemoKeys(fixture.users, fixture.accountId, plan);
      expect(decodeConfig(encoded, SECRET, { allowPlain: false }).services.tmdbToken).toBe('fake-TMDB_TOKEN');
      expect(warnings.join(' ')).toContain('illisible');
    } finally {
      fixture.db.close();
    }
  });
});

describe('runDemoServiceTest', () => {
  it('ne retient que les noms et l’état OK, et n’envoie que la configuration chiffrée', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const redirects: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(String(init?.body));
      redirects.push(init?.redirect);
      const payload = {
        sources: [],
        services: [
          { name: 'TMDB', ok: true, error: 'fake-error-text' },
          { name: 'Fanart.tv', ok: false, error: 'fake-error-text' },
        ],
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await runDemoServiceTest(SERVER, 'encoded-config-string', fetchImpl);
    expect(result).toEqual({
      status: 'done',
      lines: [
        { name: 'TMDB', ok: true },
        { name: 'Fanart.tv', ok: false },
      ],
    });
    expect(urls).toEqual([`${SERVER}/config/test`]);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ config: 'encoded-config-string' });
    // Une redirection ne doit jamais être suivie : la configuration chiffrée ne doit pas partir vers un autre hôte.
    expect(redirects).toEqual(['error']);
    expect(JSON.stringify(result)).not.toContain('fake-error-text');
  });

  it('refuse de suivre une redirection : l’erreur est signalée sans reprendre la réponse', async () => {
    const redirected = (async () => {
      throw new TypeError('fetch failed : redirect mode is set to error');
    }) as unknown as typeof fetch;
    const result = await runDemoServiceTest(SERVER, 'x', redirected);
    expect(result.status).toBe('skipped');
    expect(JSON.stringify(result)).toContain('redirection refusée');
    expect(JSON.stringify(result)).not.toContain('fetch failed');
  });

  it('signale un serveur injoignable ou une réponse HTTP en erreur, sans reprendre le corps', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await runDemoServiceTest(SERVER, 'x', down)).status).toBe('skipped');

    const broken = (async () => new Response('fake-body-leak', { status: 500 })) as unknown as typeof fetch;
    expect(await runDemoServiceTest(SERVER, 'x', broken)).toEqual({ status: 'failed', reason: 'réponse HTTP 500' });
  });
});

describe('describeDemoKeys', () => {
  it('ne décrit que des noms de services, de champs et des états', async () => {
    const plan = await prepareDemoKeys(prepareOptions({ runOp: opWithout('FANART_API_KEY') }));
    const text = describeDemoKeys(plan, {
      status: 'done',
      lines: [
        { name: 'TMDB', ok: true },
        { name: 'Fanart', ok: false },
      ],
    }).join('\n');
    expect(text).toContain('tmdbToken');
    expect(text).toContain('FANART_API_KEY');
    expect(text).toContain('TMDB : OK');
    expect(text).toContain('Fanart : échec');
    expect(text).not.toContain('fake-');
  });
});
