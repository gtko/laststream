// Index persisté des téléchargements : mémoire, IndexedDB simulée (jsdom n'en a pas), repli sans exception.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdbDownloadIndex, MemoryDownloadIndex, createDownloadIndex } from '../../src/downloads/index';
import type { DownloadItem } from '../../src/downloads/types';

function item(id = 'tt1', overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id,
    metaId: 'tt1',
    title: 'Film',
    source: { copies: [{ infoHash: 'b'.repeat(40) }] },
    state: 'pending',
    bytesDone: 0,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Laisse passer les microtâches et les requêtes simulées. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Kind = 'put' | 'delete' | 'getAll';

interface FakeOptions {
  /** L'ouverture signale une erreur (IndexedDB refusée). */
  failOpen?: boolean;
  /** L'accès à `indexedDB.open` lève une exception. */
  throwOpen?: boolean;
  /** Requête qui échoue : la transaction avorte. Modifiable pendant le test. */
  failOn?: Kind;
  /** Écriture dont la transaction avorte à la validation (ex. QuotaExceededError), sans effet. Modifiable pendant le test. */
  abortOn?: 'put' | 'delete';
  /** Retient la validation (oncomplete) des transactions jusqu'à `releaseCommits()`. Modifiable pendant le test. */
  holdCommit?: boolean;
}

/**
 * IndexedDB minimale (open, transaction, objectStore, getAll, put et delete avec keyPath `id`), réponses asynchrones.
 * Une écriture ne prend effet qu'à la validation : une transaction avortée ne laisse rien en base.
 */
function fakeIndexedDb(opts: FakeOptions = {}) {
  const data = new Map<string, DownloadItem>();
  const openCalls = { count: 0 };
  const state = { closed: false };
  const held: Array<() => void> = [];

  const newTransaction = () => {
    let aborted = false;
    const writes: Array<{ kind: 'put' | 'delete'; apply: () => void }> = [];
    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore: () => store,
    };
    const abort = (error: unknown) => {
      if (aborted) return;
      aborted = true;
      tx.error = error;
      tx.onerror?.();
      tx.onabort?.();
    };
    const commit = () => {
      if (aborted) return;
      if (opts.abortOn && writes.some((w) => w.kind === opts.abortOn)) {
        abort(Object.assign(new Error('quota dépassé'), { name: 'QuotaExceededError' }));
        return;
      }
      for (const w of writes) w.apply();
      tx.oncomplete?.();
    };
    /** Requête simulée : succès ou échec (qui avorte la transaction) arrive en microtâche. */
    const request = <T>(kind: Kind, run: () => T) => {
      const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (opts.failOn === kind) {
          r.error = new Error('échec simulé');
          r.onerror?.();
          abort(r.error);
          return;
        }
        r.result = run();
        r.onsuccess?.();
        if (kind !== 'getAll') {
          // La validation vient après la requête, comme dans IndexedDB : oncomplete n'arrive jamais avant onsuccess.
          if (opts.holdCommit) held.push(commit);
          else queueMicrotask(commit);
        }
      });
      return r;
    };
    const store = {
      getAll: () => request('getAll', () => [...data.values()].map((v) => structuredClone(v))),
      put: (v: DownloadItem) =>
        request('put', () => {
          writes.push({ kind: 'put', apply: () => data.set(v.id, structuredClone(v)) });
          return v.id;
        }),
      delete: (k: string) =>
        request('delete', () => {
          writes.push({ kind: 'delete', apply: () => { data.delete(k); } });
          return undefined;
        }),
    };
    return tx;
  };

  const db = {
    onversionchange: null as (() => void) | null,
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => { state.closed = true; },
    transaction: () => {
      if (state.closed) throw new Error('base fermée');
      return newTransaction();
    },
  };

  const factory = {
    open: () => {
      openCalls.count += 1;
      if (opts.throwOpen) throw new Error('accès refusé');
      const r: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (opts.failOpen) {
          r.onerror?.();
          return;
        }
        state.closed = false;
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };

  return {
    factory,
    data,
    openCalls,
    opts,
    state,
    /** Une autre fenêtre demande une version plus récente de la base. */
    versionChange: () => db.onversionchange?.(),
    /** Valide les transactions retenues (`holdCommit`). */
    releaseCommits: () => {
      for (const commit of held.splice(0)) commit();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'indexedDB');
});

describe('MemoryDownloadIndex', () => {
  it('put puis all renvoie l\'item ; delete le retire', async () => {
    const idx = new MemoryDownloadIndex();
    await idx.put(item('a'));
    await idx.put(item('b'));
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);

    await idx.delete('a');
    expect((await idx.all()).map((i) => i.id)).toEqual(['b']);
  });

  it('put avec un id déjà présent remplace l\'entrée ; delete d\'un id absent ne lève pas', async () => {
    const idx = new MemoryDownloadIndex();
    await idx.put(item('a', { bytesDone: 1 }));
    await idx.put(item('a', { bytesDone: 5 }));
    const rows = await idx.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].bytesDone).toBe(5);

    await expect(idx.delete('absent')).resolves.toBeUndefined();
  });

  it('copie à l\'entrée et à la sortie : modifier un objet ne change pas l\'index', async () => {
    const idx = new MemoryDownloadIndex();
    const original = item('a');
    await idx.put(original);
    original.title = 'modifié après coup';
    expect((await idx.all())[0].title).toBe('Film');

    const listed = await idx.all();
    listed[0].bytesDone = 99;
    expect((await idx.all())[0].bytesDone).toBe(0);
  });
});

describe('IdbDownloadIndex avec IndexedDB simulée', () => {
  it('put, all et delete passent par la base', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();

    await idx.put(item('a'));
    await idx.put(item('b'));
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(idb.data.has('a')).toBe(true);

    await idx.delete('a');
    expect((await idx.all()).map((i) => i.id)).toEqual(['b']);
    expect(idb.data.has('a')).toBe(false);
  });

  it('la ligne stockée est exactement l\'item, sans champ ajouté', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    const it1 = item('a', { season: 1, episode: 2, filename: 'e02.mkv' });
    await idx.put(it1);
    expect(idb.data.get('a')).toEqual(it1);
  });

  it('persistance : une nouvelle instance relit les items écrits par la précédente', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    await new IdbDownloadIndex().put(item('a', { state: 'paused', bytesDone: 42 }));

    const reopened = await new IdbDownloadIndex().all();
    expect(reopened).toEqual([item('a', { state: 'paused', bytesDone: 42 })]);
  });

  it('IndexedDB refusée à l\'ouverture : repli mémoire, sans exception', async () => {
    const idb = fakeIndexedDb({ failOpen: true });
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();

    await expect(idx.put(item('a'))).resolves.toBeUndefined();
    expect((await idx.all()).map((i) => i.id)).toEqual(['a']);
    await idx.delete('a');
    expect(await idx.all()).toEqual([]);
    expect(idb.data.size).toBe(0);
  });

  it('accès à indexedDB qui lève à l\'ouverture : repli mémoire, sans exception', async () => {
    const idb = fakeIndexedDb({ throwOpen: true });
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();

    await expect(idx.put(item('a'))).resolves.toBeUndefined();
    expect((await idx.all()).map((i) => i.id)).toEqual(['a']);
  });

  it('sans indexedDB du tout : repli mémoire, sans exception', async () => {
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));
    expect((await idx.all()).map((i) => i.id)).toEqual(['a']);
  });

  it('échec d\'écriture en cours de session : l\'item reste en mémoire et plus rien ne va à la base', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));
    expect(idb.data.has('a')).toBe(true);

    idb.opts.failOn = 'put';
    await expect(idx.put(item('b'))).resolves.toBeUndefined();

    // Après la panne, plus aucune écriture partagée : tout passe par la mémoire, et `a` (déjà connu) reste listé.
    idb.opts.failOn = undefined;
    await idx.put(item('c'));
    expect(idb.data.has('b')).toBe(false);
    expect(idb.data.has('c')).toBe(false);
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(idb.openCalls.count).toBe(1);
  });

  it('échec de lecture (all) : renvoie la mémoire, sans exception', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));

    idb.opts.failOn = 'getAll';
    await expect(idx.all()).resolves.toEqual([item('a')]);
  });

  it('échec de suppression : sans exception, puis les opérations suivantes se font en mémoire', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));
    idb.opts.failOn = 'delete';

    await expect(idx.delete('a')).resolves.toBeUndefined();
    await idx.put(item('b'));
    await idx.put(item('c'));
    await idx.delete('b');
    expect((await idx.all()).map((i) => i.id)).toEqual(['c']);
  });

  it('put ne se résout qu\'à la validation de la transaction (oncomplete), pas au succès de la requête', async () => {
    const idb = fakeIndexedDb({ holdCommit: true });
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    let resolved = false;
    const done = idx.put(item('a')).then(() => { resolved = true; });

    await tick();
    expect(resolved).toBe(false);
    expect(idb.data.has('a')).toBe(false);

    idb.releaseCommits();
    await done;
    expect(resolved).toBe(true);
    expect(idb.data.has('a')).toBe(true);
  });

  it('delete ne se résout qu\'à la validation de la transaction (oncomplete)', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));

    idb.opts.holdCommit = true;
    let resolved = false;
    const done = idx.delete('a').then(() => { resolved = true; });

    await tick();
    expect(resolved).toBe(false);
    expect(idb.data.has('a')).toBe(true);

    idb.releaseCommits();
    await done;
    expect(resolved).toBe(true);
    expect(idb.data.has('a')).toBe(false);
  });

  it('abort de transaction à la validation (quota) : pas d\'exception, l\'item reste listé par all()', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));

    idb.opts.abortOn = 'put';
    await expect(idx.put(item('b'))).resolves.toBeUndefined();
    expect(idb.data.has('b')).toBe(false);
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('panne de lecture en cours de session : all() renvoie les items déjà connus', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));
    await idx.put(item('b'));

    idb.opts.failOn = 'getAll';
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);

    await idx.put(item('c'));
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('all() réussi alimente le miroir : une panne ensuite renvoie aussi ce que la base contenait', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));
    idb.data.set('x', item('x')); // écrit par une autre fenêtre
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'x']);

    idb.opts.failOn = 'getAll';
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'x']);
  });

  it('onversionchange ferme la base ; la prochaine opération la rouvre', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));

    idb.versionChange();
    expect(idb.state.closed).toBe(true);

    await idx.put(item('b'));
    expect(idb.openCalls.count).toBe(2);
    expect(idb.data.has('b')).toBe(true);
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('réouverture refusée après un changement de version : repli mémoire, items déjà connus conservés', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const idx = new IdbDownloadIndex();
    await idx.put(item('a'));

    idb.versionChange();
    idb.opts.failOpen = true;
    await expect(idx.put(item('b'))).resolves.toBeUndefined();
    expect((await idx.all()).map((i) => i.id).sort()).toEqual(['a', 'b']);
  });
});

describe('createDownloadIndex', () => {
  it('sans IndexedDB (jsdom) : index mémoire', () => {
    expect(createDownloadIndex()).toBeInstanceOf(MemoryDownloadIndex);
  });

  it('avec IndexedDB : index persisté, qui relit les items après une nouvelle création', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const first = createDownloadIndex();
    expect(first).toBeInstanceOf(IdbDownloadIndex);
    await first.put(item('a'));

    const second = createDownloadIndex();
    expect((await second.all()).map((i) => i.id)).toEqual(['a']);
  });

  it('IndexedDB refusée à l\'ouverture : fonctionne en mémoire, sans exception', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb({ failOpen: true }).factory);
    const idx = createDownloadIndex();
    await idx.put(item('a'));
    expect((await idx.all()).map((i) => i.id)).toEqual(['a']);
  });

  it('accès à la propriété indexedDB qui lève : index mémoire, sans exception', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw new Error('accès refusé'); },
    });
    let idx: ReturnType<typeof createDownloadIndex> | undefined;
    expect(() => { idx = createDownloadIndex(); }).not.toThrow();
    expect(idx).toBeInstanceOf(MemoryDownloadIndex);
  });
});
