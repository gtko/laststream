/* Stockage OPFS (origin private file system) des téléchargements web (ODY-199) : un dossier par téléchargement, un fichier par
 * segment (nom = décalage, sur 16 chiffres). Chaque segment est écrit par `createWritable()` : le fichier n'est remplacé qu'à
 * `close()`, donc un segment est complet ou absent. `createWritable` manque à Safari hors worker : `opfsAvailable()` le
 * détecte et le web retombe alors sur IndexedDB. Types locaux : le lib DOM de TypeScript n'a pas les itérateurs de dossiers. */
import type { Segment, SegmentBackend } from './segmented';

export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface OpfsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<OpfsWritable>;
}
export interface OpfsDirectory {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectory>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory' }]>;
}
/** Ce qu'il faut de `navigator.storage` pour ouvrir la racine. */
export interface OpfsStorage {
  getDirectory?: () => Promise<OpfsDirectory>;
}

const ROOT = 'laststream-downloads';
const SEGMENT_NAME = /^\d{16}$/;

const segmentName = (start: number): string => String(start).padStart(16, '0');

/** Nom de dossier sûr pour un identifiant (`tt1:1:2`) : encodage URL, points compris (`.` et `..` sont interdits). */
export const directoryName = (id: string): string => encodeURIComponent(id).replace(/\./g, '%2E') || '%00';

const notFound = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'NotFoundError';

/** OPFS utilisable ici : racine accessible et `createWritable` présent sur les fichiers (absent de Safari hors worker). */
export async function opfsAvailable(
  storage: OpfsStorage | undefined = typeof navigator === 'undefined' ? undefined : (navigator.storage as unknown as OpfsStorage | undefined),
  writableSupported: boolean = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
): Promise<OpfsDirectory | null> {
  if (!storage || typeof storage.getDirectory !== 'function' || !writableSupported) return null;
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(ROOT, { create: true });
  } catch {
    // Navigation privée de Firefox, politique du navigateur : SecurityError ou NotAllowedError.
    return null;
  }
}

export class OpfsBackend implements SegmentBackend {
  readonly kind = 'opfs' as const;

  constructor(private readonly base: OpfsDirectory) {}

  private async dir(id: string, create: boolean): Promise<OpfsDirectory | null> {
    try {
      return await this.base.getDirectoryHandle(directoryName(id), { create });
    } catch (err) {
      if (!create && notFound(err)) return null;
      throw err;
    }
  }

  private async segments(dir: OpfsDirectory): Promise<Array<Segment & { name: string }>> {
    const out: Array<Segment & { name: string }> = [];
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== 'file' || !SEGMENT_NAME.test(name)) continue;
      const length = (await (await dir.getFileHandle(name)).getFile()).size;
      if (length > 0) out.push({ name, start: Number(name), length });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  async list(id: string): Promise<Segment[]> {
    const dir = await this.dir(id, false);
    if (!dir) return [];
    return (await this.segments(dir)).map(({ start, length }) => ({ start, length }));
  }

  async write(id: string, start: number, data: Uint8Array): Promise<void> {
    const dir = await this.dir(id, true);
    if (!dir) return;
    const name = segmentName(start);
    const existed = await dir.getFileHandle(name).then(() => true, () => false);
    let writable: OpfsWritable | null = null;
    try {
      writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(data);
      await writable.close();
    } catch (err) {
      // Rien n'est validé : on annule l'écriture et on retire le fichier vide que la création a pu laisser.
      await writable?.abort().catch(() => undefined);
      if (!existed) await dir.removeEntry(name).catch(() => undefined);
      throw err;
    }
  }

  async read(id: string, segment: Segment): Promise<Blob> {
    const dir = await this.dir(id, false);
    if (!dir) return new Blob([]);
    return (await dir.getFileHandle(segmentName(segment.start))).getFile();
  }

  async remove(id: string, starts?: readonly number[]): Promise<void> {
    if (starts === undefined) {
      await this.base.removeEntry(directoryName(id), { recursive: true }).catch((err: unknown) => {
        if (!notFound(err)) throw err;
      });
      return;
    }
    const dir = await this.dir(id, false);
    if (!dir) return;
    for (const start of starts) {
      await dir.removeEntry(segmentName(start)).catch((err: unknown) => {
        if (!notFound(err)) throw err;
      });
    }
  }

  async usage(): Promise<number> {
    let total = 0;
    for await (const [name, entry] of this.base.entries()) {
      if (entry.kind !== 'directory') continue;
      const dir = await this.base.getDirectoryHandle(name);
      for (const seg of await this.segments(dir)) total += seg.length;
    }
    return total;
  }
}
