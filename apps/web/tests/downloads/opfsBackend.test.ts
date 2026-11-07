// Stockage OPFS (ODY-199) : le système de fichiers est simulé en mémoire (dossiers imbriqués, écriture validée à close(),
// erreur injectable au write). Le test d'intégration enchaîne SegmentedStore et OpfsBackend sur ce faux OPFS.
import { describe, expect, it } from 'vitest';
import {
  OpfsBackend,
  directoryName,
  opfsAvailable,
  type OpfsDirectory,
  type OpfsFileHandle,
  type OpfsWritable,
} from '../../src/downloads/opfsBackend';
import { SegmentedStore } from '../../src/downloads/segmented';

class FakeFile {
  bytes = new Uint8Array();
}
class FakeDir {
  readonly children = new Map<string, FakeFile | FakeDir>();
}

interface Faults {
  /** Prochain `write()` d'un flux d'écriture : lève cette erreur, sans effet. */
  writeError?: unknown;
}

const domError = (name: string): DOMException => new DOMException(name, name);

/** Nom d'un DOMException (ou de toute erreur). */
async function nameOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { name?: string }).name;
  }
  return undefined;
}

function fileHandle(parent: FakeDir, name: string, faults: Faults): OpfsFileHandle {
  // Comme le vrai OPFS, le fichier n'apparaît qu'à createWritable() (vide) ; getFile() lit l'état validé.
  const current = (): FakeFile | undefined => {
    const child = parent.children.get(name);
    return child instanceof FakeFile ? child : undefined;
  };
  return {
    async getFile(): Promise<File> {
      const file = current();
      if (!file) throw domError('NotFoundError');
      return new File([file.bytes.slice()], name);
    },
    async createWritable(): Promise<OpfsWritable> {
      let file = current();
      if (!file) {
        file = new FakeFile();
        parent.children.set(name, file);
      }
      const target = file;
      // Rien n'est validé avant close() : write() accumule, close() remplace le contenu, abort() jette.
      let staged: Uint8Array[] = [];
      return {
        async write(data) {
          if (faults.writeError !== undefined) {
            const err = faults.writeError;
            faults.writeError = undefined;
            throw err;
          }
          staged.push(data.slice());
        },
        async close() {
          target.bytes = concat(...staged);
        },
        async abort() {
          staged = [];
        },
      };
    },
  };
}

function dirHandle(node: FakeDir, faults: Faults): OpfsDirectory {
  return {
    async getDirectoryHandle(name, opts) {
      const child = node.children.get(name);
      if (child instanceof FakeDir) return dirHandle(child, faults);
      if (child) throw domError('TypeMismatchError');
      if (!opts?.create) throw domError('NotFoundError');
      const created = new FakeDir();
      node.children.set(name, created);
      return dirHandle(created, faults);
    },
    async getFileHandle(name, opts) {
      const child = node.children.get(name);
      if (child instanceof FakeDir) throw domError('TypeMismatchError');
      if (!child && !opts?.create) throw domError('NotFoundError');
      return fileHandle(node, name, faults);
    },
    async removeEntry(name, opts) {
      const child = node.children.get(name);
      if (!child) throw domError('NotFoundError');
      if (child instanceof FakeDir && child.children.size > 0 && !opts?.recursive) {
        throw domError('InvalidModificationError');
      }
      node.children.delete(name);
    },
    async *entries() {
      for (const [name, child] of [...node.children]) {
        const kind: 'file' | 'directory' = child instanceof FakeDir ? 'directory' : 'file';
        yield [name, { kind }];
      }
    },
  };
}

/** Faux OPFS : `tree` est la racine réelle, `root` le handle que l'appli obtient de `navigator.storage.getDirectory()`. */
function fakeOpfs() {
  const tree = new FakeDir();
  const faults: Faults = {};
  return { tree, faults, root: dirHandle(tree, faults) };
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
const fileWith = (data: Uint8Array<ArrayBuffer>): FakeFile => {
  const file = new FakeFile();
  file.bytes = data;
  return file;
};
const dirOf = (node: FakeDir, id: string): FakeDir => node.children.get(directoryName(id)) as FakeDir;

const A = bytes(1000, 1);
const B = bytes(1000, 2);
const C = bytes(300, 3);

describe('OpfsBackend', () => {
  it('list, write, read et remove par segment, puis pour tout le téléchargement', async () => {
    const fs = fakeOpfs();
    const backend = new OpfsBackend(fs.root);
    expect(await backend.list('tt1')).toEqual([]);

    await backend.write('tt1', 0, A);
    await backend.write('tt1', 1000, B);
    expect(await backend.list('tt1')).toEqual([
      { start: 0, length: 1000 },
      { start: 1000, length: 1000 },
    ]);
    expect(await octets(await backend.read('tt1', { start: 1000, length: 1000 }))).toEqual(B);

    await backend.remove('tt1', [0]);
    expect(await backend.list('tt1')).toEqual([{ start: 1000, length: 1000 }]);

    await backend.remove('tt1');
    expect(await backend.list('tt1')).toEqual([]);
    expect(fs.tree.children.has(directoryName('tt1'))).toBe(false);
  });

  it('remove d\'un segment ou d\'un téléchargement absent ne lève pas d\'erreur', async () => {
    const backend = new OpfsBackend(fakeOpfs().root);
    await backend.write('tt1', 0, A);
    await expect(backend.remove('tt1', [9999])).resolves.toBeUndefined();
    await expect(backend.remove('absent')).resolves.toBeUndefined();
    await expect(backend.remove('absent', [0])).resolves.toBeUndefined();
  });

  it('les segments sont triés par start', async () => {
    const backend = new OpfsBackend(fakeOpfs().root);
    await backend.write('tt1', 2000, bytes(500, 4));
    await backend.write('tt1', 0, A);
    await backend.write('tt1', 1000, B);
    expect((await backend.list('tt1')).map((s) => s.start)).toEqual([0, 1000, 2000]);
  });

  it('un segment de longueur 0 n\'est pas listé', async () => {
    const backend = new OpfsBackend(fakeOpfs().root);
    await backend.write('tt1', 0, new Uint8Array());
    await backend.write('tt1', 1000, B);
    expect(await backend.list('tt1')).toEqual([{ start: 1000, length: 1000 }]);
  });

  it('les entrées non conformes sont ignorées par list() et usage()', async () => {
    const fs = fakeOpfs();
    const backend = new OpfsBackend(fs.root);
    await backend.write('tt1', 0, A);

    const dir = dirOf(fs.tree, 'tt1');
    dir.children.set('0000000000000000.crswap', fileWith(C)); // nom non conforme (suffixe)
    dir.children.set('notes.txt', fileWith(C));
    dir.children.set('0000000000001000', new FakeDir()); // un dossier, pas un segment

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 1000 }]);
    expect(await backend.usage()).toBe(1000);
  });

  it('un write qui échoue (QuotaExceededError) laisse intact l\'ancien contenu du segment', async () => {
    const fs = fakeOpfs();
    const backend = new OpfsBackend(fs.root);
    await backend.write('tt1', 0, A);

    fs.faults.writeError = domError('QuotaExceededError');
    expect(await nameOf(backend.write('tt1', 0, B))).toBe('QuotaExceededError');

    expect(await backend.list('tt1')).toEqual([{ start: 0, length: 1000 }]);
    expect(await octets(await backend.read('tt1', { start: 0, length: 1000 }))).toEqual(A);
  });

  it('un write qui échoue ne laisse aucun fichier vide quand le segment n\'existait pas', async () => {
    const fs = fakeOpfs();
    const backend = new OpfsBackend(fs.root);

    fs.faults.writeError = domError('QuotaExceededError');
    expect(await nameOf(backend.write('tt1', 1000, B))).toBe('QuotaExceededError');

    expect([...dirOf(fs.tree, 'tt1').children.keys()]).toEqual([]);
    expect(await backend.list('tt1')).toEqual([]);
    expect(await backend.usage()).toBe(0);
  });

  it('usage() additionne tous les dossiers et ignore les fichiers à la racine', async () => {
    const fs = fakeOpfs();
    const backend = new OpfsBackend(fs.root);
    await backend.write('tt1', 0, A);
    await backend.write('tt1', 1000, B);
    await backend.write('tt1:1:2', 0, C);

    fs.tree.children.set('lisez-moi.txt', fileWith(bytes(50)));

    expect(await backend.usage()).toBe(2300);
  });

  it('directoryName encode les deux-points et neutralise les points et les barres', () => {
    expect(directoryName('tt1:1:2')).toBe('tt1%3A1%3A2');
    expect(directoryName('..')).toBe('%2E%2E');
    expect(directoryName('.')).toBe('%2E');
    expect(directoryName('a/b')).toBe('a%2Fb');
    for (const id of ['tt1:1:2', '..', '.', 'a/b']) {
      expect(directoryName(id)).not.toMatch(/[./]/);
    }
    expect(directoryName('')).toBe('%00');
  });
});

describe('opfsAvailable', () => {
  it('renvoie null sans navigator.storage', async () => {
    expect(await opfsAvailable(undefined, true)).toBeNull();
  });

  it('renvoie null sans getDirectory', async () => {
    expect(await opfsAvailable({}, true)).toBeNull();
  });

  it('renvoie null si createWritable n\'est pas supporté', async () => {
    const fs = fakeOpfs();
    expect(await opfsAvailable({ getDirectory: async () => fs.root }, false)).toBeNull();
  });

  it('renvoie null si getDirectory lève (navigation privée, politique du navigateur)', async () => {
    const storage = {
      getDirectory: async (): Promise<OpfsDirectory> => {
        throw domError('SecurityError');
      },
    };
    expect(await opfsAvailable(storage, true)).toBeNull();
  });

  it('renvoie le dossier laststream-downloads sinon, prêt à l\'écriture', async () => {
    const fs = fakeOpfs();
    const base = await opfsAvailable({ getDirectory: async () => fs.root }, true);
    expect(base).not.toBeNull();

    const downloads = fs.tree.children.get('laststream-downloads');
    expect(downloads).toBeInstanceOf(FakeDir);

    await new OpfsBackend(base as OpfsDirectory).write('tt1', 0, A);
    expect((downloads as FakeDir).children.has(directoryName('tt1'))).toBe(true);
  });
});

describe('SegmentedStore sur OpfsBackend', () => {
  it('trois morceaux écrits, reprise par une nouvelle instance, size() et file() concordants', async () => {
    const fs = fakeOpfs();
    const sink = await new SegmentedStore(new OpfsBackend(fs.root)).open('tt1:1:2');
    await sink.write(0, A);
    await sink.write(1000, B);
    await sink.write(2000, C);

    const resumed = new SegmentedStore(new OpfsBackend(fs.root));
    expect(resumed.kind).toBe('opfs');
    expect(await resumed.size('tt1:1:2')).toBe(2300);
    expect(await octets(await resumed.file('tt1:1:2'))).toEqual(concat(A, B, C));
  });
});
