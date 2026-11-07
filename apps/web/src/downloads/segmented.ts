/* Magasin de téléchargements par segments (ODY-199) : un fichier est une suite contiguë de segments (un par morceau écrit),
 * posés à leur décalage dans le fichier. Chaque segment est validé d'un bloc par le stockage (OPFS ou IndexedDB) : une
 * coupure, un quota dépassé ou un onglet fermé en pleine écriture laissent le fichier à la fin du dernier segment complet,
 * jamais corrompu. Le point de reprise (`size`) est la fin de la suite contiguë. Logique commune aux deux stockages web :
 * chacun n'implémente que `SegmentBackend`. */
import { DownloadError, type DownloadSink, type DownloadStore } from './types';

export interface Segment {
  /** Décalage du premier octet dans le fichier. */
  start: number;
  length: number;
}

/** Primitives d'un stockage : aucune règle de contiguïté ici, c'est le rôle de `SegmentedStore`. */
export interface SegmentBackend {
  readonly kind: 'opfs' | 'indexeddb';
  /** Segments de `id`, triés par `start`. Un segment vide ou illisible n'est pas listé. */
  list(id: string): Promise<Segment[]>;
  /** Écrit (ou remplace) le segment de `id` à `start`, d'un bloc : tout ou rien. Lève `QuotaExceededError` si le stockage est plein. */
  write(id: string, start: number, data: Uint8Array): Promise<void>;
  /** Contenu d'un segment, sans le charger en mémoire quand le stockage sait l'éviter. */
  read(id: string, segment: Segment): Promise<Blob>;
  /** Supprime les segments de `id` commençant à `starts` ; tous si `starts` est absent. */
  remove(id: string, starts?: readonly number[]): Promise<void>;
  /** Octets occupés par tous les téléchargements. */
  usage(): Promise<number>;
}

/** Quota du navigateur atteint : `QuotaExceededError` (code 22) ou son équivalent Firefox. */
function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22;
}

/** Une erreur du stockage devient `store_full` (quota) ou `store_failed` ; une `DownloadError` passe telle quelle. */
function storeError(err: unknown): DownloadError {
  if (err instanceof DownloadError) return err;
  return new DownloadError(isQuotaError(err) ? 'store_full' : 'store_failed', false, err);
}

async function guarded<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw storeError(err);
  }
}

/** Segments contigus depuis 0 et fin de la suite ; le reste (trou ou chevauchement) est orphelin. */
function contiguous(segments: readonly Segment[]): { kept: Segment[]; orphans: Segment[]; end: number } {
  const kept: Segment[] = [];
  let end = 0;
  for (const seg of segments) {
    if (seg.start !== end || seg.length <= 0) break;
    kept.push(seg);
    end += seg.length;
  }
  return { kept, orphans: segments.slice(kept.length), end };
}

export class SegmentedStore implements DownloadStore {
  constructor(private readonly backend: SegmentBackend) {}

  get kind(): SegmentBackend['kind'] {
    return this.backend.kind;
  }

  /** Suite contiguë de `id` ; supprime les segments orphelins quand `clean` est vrai. */
  private async state(id: string, clean: boolean): Promise<{ kept: Segment[]; end: number }> {
    const { kept, orphans, end } = contiguous(await this.backend.list(id));
    if (clean && orphans.length > 0) await this.backend.remove(id, orphans.map((s) => s.start));
    return { kept, end };
  }

  async open(id: string): Promise<DownloadSink> {
    const opened = await guarded(() => this.state(id, true));
    let kept = opened.kept;
    let end = opened.end;
    const backend = this.backend;

    const truncate = async (len: number): Promise<void> => {
      if (len >= end) return;
      const drop = kept.filter((s) => s.start >= len);
      const straddle = kept.find((s) => s.start < len && s.start + s.length > len);
      // Suppression de la fin vers le début : un échec laisse toujours un préfixe valide de l'ancien fichier (jamais un trou
      // suivi de segments contigus). Le segment qui contient `len` est ensuite réécrit d'un bloc, raccourci ; l'état en mémoire
      // n'avance qu'au succès (après un échec, la session s'arrête et la prochaine `open` relit le disque).
      if (drop.length > 0) await backend.remove(id, drop.map((s) => s.start).reverse());
      if (straddle) {
        const head = await (await backend.read(id, straddle)).slice(0, len - straddle.start).arrayBuffer();
        await backend.write(id, straddle.start, new Uint8Array(head));
      }
      kept = kept.filter((s) => s.start < len).map((s) => (s === straddle ? { start: s.start, length: len - s.start } : s));
      end = len;
    };

    return {
      size: () => Promise.resolve(end),
      write: (offset, chunk) =>
        guarded(async () => {
          if (offset > end) throw new DownloadError('store_failed', false);
          if (offset < end) await truncate(offset);
          if (chunk.byteLength === 0) return;
          await backend.write(id, offset, chunk);
          kept.push({ start: offset, length: chunk.byteLength });
          end = offset + chunk.byteLength;
        }),
      truncate: (len) => guarded(() => truncate(len)),
      finalize: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  }

  async size(id: string): Promise<number> {
    return (await guarded(() => this.state(id, false))).end;
  }

  remove(id: string): Promise<void> {
    return guarded(() => this.backend.remove(id));
  }

  async usage(): Promise<{ used: number; available?: number }> {
    return { used: await guarded(() => this.backend.usage()) };
  }

  /** Le fichier téléchargé (ses segments mis bout à bout) ; null s'il est vide ou absent. Disque, pas mémoire, avec OPFS. */
  async file(id: string, type = ''): Promise<Blob | null> {
    const { kept } = await guarded(() => this.state(id, false));
    if (kept.length === 0) return null;
    const parts = await guarded(() => Promise.all(kept.map((s) => this.backend.read(id, s))));
    return new Blob(parts, { type });
  }
}
