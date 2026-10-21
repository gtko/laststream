// Repli IndexedDB des téléchargements (ODY-199) : jsdom n'a ni indexedDB ni IDBKeyRange, d'où le faux minimal ci-dessous.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdbBackend, openDownloadsDb } from '../../src/downloads/idbBackend';
import { SegmentedStore } from '../../src/downloads/segmented';
import { DownloadError } from '../../src/downloads/types';

const DB_NAME = 'laststream-downloads-data';

interface FakeOptions {
  /** L'ouverture signale une erreur (IndexedDB refusée). */
  failOpen?: boolean;
  /** L'ouverture est bloquée par une autre connexion. */
  blockOpen?: boolean;
  /** `indexedDB.open` lève une exception. */
  throwOpen?: boolean;
  /** Les lectures (get, getAllKeys) échouent : la transaction avorte. Modifiable pendant le test. */
  failRead?: boolean;
  /** Toute transaction contenant une écriture avorte à la validation avec cette erreur, sans effet. Modifiable pendant le test. */
  quotaError?: DOMException;
}

/** Intervalle de clés : bornes incluses, comparaison de chaînes (ordre des unités de code, comme IndexedDB). */
class FakeKeyRange {
  constructor(readonly lower: string, readonly upper: string) {}

  static bound(lower: string, upper: string): FakeKeyRange {
    return new FakeKeyRange(lower, upper);
  }

  includes(key: string): boolean {
    return key >= this.lower && key <= this.upper;
  }
}

type Op = { kind: 'put'; key: string; value: unknown } | { kind: 'delete'; target: string | FakeKeyRange };

interface FakeRequest<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * IndexedDB minimale : une base, des stores sans keyPath, requêtes asynchrones (microtâches), validation des transactions
 * par une tâche différée. Une écriture ne prend effet qu'à la validation : une transaction avortée ne laisse rien en base.
 * Les valeurs sont clonées au `put`, comme en IndexedDB.
 */
function fakeIndexedDb(opts: FakeOptions = {}) {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const openCalls: Array<{ name: string; version: number }> = [];
  let version = 0;

  const matchingKeys = (range?: FakeKeyRange): string[] =>
    [...data.keys()].filter((key) => range === undefined || range.includes(key)).sort();

  const newTransaction = () => {
    const ops: Op[] = [];
    let settled = false;

    const abortWith = (error: unknown, notifyError: boolean): void => {
      if (settled) return;
      settled = true;
      tx.error = error;
      if (notifyError) tx.onerror?.();
      tx.onabort?.();
    };

    const commit = (): void => {
      if (settled) return;
      if (opts.quotaError && ops.some((op) => op.kind === 'put')) {
        abortWith(opts.quotaError, true);
        return;
      }
      settled = true;
      for (const op of ops) {
        if (op.kind === 'put') data.set(op.key, op.value);
        else if (op.target instanceof FakeKeyRange) for (const key of matchingKeys(op.target)) data.delete(key);
        else data.delete(op.target);
      }
      tx.oncomplete?.();
    };

    /** Requête : le résultat arrive en microtâche, comme un événement IndexedDB. */
    const request = <T>(run: () => T, isRead: boolean): FakeRequest<T> => {
      const req: FakeRequest<T> = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (settled) return;
        if (isRead && opts.failRead) {
          req.error = new DOMException('Lecture refusée', 'UnknownError');
          req.onerror?.();
          abortWith(req.error, true);
          return;
        }
        req.result = run();
        req.onsuccess?.();
      });
      return req;
    };

    const store = {
      getAllKeys: (range?: FakeKeyRange) => request(() => matchingKeys(range), true),
      get: (key: string) => request(() => structuredClone(data.get(key)), true),
      put: (value: unknown, key: string) => {
        // Clonage au put : modifier ensuite le tampon d'origine ne change pas ce qui est stocké.
        const copy = structuredClone(value);
        return request(() => {
          ops.push({ kind: 'put', key, value: copy });
          return key;
        }, false);
      },
      delete: (target: string | FakeKeyRange) =>
        request(() => {
          ops.push({ kind: 'delete', target });
          return undefined;
        }, false),
    };

    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore: () => store,
      abort: () => abortWith(new DOMException('Transaction annulée', 'AbortError'), false),
    };
    // Validation après les requêtes (microtâches) : une tâche différée, comme l'auto-validation d'IndexedDB.
    setTimeout(commit, 0);
    return tx;
  };

  /** Une connexion ouverte sur la base (chaque ouverture en donne une nouvelle). */
  const connection = () => {
    let closed = false;
    return {
      onversionchange: null as (() => void) | null,
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string): void => {
        stores.add(name);
      },
      close: (): void => {
        closed = true;
      },
      transaction: (name: string) => {
        if (closed) throw new DOMException('Base fermée', 'InvalidStateError');
        if (!stores.has(name)) throw new DOMException(`Store absent : ${name}`, 'NotFoundError');
        return newTransaction();
      },
    };
  };

  const factory = {
    open: (name: string, requested: number) => {
      openCalls.push({ name, version: requested });
      if (opts.throwOpen) throw new Error('accès refusé');
      const req: FakeRequest<ReturnType<typeof connection>> & {
        onupgradeneeded: (() => void) | null;
        onblocked: (() => void) | null;
      } = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        if (opts.failOpen) {
          req.error = new DOMException('Ouverture refusée', 'UnknownError');
          req.onerror?.();
          return;
        }
        if (opts.blockOpen) {
          req.onblocked?.();
          return;
        }
        req.result = connection();
        if (requested > version) {
          req.onupgradeneeded?.();
          version = requested;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };

  return { factory, data, stores, openCalls, opts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'indexedDB');
});

/** Octets d'une suite d'entiers. */
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** Contenu d'un Blob, octet par octet. */
function content(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Installe la fausse IndexedDB et ouvre une connexion comme le fait l'application. */
async function openBackend(): Promise<IdbBackend> {
  const db = await openDownloadsDb();
  if (db === null) throw new Error('base non ouverte');
  return new IdbBackend(db);
}

async function setup(opts: FakeOptions = {}) {
  const idb = fakeIndexedDb(opts);
  vi.stubGlobal('indexedDB', idb.factory);
  vi.stubGlobal('IDBKeyRange', FakeKeyRange);
  return { idb, backend: await openBackend() };
}

/** Contenu du fichier d'un magasin, ou null s'il est vide. */
async function fileContent(store: SegmentedStore, id: string): Promise<number[] | null> {
  const blob = await store.file(id);
  return blob === null ? null : content(blob);
}

describe('openDownloadsDb', () => {
  it('sans fabrique IndexedDB : null, sans exception', async () => {
    await expect(openDownloadsDb(undefined)).resolves.toBeNull();
  });

  it('ouverture refusée : null', async () => {
    const idb = fakeIndexedDb({ failOpen: true });
    vi.stubGlobal('indexedDB', idb.factory);
    await expect(openDownloadsDb()).resolves.toBeNull();
  });

  it('ouverture bloquée par une autre connexion : null', async () => {
    const idb = fakeIndexedDb({ blockOpen: true });
    vi.stubGlobal('indexedDB', idb.factory);
    await expect(openDownloadsDb()).resolves.toBeNull();
  });

  it('accès à la fabrique qui lève une exception : null', async () => {
    const idb = fakeIndexedDb({ throwOpen: true });
    vi.stubGlobal('indexedDB', idb.factory);
    await expect(openDownloadsDb()).resolves.toBeNull();
  });

  it('base créée en version 1 avec le store segments', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const db = await openDownloadsDb();

    expect(db).not.toBeNull();
    expect(idb.openCalls).toEqual([{ name: DB_NAME, version: 1 }]);
    expect(idb.stores.has('segments')).toBe(true);
    expect(db?.objectStoreNames.contains('segments')).toBe(true);
  });
});

describe('IdbBackend', () => {
  it('écrit puis liste (triée, longueurs exactes) puis relit le contenu exact', async () => {
    const { backend } = await setup();
    await backend.write('tt1', 10, bytes(7, 8, 9));
    await backend.write('tt1', 0, bytes(1, 2, 3, 4));

    expect(await backend.list('tt1')).toEqual([
      { start: 0, length: 4 },
      { start: 10, length: 3 },
    ]);
    expect(await content(await backend.read('tt1', { start: 0, length: 4 }))).toEqual([1, 2, 3, 4]);
    expect(await content(await backend.read('tt1', { start: 10, length: 3 }))).toEqual([7, 8, 9]);
  });

  it('write d\'une vue sur un grand tampon : stocke exactement les octets de la vue', async () => {
    const { idb, backend } = await setup();
    const big = new Uint8Array([9, 9, 1, 2, 3, 9, 9, 9]);
    await backend.write('tt1', 0, new Uint8Array(big.buffer, 2, 3));

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 3 }]);
    expect(await content(await backend.read('tt1', { start: 0, length: 3 }))).toEqual([1, 2, 3]);
    expect([...idb.data.values()].map((v) => (v as ArrayBuffer).byteLength)).toEqual([3]);
  });

  it('réécriture au même start avec une autre longueur : l\'ancien segment est remplacé', async () => {
    const { backend } = await setup();
    await backend.write('tt1', 0, bytes(1, 2, 3, 4));
    await backend.write('tt1', 0, bytes(7, 8));

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 2 }]);
    expect(await content(await backend.read('tt1', { start: 0, length: 2 }))).toEqual([7, 8]);
    expect(await backend.usage()).toBe(2);
  });

  it('deux ids dont l\'un est préfixe de l\'autre (tt1, tt1:1:2) ne se mélangent pas dans list ni remove', async () => {
    const { backend } = await setup();
    await backend.write('tt1', 0, bytes(1));
    await backend.write('tt1:1:2', 0, bytes(2, 2));
    await backend.write('tt1:1:2', 2, bytes(3));

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 1 }]);
    expect(await backend.list('tt1:1:2')).toEqual([
      { start: 0, length: 2 },
      { start: 2, length: 1 },
    ]);

    await backend.remove('tt1');
    expect(await backend.list('tt1')).toEqual([]);
    expect(await backend.list('tt1:1:2')).toHaveLength(2);

    await backend.write('tt1', 0, bytes(5));
    await backend.remove('tt1:1:2');
    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 1 }]);
    expect(await backend.list('tt1:1:2')).toEqual([]);
  });

  it('remove(id) supprime tous les segments de cet id seulement', async () => {
    const { idb, backend } = await setup();
    await backend.write('tt1', 0, bytes(1));
    await backend.write('tt1', 2, bytes(2));
    await backend.write('tt1', 4, bytes(3));
    await backend.write('tt2', 0, bytes(4));

    await backend.remove('tt1');

    expect(await backend.list('tt1')).toEqual([]);
    expect(await backend.list('tt2')).toEqual([{ start: 0, length: 1 }]);
    expect(idb.data.size).toBe(1);
  });

  it('remove(id, starts) supprime sélectivement les segments listés', async () => {
    const { backend } = await setup();
    await backend.write('tt1', 0, bytes(1));
    await backend.write('tt1', 2, bytes(2));
    await backend.write('tt1', 4, bytes(3));

    await backend.remove('tt1', [2]);
    expect(await backend.list('tt1')).toEqual([
      { start: 0, length: 1 },
      { start: 4, length: 1 },
    ]);

    await backend.remove('tt1', []);
    expect(await backend.list('tt1')).toHaveLength(2);
  });

  it('usage() : somme de toutes les longueurs, tous ids confondus', async () => {
    const { backend } = await setup();
    await backend.write('tt1', 0, bytes(1, 2, 3));
    await backend.write('tt1:1:2', 0, bytes(1, 2, 3, 4, 5));
    await backend.write('tt2', 0, bytes(1, 2));
    expect(await backend.usage()).toBe(10);

    await backend.remove('tt1');
    expect(await backend.usage()).toBe(7);
  });

  it('quota dépassé à l\'écriture : rejet avec l\'erreur d\'origine, base inchangée', async () => {
    const { idb, backend } = await setup();
    await backend.write('tt1', 0, bytes(1, 2, 3));

    const quota = new DOMException('Quota dépassé', 'QuotaExceededError');
    idb.opts.quotaError = quota;
    // Réécriture au même start : la suppression de l'ancien segment doit être annulée avec l'écriture.
    await expect(backend.write('tt1', 0, bytes(9, 9))).rejects.toBe(quota);
    await expect(backend.write('tt1', 3, bytes(9))).rejects.toMatchObject({ name: 'QuotaExceededError' });

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 3 }]);
    expect(await content(await backend.read('tt1', { start: 0, length: 3 }))).toEqual([1, 2, 3]);
    expect(await backend.usage()).toBe(3);
  });

  it('ids avec caractères spéciaux (espace, accents, deux-points) restent séparés', async () => {
    const { backend } = await setup();
    const special = 'Été 2:1 & co';
    const plain = 'Été 2';
    await backend.write(special, 0, bytes(1, 2));
    await backend.write(plain, 0, bytes(3));
    await backend.write(special, 2, bytes(4));

    expect(await backend.list(special)).toEqual([
      { start: 0, length: 2 },
      { start: 2, length: 1 },
    ]);
    expect(await backend.list(plain)).toEqual([{ start: 0, length: 1 }]);
    expect(await content(await backend.read(special, { start: 0, length: 2 }))).toEqual([1, 2]);

    await backend.remove(plain);
    expect(await backend.list(special)).toHaveLength(2);
    expect(await backend.usage()).toBe(3);
  });

  it('lecture en échec : list rejette l\'erreur, sans liste partielle', async () => {
    const { idb, backend } = await setup();
    await backend.write('tt1', 0, bytes(1));

    idb.opts.failRead = true;
    await expect(backend.list('tt1')).rejects.toMatchObject({ name: 'UnknownError' });
  });
});

describe('SegmentedStore sur IdbBackend (IndexedDB simulée)', () => {
  it('trois morceaux, puis nouvelle instance sur la même base : taille et fichier repris, quota = store_full sans changement', async () => {
    const { idb, backend } = await setup();
    const first = new SegmentedStore(backend);
    const sink = await first.open('tt1');
    await sink.write(0, bytes(1, 2, 3));
    await sink.write(3, bytes(4, 5));
    await sink.write(5, bytes(6, 7, 8, 9));
    expect(await sink.size()).toBe(9);

    const second = new SegmentedStore(await openBackend());
    expect(await second.size('tt1')).toBe(9);
    expect(await fileContent(second, 'tt1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    idb.opts.quotaError = new DOMException('Quota dépassé', 'QuotaExceededError');
    const resumed = await second.open('tt1');
    await expect(resumed.write(9, bytes(10))).rejects.toMatchObject({ name: 'DownloadError', code: 'store_full' });
    await expect(resumed.write(9, bytes(10))).rejects.toBeInstanceOf(DownloadError);

    expect(await resumed.size()).toBe(9);
    expect(await second.size('tt1')).toBe(9);
    expect(await fileContent(second, 'tt1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
