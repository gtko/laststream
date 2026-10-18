import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Plafond par défaut du cache disque : 300 Mo. */
export const DEFAULT_CACHE_BYTES = 300 * 1024 * 1024;

interface CachedFile {
  path: string;
  size: number;
  at: number;
}

/** Cache disque d'images <dossier>/<clé>/<index>.webp, purge LRU (date de modification rafraîchie à chaque lecture). */
export class ThumbCache {
  private bytes = 0;
  private scanned: Promise<void> | undefined;
  private purging: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly maxBytes: number = DEFAULT_CACHE_BYTES,
    private readonly clock: () => number = Date.now,
  ) {}

  private path(key: string, index: number): string {
    return join(this.dir, key, `${index}.webp`);
  }

  private async files(): Promise<CachedFile[]> {
    const found: CachedFile[] = [];
    let keys: string[];
    try {
      keys = await readdir(this.dir);
    } catch {
      return found;
    }
    for (const key of keys) {
      let names: string[];
      try {
        names = await readdir(join(this.dir, key));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(this.dir, key, name);
        try {
          const s = await stat(path);
          if (s.isFile()) found.push({ path, size: s.size, at: s.mtimeMs });
        } catch {
          // fichier disparu entre-temps
        }
      }
    }
    return found;
  }

  private ensureScanned(): Promise<void> {
    this.scanned ??= this.files().then((all) => {
      this.bytes = all.reduce((sum, f) => sum + f.size, 0);
    });
    return this.scanned;
  }

  /** Indices déjà présents pour une clé. */
  async indexes(key: string): Promise<number[]> {
    try {
      return (await readdir(join(this.dir, key)))
        .map((name) => /^(\d+)\.webp$/.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
    } catch {
      return [];
    }
  }

  async get(key: string, index: number): Promise<Buffer | undefined> {
    const path = this.path(key, index);
    try {
      const data = await readFile(path);
      const now = new Date(this.clock());
      await utimes(path, now, now).catch(() => undefined);
      return data;
    } catch {
      return undefined;
    }
  }

  async put(key: string, index: number, data: Buffer): Promise<void> {
    await this.ensureScanned();
    const path = this.path(key, index);
    await mkdir(join(this.dir, key), { recursive: true });
    await writeFile(path, data);
    const now = new Date(this.clock());
    await utimes(path, now, now).catch(() => undefined);
    this.bytes += data.length;
    if (this.bytes > this.maxBytes) await this.purge();
  }

  /** Supprime les fichiers les moins récemment utilisés jusqu'à 90 % du plafond. */
  purge(): Promise<void> {
    this.purging = this.purging.then(async () => {
      const all = (await this.files()).sort((a, b) => a.at - b.at);
      let total = all.reduce((sum, f) => sum + f.size, 0);
      const target = Math.floor(this.maxBytes * 0.9);
      for (const f of all) {
        if (total <= target) break;
        await rm(f.path, { force: true });
        total -= f.size;
      }
      this.bytes = total;
    });
    return this.purging;
  }

  get totalBytes(): number {
    return this.bytes;
  }
}
