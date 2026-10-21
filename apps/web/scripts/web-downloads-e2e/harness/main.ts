// Page de test des téléchargements web (ODY-199) : le vrai DownloadManager, le vrai magasin OPFS / IndexedDB et le vrai transport
// `fetch`, sans le reste de l'app. Expose window.__d pour que web-downloads.mjs la pilote avec Playwright (headless uniquement).
// Le média est un flux d'octets déterministe (voir `byteAt`) servi par le script : aucun fichier réel, 500 Mo possibles.
import { DownloadManager } from '../../../src/downloads/manager';
import { createDownloadIndex } from '../../../src/downloads/index';
import { createWebDownloadStore, type WebDownloadStore } from '../../../src/downloads/webStore';
import { createWebDownloadHttp } from '../../../src/downloads/webHttp';
import { webDownloadErrorMessage } from '../../../src/downloads/webMessages';
import type { DownloadItem } from '../../../src/downloads/types';

/** Même formule que le serveur de web-downloads.mjs. */
const byteAt = (i: number): number => (Math.imul(i, 2654435761) >>> 24) & 255;

const params = new URLSearchParams(location.search);
const backend = params.get('backend') === 'indexeddb' ? 'indexeddb' : 'opfs';
const mediaBase = params.get('media') ?? '';
const chunkSize = Number(params.get('chunk') ?? 4 * 1024 * 1024);

const store: WebDownloadStore = createWebDownloadStore({ prefer: backend });
const index = createDownloadIndex();
const events: string[] = [];

/** Les attentes entre tentatives sont raccourcies : le test vérifie la reprise, pas le délai. */
const fastSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.min(ms, 300));
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

let manager: DownloadManager | null = null;
let path = '';

function build(file: string, size: number, limit: number | null): DownloadManager {
  path = `${file}/${size}`;
  return new DownloadManager({
    resolver: { resolve: () => Promise.resolve({ url: `${mediaBase}/${path}`, size, filename: 'film.mkv' }) },
    http: createWebDownloadHttp({ allowHost: () => true }),
    store,
    index,
    chunkSize,
    limitBytes: limit,
    sleep: fastSleep,
    maxNetworkRetries: 30,
    onLog: (e, d) => events.push(d ? `${e} ${JSON.stringify(d)}` : e),
  });
}

/** Compare le fichier stocké au flux attendu, par tranches (jamais le fichier entier en mémoire). Renvoie la taille lue. */
async function verify(id: string, expectedSize?: number): Promise<{ size: number; ok: boolean; firstBad: number }> {
  const blob = await store.file(id);
  if (!blob) return { size: 0, ok: expectedSize === 0, firstBad: -1 };
  const step = 4 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += step) {
    const buf = new Uint8Array(await blob.slice(at, Math.min(at + step, blob.size)).arrayBuffer());
    for (let i = 0; i < buf.length; i += 1) if (buf[i] !== byteAt(at + i)) return { size: blob.size, ok: false, firstBad: at + i };
  }
  return { size: blob.size, ok: expectedSize === undefined || blob.size === expectedSize, firstBad: -1 };
}

const view = (it: DownloadItem | undefined) =>
  it && { state: it.state, bytesDone: it.bytesDone, bytesTotal: it.bytesTotal ?? null, error: it.error?.code ?? null, attempts: it.attempts };

const api = {
  /** Démarre un téléchargement (`file` : nom de route du serveur ; `size` : octets). */
  async start(file: string, size: number, limit: number | null = null) {
    manager = build(file, size, limit);
    await manager.init();
    await manager.enqueue({ metaId: 'tt0000001', title: 'Film de test', source: { copies: [{ infoHash: 'a'.repeat(40) }] } });
    return api.item();
  },
  /** Après un rechargement : recharge l'index, la reprise part toute seule. */
  async resume(file: string, size: number, limit: number | null = null) {
    manager = build(file, size, limit);
    await manager.init();
    return api.item();
  },
  item: () => view(manager?.get('tt0000001')),
  list: () => manager?.list().map(view) ?? [],
  setLimit: (bytes: number | null) => manager?.setLimit(bytes),
  retry: () => manager?.retry('tt0000001'),
  resumeItem: () => manager?.resume('tt0000001'),
  pause: () => manager?.pause('tt0000001'),
  verify: (size?: number) => verify('tt0000001', size),
  /** Octets que le magasin dit avoir, sans ouvrir de fichier. */
  storedSize: () => store.size('tt0000001'),
  info: () => store.info(),
  usage: () => store.usage(),
  message: (code: Parameters<typeof webDownloadErrorMessage>[0]) => webDownloadErrorMessage(code),
  events: () => events.slice(),
  online: () => navigator.onLine,
};

(window as unknown as { __d: typeof api }).__d = api;
