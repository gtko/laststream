// Magasin par segments (ODY-199) : le stockage est simulé en mémoire (un Map par identifiant), les erreurs sont injectées.
import { describe, expect, it } from 'vitest';
import { SegmentedStore, type SegmentBackend } from '../../src/downloads/segmented';

type MemoryBackend = SegmentBackend & {
  files: Map<string, Map<number, Uint8Array<ArrayBuffer>>>;
  /** Fait échouer la prochaine écriture (`write`), sans effet. */
  failNextWrite(err: unknown): void;
};

/** Stockage en mémoire : pour chaque identifiant, ses segments (décalage -> octets). */
function memoryBackend(): MemoryBackend {
  const files = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  let failure: { err: unknown } | undefined;
  return {
    kind: 'opfs',
    files,
    failNextWrite(err) {
      failure = { err };
    },
    async list(id) {
      const segs = files.get(id);
      if (!segs) return [];
      return [...segs]
        .filter(([, data]) => data.byteLength > 0)
        .sort(([a], [b]) => a - b)
        .map(([start, data]) => ({ start, length: data.byteLength }));
    },
    async write(id, start, data) {
      if (failure) {
        const { err } = failure;
        failure = undefined;
        throw err;
      }
      const segs = files.get(id) ?? new Map<number, Uint8Array<ArrayBuffer>>();
      segs.set(start, new Uint8Array(data));
      files.set(id, segs);
    },
    async read(id, segment) {
      return new Blob([files.get(id)?.get(segment.start) ?? new Uint8Array()]);
    },
    async remove(id, starts) {
      if (starts === undefined) {
        files.delete(id);
        return;
      }
      for (const start of starts) files.get(id)?.delete(start);
    },
    async usage() {
      let total = 0;
      for (const segs of files.values()) for (const data of segs.values()) total += data.byteLength;
      return total;
    },
  };
}

const bytes = (n: number, seed = 1): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};
/** Octets d'un Blob ; null s'il est absent. */
async function octets(blob: Blob | null): Promise<Uint8Array | null> {
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const A = bytes(1000, 1);
const B = bytes(1000, 2);
const C = bytes(300, 3);

describe('SegmentedStore', () => {
  it('des écritures contiguës font avancer size()', async () => {
    const store = new SegmentedStore(memoryBackend());
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    expect(await sink.size()).toBe(2000);
    expect(await store.size('a')).toBe(2000);
  });

  it('une nouvelle instance sur le même stockage reprend à la même taille', async () => {
    const backend = memoryBackend();
    const sink = await new SegmentedStore(backend).open('a');
    await sink.write(0, A);
    await sink.write(1000, B);

    const resumed = new SegmentedStore(backend);
    expect(await resumed.size('a')).toBe(2000);
    expect(await (await resumed.open('a')).size()).toBe(2000);
  });

  it('écrire au-delà de la taille lève store_failed', async () => {
    const sink = await new SegmentedStore(memoryBackend()).open('a');
    await sink.write(0, A);
    await expect(sink.write(2000, B)).rejects.toMatchObject({ code: 'store_failed' });
    expect(await sink.size()).toBe(1000);
  });

  it('écrire avant la fin tronque puis écrit à la place', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.write(500, C);
    expect(await sink.size()).toBe(800);
    expect(await octets(await store.file('a'))).toEqual(concat(A.slice(0, 500), C));
  });

  it('truncate(0) vide le fichier', async () => {
    const store = new SegmentedStore(memoryBackend());
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.truncate(0);
    expect(await store.size('a')).toBe(0);
    expect(await store.file('a')).toBeNull();
  });

  it("truncate au milieu d'un segment le raccourcit au préfixe exact", async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.truncate(1500);
    expect(await sink.size()).toBe(1500);
    expect(await backend.list('a')).toEqual([
      { start: 0, length: 1000 },
      { start: 1000, length: 500 },
    ]);
    expect(await octets(await store.file('a'))).toEqual(concat(A, B.slice(0, 500)));
  });

  it('truncate au-delà de la taille est sans effet', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.truncate(5000);
    expect(await sink.size()).toBe(2000);
    expect(await backend.list('a')).toEqual([
      { start: 0, length: 1000 },
      { start: 1000, length: 1000 },
    ]);
  });

  it('les segments orphelins sont ignorés par size() et supprimés à open()', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await backend.write('a', 3000, C); // trou entre 2000 et 3000

    expect(await store.size('a')).toBe(2000);
    expect(await backend.list('a')).toHaveLength(3);

    await store.open('a');
    expect(await backend.list('a')).toEqual([
      { start: 0, length: 1000 },
      { start: 1000, length: 1000 },
    ]);
  });

  it('QuotaExceededError lève store_full et laisse le fichier inchangé', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);

    backend.failNextWrite(new DOMException('plein', 'QuotaExceededError'));
    await expect(sink.write(1000, B)).rejects.toMatchObject({ code: 'store_full' });

    expect(await store.size('a')).toBe(1000);
    expect(await octets(await store.file('a'))).toEqual(A);
  });

  it('QuotaExceededError pendant une troncature laisse le fichier inchangé', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);

    backend.failNextWrite(new DOMException('plein', 'QuotaExceededError'));
    await expect(sink.truncate(1500)).rejects.toMatchObject({ code: 'store_full' });

    expect(await sink.size()).toBe(2000);
    expect(await octets(await store.file('a'))).toEqual(concat(A, B));
  });

  it('suppression en échec pendant une troncature : le disque garde un préfixe valide de l’ancien fichier', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.write(2000, A);

    // La suppression de la fin échoue à mi-parcours : le segment de 2000 est parti (supprimé en premier), pas celui de 1000.
    const remove = backend.remove.bind(backend);
    backend.remove = async (id, starts) => {
      await remove(id, starts?.slice(0, 1));
      throw new Error('entrée/sortie');
    };
    await expect(sink.truncate(500)).rejects.toMatchObject({ code: 'store_failed' });

    backend.remove = remove;
    const reopened = await new SegmentedStore(backend).open('a');
    expect(await reopened.size()).toBe(2000);
    expect(await octets(await new SegmentedStore(backend).file('a'))).toEqual(concat(A, B));
  });

  it('une autre erreur du stockage lève store_failed', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');
    await sink.write(0, A);

    backend.failNextWrite(new Error('entrée/sortie'));
    await expect(sink.write(1000, B)).rejects.toMatchObject({ code: 'store_failed' });
    expect(await store.size('a')).toBe(1000);
  });

  it('remove supprime le téléchargement sans toucher aux autres', async () => {
    const store = new SegmentedStore(memoryBackend());
    await (await store.open('a')).write(0, A);
    await (await store.open('b')).write(0, B);

    await store.remove('a');

    expect(await store.size('a')).toBe(0);
    expect(await store.file('a')).toBeNull();
    expect(await store.size('b')).toBe(1000);
  });

  it('usage() additionne les octets de tous les identifiants', async () => {
    const store = new SegmentedStore(memoryBackend());
    await (await store.open('a')).write(0, A);
    await (await store.open('b')).write(0, C);
    expect(await store.usage()).toEqual({ used: 1300 });
  });

  it('file(id) renvoie un Blob au contenu écrit, null si le fichier est absent', async () => {
    const store = new SegmentedStore(memoryBackend());
    expect(await store.file('a')).toBeNull();

    const sink = await store.open('a');
    await sink.write(0, A);
    await sink.write(1000, B);

    const blob = await store.file('a', 'video/x-matroska');
    expect(blob?.type).toBe('video/x-matroska');
    expect(await octets(blob)).toEqual(concat(A, B));
  });

  it('un morceau vide est ignoré', async () => {
    const backend = memoryBackend();
    const store = new SegmentedStore(backend);
    const sink = await store.open('a');

    await sink.write(0, new Uint8Array());
    expect(await sink.size()).toBe(0);
    expect(await backend.list('a')).toEqual([]);

    await sink.write(0, A);
    await sink.write(1000, new Uint8Array());
    expect(await sink.size()).toBe(1000);
    expect(await backend.list('a')).toEqual([{ start: 0, length: 1000 }]);
  });
});
