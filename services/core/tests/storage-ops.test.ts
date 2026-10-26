import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { countedEnv, countedKv, countedR2, storageOpsLine, withStorageOps } from '../src/platform/workers/storage-ops.js';

/** LAST-138 : compteur d'opérations KV / R2 par requête, journal JSON `storage_ops`. */

function fakeKv() {
  return {
    get: async (key: string) => (key === 'present' ? 'v' : null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

function fakeR2() {
  return {
    get: async () => null,
    head: async () => null,
    put: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  } as unknown as R2Bucket;
}

async function run<T>(route: string, work: () => Promise<T>): Promise<{ value: T; lines: unknown[] }> {
  const lines: unknown[] = [];
  const value = await withStorageOps(route, work, (line) => lines.push(JSON.parse(line)));
  return { value, lines };
}

describe('storage_ops : comptage par requête', () => {
  it('compte get/put/delete/list KV et get/put/head/delete/list R2, en une seule ligne', async () => {
    const kv = countedKv(fakeKv());
    const r2 = countedR2(fakeR2());
    const { value, lines } = await run('/:config/catalog/movie/:id', async () => {
      await kv.get('a');
      await kv.get('b');
      await kv.get('c');
      await kv.getWithMetadata('d');
      await kv.put('a', 'x', { expirationTtl: 60 });
      await kv.delete('a');
      await kv.list();
      await r2.get('k');
      await r2.head('k');
      await r2.put('k', 'x');
      await r2.delete('k');
      await r2.list();
      return await kv.get('present');
    });
    expect(value).toBe('v');
    expect(lines).toEqual([
      { msg: 'storage_ops', route: '/:config/catalog/movie/:id', kv: { get: 5, put: 1, delete: 1, list: 1 }, r2: { get: 1, head: 1, put: 1, delete: 1, list: 1 } },
    ]);
  });

  it('les requêtes simultanées ont chacune leur compteur (aucun état partagé)', async () => {
    const kv = countedKv(fakeKv());
    const [a, b] = await Promise.all([
      run('/a', async () => {
        await kv.get('1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        await kv.get('2');
      }),
      run('/b', async () => {
        await kv.get('1');
      }),
    ]);
    expect(a.lines).toEqual([{ msg: 'storage_ops', route: '/a', kv: { get: 2 }, r2: {} }]);
    expect(b.lines).toEqual([{ msg: 'storage_ops', route: '/b', kv: { get: 1 }, r2: {} }]);
  });

  it('hors requête : rien n’est compté, et une requête sans opération n’écrit aucune ligne', async () => {
    const kv = countedKv(fakeKv());
    await kv.get('hors-requete');
    const { lines } = await run('/vide', async () => undefined);
    expect(lines).toEqual([]);
    const next = await run('/suivante', async () => kv.get('x'));
    expect(next.lines).toEqual([{ msg: 'storage_ops', route: '/suivante', kv: { get: 1 }, r2: {} }]);
  });

  it('la ligne est écrite aussi quand la requête échoue, et l’erreur est propagée', async () => {
    const kv = countedKv(fakeKv());
    const lines: string[] = [];
    await expect(
      withStorageOps(
        '/erreur',
        async () => {
          await kv.get('x');
          throw new Error('boom');
        },
        (line) => lines.push(line),
      ),
    ).rejects.toThrow('boom');
    expect(lines).toHaveLength(1);
  });

  it('la ligne ne contient ni clé ni valeur : seulement la route et des nombres', async () => {
    const kv = countedKv(fakeKv());
    const lines: string[] = [];
    await withStorageOps('/:config/stream/:type/:id', async () => kv.get('cle-secrete-utilisateur'), (line) => lines.push(line));
    expect(lines[0]).not.toContain('secrete');
    expect(storageOpsLine('/x', { kv: {}, r2: {} })).toBeUndefined();
  });

  it('countedEnv enveloppe CACHE, TV, META et AVATARS ; le reste est repris tel quel ; résultat stable', async () => {
    const env = { CACHE: fakeKv(), TV: fakeR2(), META: fakeR2(), AVATARS: fakeR2(), LASTADDON_SECRET: 's' } as unknown as WorkerEnv;
    const copy = countedEnv(env);
    expect(countedEnv(env)).toBe(copy);
    expect(copy.LASTADDON_SECRET).toBe('s');
    const { lines } = await run('/env', async () => {
      await copy.CACHE.get('a');
      await copy.TV?.get('a');
      await copy.META?.put('a', 'x');
      await copy.AVATARS?.get('a');
    });
    expect(lines).toEqual([{ msg: 'storage_ops', route: '/env', kv: { get: 1 }, r2: { get: 2, put: 1 } }]);
  });
});
