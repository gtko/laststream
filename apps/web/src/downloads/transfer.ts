/**
 * Transfert d'un fichier par plages HTTP (ODY-198) : reprise au point déjà écrit dans le magasin, validation de chaque
 * réponse, classement des échecs en `DownloadError`. Aucune dépendance au fournisseur ni à la plateforme : le transport
 * (`http`) et le magasin (`sink`) sont injectés. Le lien (`url`) ne sort jamais de ce module : ni dans une erreur,
 * ni dans un journal.
 */
import { DownloadError, MAX_FULL_BODY_BYTES, type HttpFn, type TransferParams, type TransferProgress } from './types';

type HttpResponse = Awaited<ReturnType<HttpFn>>;
type Finished = TransferProgress & { done: true };

/** `bytes a-b/total` ; `total` vaut `*` quand le serveur ne connaît pas la taille. */
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;
/** `bytes *\/total`, renvoyé avec un 416. */
const UNSATISFIED_RANGE = /^bytes \*\/(\d+)$/;
const LINK_EXPIRED_STATUS = new Set([401, 403, 404, 410]);

/** Lève `cancelled` dès que l'appelant a annulé. */
function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DownloadError('cancelled', false);
}

/** Les erreurs du magasin gardent leur code ; les autres deviennent `store_failed`. */
async function store<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError('store_failed', false, err);
  }
}

/** Une requête GET. Une erreur de transport devient `network` (ou `cancelled` si l'appelant a annulé). */
async function send(p: TransferParams, headers: Record<string, string>): Promise<HttpResponse> {
  assertNotCancelled(p.signal);
  let res: HttpResponse;
  try {
    res = await p.http({ url: p.url, method: 'GET', headers, signal: p.signal });
  } catch {
    // Le message du transport peut contenir le lien : il n'est pas repris.
    assertNotCancelled(p.signal);
    throw new DownloadError('network', true);
  }
  // Un morceau reçu après l'annulation n'est jamais écrit.
  assertNotCancelled(p.signal);
  return res;
}

/** Une page HTML à la place d'un média : lien périmé, quel que soit le morceau (jamais écrite comme fichier). */
const isHtml = (res: HttpResponse): boolean => (res.headers['content-type'] ?? '').toLowerCase().includes('text/html');

function parseContentRange(value: string | undefined): { start: number; last: number; total?: number } | null {
  const m = CONTENT_RANGE.exec(value ?? '');
  if (!m) return null;
  return { start: Number(m[1]), last: Number(m[2]), total: m[3] === '*' ? undefined : Number(m[3]) };
}

/**
 * Télécharge le fichier par plages jusqu'à `bytesTotal`, ou jusqu'à un morceau plus court quand la taille est inconnue.
 * Ne finalise pas le magasin : c'est au gestionnaire de le faire.
 */
export async function fetchChunks(p: TransferParams): Promise<Finished> {
  const { sink, chunkSize, onProgress } = p;
  let bytesTotal = p.bytesTotal;
  let etag = p.etag;
  let lastModified: string | undefined;
  let restarted = false;

  assertNotCancelled(p.signal);
  let offset = await store(() => sink.size());
  if (bytesTotal !== undefined && offset > bytesTotal) {
    await store(() => sink.truncate(0));
    offset = 0;
  }

  // Changement distant pendant la reprise : on repart de zéro, une seule fois, en oubliant ETag et taille.
  const restartFromZero = async (): Promise<void> => {
    if (restarted) throw new DownloadError('range_mismatch', false);
    restarted = true;
    await store(() => sink.truncate(0));
    offset = 0;
    bytesTotal = undefined;
    etag = undefined;
    lastModified = undefined;
  };

  const finished = (): Finished => ({ bytesDone: offset, bytesTotal, etag, lastModified, done: true });

  while (bytesTotal === undefined || offset < bytesTotal) {
    const end = bytesTotal === undefined ? offset + chunkSize - 1 : Math.min(offset + chunkSize, bytesTotal) - 1;
    // Seul `Range` part : pas de `If-Range` (un ETag d'un ancien lien ferait répondre 200 avec tout le fichier, chargé en RAM).
    const res = await send(p, { Range: `bytes=${offset}-${end}` });

    if ((res.status === 200 || res.status === 206) && isHtml(res)) throw new DownloadError('link_expired', true);
    if (LINK_EXPIRED_STATUS.has(res.status)) throw new DownloadError('link_expired', true);
    if (res.status === 429 || res.status >= 500) throw new DownloadError('network', true);

    if (res.status === 416) {
      // Fin de fichier quand la taille n'était pas connue : le serveur donne la taille réelle.
      const unsatisfied = UNSATISFIED_RANGE.exec(res.headers['content-range'] ?? '');
      if (bytesTotal !== undefined || unsatisfied === null || Number(unsatisfied[1]) !== offset) {
        await restartFromZero();
        continue;
      }
      bytesTotal = offset;
      return finished();
    }

    if (res.status === 206) {
      const range = parseContentRange(res.headers['content-range']);
      const resEtag = res.headers.etag;
      // ETag attendu : celui du lien courant (`p.etag`), ou à défaut celui du premier morceau de cette session (oublié au redémarrage).
      const valid =
        range !== null &&
        range.start === offset &&
        range.last >= range.start &&
        res.body.length === range.last - range.start + 1 &&
        (range.total === undefined ||
          (range.last < range.total && (bytesTotal === undefined || range.total === bytesTotal))) &&
        (etag === undefined || resEtag === undefined || resEtag === etag);
      if (range === null || !valid) {
        await restartFromZero();
        continue;
      }
      // Le premier morceau fixe la taille, l'ETag et la date de modification.
      bytesTotal ??= range.total;
      etag ??= resEtag;
      lastModified ??= res.headers['last-modified'];
      await store(() => sink.write(offset, res.body));
      offset += res.body.length;
      await onProgress({ bytesDone: offset, bytesTotal, etag, lastModified });
      // Taille inconnue : un morceau plus court que demandé marque la fin du fichier.
      if (bytesTotal === undefined && res.body.length < chunkSize) bytesTotal = offset;
      continue;
    }

    if (res.status === 200) {
      // Réponse 200 (serveur sans `Range`, ou qui ignore la plage) : le corps entier remplace le fichier.
      // Plafond vérifié sur `content-length` avant toute écriture ni troncature.
      const declared = Number(res.headers['content-length']);
      if (res.body.length > MAX_FULL_BODY_BYTES || declared > MAX_FULL_BODY_BYTES) {
        throw new DownloadError('content', false);
      }
      if (offset > 0) await store(() => sink.truncate(0));
      offset = 0;
      bytesTotal = res.body.length;
      etag = res.headers.etag;
      lastModified = res.headers['last-modified'];
      if (bytesTotal > 0) {
        await store(() => sink.write(0, res.body));
        offset = bytesTotal;
        await onProgress({ bytesDone: offset, bytesTotal, etag, lastModified });
      }
      return finished();
    }

    throw new DownloadError('content', false);
  }

  return finished();
}
