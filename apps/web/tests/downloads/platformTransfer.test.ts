// @vitest-environment node
// Transfert de plateforme du gestionnaire (ODY-200) : l'espace occupé suit l'avancement, la limite restante est transmise,
// un dépassement met en pause pour quota.
import { describe, expect, it, vi } from 'vitest';
import { DownloadManager, type TransferFn } from '../../src/downloads/manager';
import { MemoryDownloadIndex } from '../../src/downloads/index';
import { DownloadError, type DownloadStore, type HttpFn, type LinkResolver } from '../../src/downloads/types';

const SOURCE = { copies: [{ infoHash: 'a'.repeat(40) }] };
const REQ = { metaId: 'tt0001', title: 'Film' };
const until = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 5000, interval: 5 });

/** Magasin qui ne garde que des tailles : le transfert de plateforme « écrit » en les modifiant. */
function sizeStore() {
  const sizes = new Map<string, number>();
  const finalized: string[] = [];
  const store: DownloadStore = {
    async open(id) {
      return {
        size: async () => sizes.get(id) ?? 0,
        write: async () => {
          throw new Error('écriture JS inattendue');
        },
        truncate: async (len) => void sizes.set(id, len),
        finalize: async () => void finalized.push(id),
        close: async () => undefined,
      };
    },
    size: async (id) => sizes.get(id) ?? 0,
    remove: async (id) => void sizes.delete(id),
    usage: async () => ({ used: [...sizes.values()].reduce((a, b) => a + b, 0) }),
  };
  return { store, sizes, finalized };
}

function setup(transfer: TransferFn, limitBytes?: number) {
  const st = sizeStore();
  const resolver: LinkResolver = { resolve: async () => ({ url: 'https://cdn.example.test/film.mkv', size: 1000 }) };
  const http: HttpFn = async () => {
    throw new Error('http ne doit pas servir avec un transfert de plateforme');
  };
  const manager = new DownloadManager({
    resolver,
    http,
    store: st.store,
    index: new MemoryDownloadIndex(),
    transfer,
    limitBytes,
    sleep: async () => undefined,
  });
  return { manager, ...st };
}

describe('DownloadManager : transfert de plateforme', () => {
  it('le transfert écrit le fichier, reçoit id et titre, et le gestionnaire finalise', async () => {
    const seen: Array<{ id: string; title: string; url: string; maxBytes?: number }> = [];
    let st!: ReturnType<typeof setup>;
    const transfer: TransferFn = async (p, item) => {
      seen.push({ ...item, url: p.url, maxBytes: p.maxBytes });
      st.sizes.set(item.id, 400);
      await p.onProgress({ bytesDone: 400, bytesTotal: 1000 });
      st.sizes.set(item.id, 1000);
      return { bytesDone: 1000, bytesTotal: 1000, etag: '"e"' };
    };
    st = setup(transfer);
    await st.manager.init();
    const item = await st.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(st.manager.get(item.id)?.state).toBe('done'));

    expect(seen).toEqual([{ id: 'tt0001', title: 'Film', url: 'https://cdn.example.test/film.mkv', maxBytes: undefined }]);
    expect(st.finalized).toEqual(['tt0001']);
    expect(st.manager.get(item.id)).toMatchObject({ bytesDone: 1000, bytesTotal: 1000, etag: '"e"' });
    expect((await st.manager.space()).used).toBe(1000);
  });

  it('l’espace occupé suit l’avancement du transfert (il n’a pas besoin de sink.write)', async () => {
    let st!: ReturnType<typeof setup>;
    let usedDuring = -1;
    const transfer: TransferFn = async (p, item) => {
      st.sizes.set(item.id, 600);
      await p.onProgress({ bytesDone: 600, bytesTotal: 1000 });
      usedDuring = (await st.manager.space()).used;
      st.sizes.set(item.id, 1000);
      return { bytesDone: 1000, bytesTotal: 1000 };
    };
    st = setup(transfer);
    await st.manager.init();
    const item = await st.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(st.manager.get(item.id)?.state).toBe('done'));
    expect(usedDuring).toBe(600);
  });

  it('la limite restante est transmise, et quota_exceeded met en pause avec ce code', async () => {
    const maxes: Array<number | undefined> = [];
    const transfer: TransferFn = async (p) => {
      maxes.push(p.maxBytes);
      throw new DownloadError('quota_exceeded', false);
    };
    const st = setup(transfer, 800);
    await st.manager.init();
    const item = await st.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(st.manager.get(item.id)?.state).toBe('paused'));

    expect(maxes).toEqual([800]);
    expect(st.manager.get(item.id)?.error?.code).toBe('quota_exceeded');
  });

  it('une reprise transmet limite moins espace déjà occupé par les autres fichiers', async () => {
    const maxes: Array<number | undefined> = [];
    let st!: ReturnType<typeof setup>;
    const transfer: TransferFn = async (p, item) => {
      maxes.push(p.maxBytes);
      st.sizes.set(item.id, 700);
      return { bytesDone: 700, bytesTotal: 700 };
    };
    st = setup(transfer, 1000);
    st.sizes.set('autre', 300);
    st.sizes.set('tt0001', 200); // déjà 200 octets de ce fichier
    await st.manager.init();
    const item = await st.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(st.manager.get(item.id)?.state).toBe('done'));
    // Limite 1000, occupé 500 (300 + 200) : ce fichier peut atteindre 200 + 500 = 700.
    expect(maxes).toEqual([700]);
  });

  it('les autres erreurs gardent leur code', async () => {
    const transfer: TransferFn = async () => {
      throw new DownloadError('store_full', false);
    };
    const st = setup(transfer);
    await st.manager.init();
    const item = await st.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(st.manager.get(item.id)?.state).toBe('error'));
    expect(st.manager.get(item.id)?.error?.code).toBe('store_full');
  });
});
