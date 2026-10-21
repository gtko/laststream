// @vitest-environment node
// Socle Android (ODY-200) : magasin et transfert du plugin natif `LaststreamDownloads`, simulés en mémoire (pas de Capacitor).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: true, platform: 'android', available: true, throws: false }));
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({}),
  Capacitor: {
    isNativePlatform: () => cap.native,
    getPlatform: () => cap.platform,
    isPluginAvailable: () => {
      if (cap.throws) throw new Error('Capacitor indisponible');
      return cap.available;
    },
  },
}));

import { isAndroidDownloads, type LaststreamDownloadsPlugin, type NativeDownloadProgress } from '../../src/downloads/androidPlugin';
import { androidLocalFile, createAndroidStore } from '../../src/downloads/androidStore';
import { createAndroidTransfer } from '../../src/downloads/androidTransfer';
import { createAndroidDownloads } from '../../src/downloads/android';
import { DownloadManager, type TransferFn } from '../../src/downloads/manager';
import { MemoryDownloadIndex } from '../../src/downloads/index';
import {
  DownloadError,
  type DownloadSink,
  type HttpFn,
  type LinkResolver,
  type TransferParams,
  type TransferProgress,
} from '../../src/downloads/types';

const ID = 'tt0001';
const URL_LINK = 'https://cdn.example.test/film.mkv?token=secret';
const DEFAULT_CAP = { native: true, platform: 'android', available: true, throws: false };
const SOURCE = { copies: [{ infoHash: 'a'.repeat(40) }] };
const until = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 5000, interval: 5 });
const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** Erreur telle que la lève le plugin : un `code`, et parfois un message (qui peut citer une URL). */
function nativeErr(code: string, message: string = code): Error {
  return Object.assign(new Error(message), { code });
}

/** Attend une erreur du socle et la renvoie ; échoue si la promesse se résout. */
async function failure(p: Promise<unknown>): Promise<DownloadError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DownloadError) return err;
    throw err;
  }
  throw new Error('aucune erreur levée');
}

/** Plugin simulé : fichiers en mémoire, écouteurs réels (pour vérifier leur retrait), chaque méthode est un espion. */
function fakeNative() {
  const files = new Map<string, Uint8Array>();
  const finalized = new Set<string>();
  const listeners = new Set<(ev: NativeDownloadProgress) => void>();

  const resize = (id: string, len: number): void => {
    const cur = files.get(id) ?? new Uint8Array(0);
    const next = new Uint8Array(len);
    next.set(cur.subarray(0, Math.min(len, cur.length)));
    files.set(id, next);
  };
  const writeAt = (id: string, offset: number, bytes: Uint8Array): void => {
    const end = offset + bytes.length;
    if ((files.get(id)?.length ?? 0) < end) resize(id, end);
    files.get(id)?.set(bytes, offset);
  };

  return {
    listeners,
    /** Contenu actuel du fichier, ou undefined. */
    read: (id: string): Uint8Array | undefined => files.get(id),
    /** Simule l'écriture native : le fichier atteint `len` octets. */
    fill: resize,
    /** Émet un évènement `progress` à tous les écouteurs. */
    emit: (id: string, p: Omit<NativeDownloadProgress, 'id'>): void => {
      for (const fn of [...listeners]) fn({ id, ...p });
    },
    start: vi.fn<LaststreamDownloadsPlugin['start']>(async () => ({ bytesDone: 0 })),
    cancel: vi.fn<LaststreamDownloadsPlugin['cancel']>(async () => undefined),
    size: vi.fn<LaststreamDownloadsPlugin['size']>(async ({ id }) => ({ size: files.get(id)?.length ?? 0 })),
    truncate: vi.fn<LaststreamDownloadsPlugin['truncate']>(async ({ id, len }) => resize(id, len)),
    write: vi.fn<LaststreamDownloadsPlugin['write']>(async ({ id, offset, data }) => writeAt(id, offset, fromBase64(data))),
    finalize: vi.fn<LaststreamDownloadsPlugin['finalize']>(async ({ id }) => {
      finalized.add(id);
    }),
    remove: vi.fn<LaststreamDownloadsPlugin['remove']>(async ({ id }) => {
      files.delete(id);
      finalized.delete(id);
    }),
    usage: vi.fn<LaststreamDownloadsPlugin['usage']>(async () => ({
      used: [...files.values()].reduce((sum, f) => sum + f.length, 0),
      available: 10_000,
    })),
    localPath: vi.fn<LaststreamDownloadsPlugin['localPath']>(async ({ id }) => {
      if (!finalized.has(id)) throw nativeErr('not_found');
      return { path: `/data/${id}`, uri: `file:///data/${id}` };
    }),
    requestNotifications: vi.fn<LaststreamDownloadsPlugin['requestNotifications']>(async () => ({ granted: true })),
    addListener: vi.fn<LaststreamDownloadsPlugin['addListener']>(async (_event, fn) => {
      listeners.add(fn);
      return {
        remove: async () => {
          listeners.delete(fn);
        },
      };
    }),
  };
}

let native: ReturnType<typeof fakeNative>;

beforeEach(() => {
  Object.assign(cap, DEFAULT_CAP);
  native = fakeNative();
});

const NO_HTTP: HttpFn = async () => {
  throw new Error('http ne doit pas servir sur Android');
};
const NO_SINK: DownloadSink = {
  size: async () => 0,
  write: async () => undefined,
  truncate: async () => undefined,
  finalize: async () => undefined,
  close: async () => undefined,
};

/** Appel de transfert avec des paramètres par défaut, surchargés au besoin. */
function call(transfer: TransferFn, over: Partial<TransferParams> = {}): Promise<TransferProgress> {
  return transfer(
    { http: NO_HTTP, sink: NO_SINK, url: URL_LINK, chunkSize: 8, signal: new AbortController().signal, onProgress: () => undefined, ...over },
    { id: ID, title: 'Film' },
  );
}

describe('isAndroidDownloads', () => {
  it('vrai sur Android natif avec le plugin', () => {
    expect(isAndroidDownloads()).toBe(true);
  });

  it('faux hors Android, hors application native, sans plugin, ou si Capacitor échoue', () => {
    cap.platform = 'web';
    expect(isAndroidDownloads()).toBe(false);
    cap.platform = 'ios';
    expect(isAndroidDownloads()).toBe(false);
    cap.platform = 'android';
    cap.native = false;
    expect(isAndroidDownloads()).toBe(false);
    cap.native = true;
    cap.available = false;
    expect(isAndroidDownloads()).toBe(false);
    cap.available = true;
    cap.throws = true;
    expect(isAndroidDownloads()).toBe(false);
  });
});

describe('magasin Android', () => {
  it('cycle complet : écriture, taille, troncature, usage, finalisation, suppression', async () => {
    const store = createAndroidStore(native);
    const sink = await store.open(ID);
    await sink.write(0, Uint8Array.of(1, 2, 3));
    expect(native.write).toHaveBeenCalledWith({ id: ID, offset: 0, data: 'AQID' });
    expect(await sink.size()).toBe(3);
    expect(await store.size(ID)).toBe(3);
    await sink.truncate(2);
    expect(native.truncate).toHaveBeenCalledWith({ id: ID, len: 2 });
    expect(await store.size(ID)).toBe(2);
    expect(await store.usage()).toEqual({ used: 2, available: 10_000 });
    await sink.finalize();
    expect(native.finalize).toHaveBeenCalledWith({ id: ID });
    await sink.close();
    await store.remove(ID);
    expect(native.remove).toHaveBeenCalledWith({ id: ID });
    expect(await store.size(ID)).toBe(0);
    expect(await store.usage()).toEqual({ used: 0, available: 10_000 });
  });

  it('encode en base64 un morceau de plus de 32 Ko sans le perdre', async () => {
    const sink = await createAndroidStore(native).open(ID);
    const chunk = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => i % 251);
    await sink.write(0, chunk);
    expect(native.read(ID)).toEqual(chunk);
  });

  it('erreurs du plugin : store_full, sinon store_failed, sans jamais reprendre l’URL', async () => {
    const store = createAndroidStore(native);
    const sink = await store.open(ID);

    native.write.mockRejectedValueOnce(nativeErr('store_full', `plein pour ${URL_LINK}`));
    const full = await failure(sink.write(0, Uint8Array.of(1)));
    expect(full).toBeInstanceOf(DownloadError);
    expect(full.code).toBe('store_full');
    expect(full.retryable).toBe(false);
    expect(JSON.stringify(full)).not.toContain('cdn.example.test');

    native.write.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(sink.write(0, Uint8Array.of(1)))).code).toBe('store_failed');
    native.truncate.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(sink.truncate(0))).code).toBe('store_failed');
    native.finalize.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(sink.finalize())).code).toBe('store_failed');
    native.size.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(store.size(ID))).code).toBe('store_failed');
    native.usage.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(store.usage())).code).toBe('store_failed');
    native.remove.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(store.remove(ID))).code).toBe('store_failed');
  });

  it('taille d’un fichier absent : 0 ; supprimer un fichier absent : sans erreur', async () => {
    const store = createAndroidStore(native);
    native.size.mockRejectedValueOnce(nativeErr('not_found'));
    expect(await store.size(ID)).toBe(0);
    native.remove.mockRejectedValueOnce(nativeErr('not_found'));
    await expect(store.remove(ID)).resolves.toBeUndefined();
  });

  it('localPath : null tant que le fichier n’est pas finalisé, sinon chemin et URI', async () => {
    const store = createAndroidStore(native);
    expect(await androidLocalFile(ID, native)).toBeNull();
    const sink = await store.open(ID);
    await sink.write(0, Uint8Array.of(1));
    await sink.finalize();
    expect(await androidLocalFile(ID, native)).toEqual({ path: `/data/${ID}`, uri: `file:///data/${ID}` });
  });

  it('localPath : une autre erreur devient store_failed', async () => {
    native.localPath.mockRejectedValueOnce(nativeErr('io'));
    expect((await failure(androidLocalFile(ID, native))).code).toBe('store_failed');
  });
});

describe('transfert Android', () => {
  it('renvoie l’avancement final et transmet les paramètres au plugin', async () => {
    native.start.mockResolvedValueOnce({ bytesDone: 1000, bytesTotal: 1000, etag: '"e"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' });
    const res = await call(createAndroidTransfer(native), { bytesTotal: 1000, etag: '"old"', maxBytes: 500 });
    expect(native.start).toHaveBeenCalledWith({ id: ID, url: URL_LINK, title: 'Film', bytesTotal: 1000, etag: '"old"', maxBytes: 500 });
    expect(res).toEqual({ bytesDone: 1000, bytesTotal: 1000, etag: '"e"', lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' });
  });

  it('relaie la progression du seul identifiant demandé', async () => {
    const seen: TransferProgress[] = [];
    native.start.mockImplementationOnce(async () => {
      native.emit('autre', { bytesDone: 1, bytesTotal: 10 });
      native.emit(ID, { bytesDone: 400, bytesTotal: 1000, etag: '"e"' });
      return { bytesDone: 1000 };
    });
    await call(createAndroidTransfer(native), {
      onProgress: (p) => {
        seen.push(p);
      },
    });
    expect(seen).toEqual([{ bytesDone: 400, bytesTotal: 1000, etag: '"e"' }]);
  });

  it('un rappel de progression en échec n’interrompt pas le transfert', async () => {
    native.start.mockImplementationOnce(async () => {
      native.emit(ID, { bytesDone: 1, bytesTotal: 2 });
      return { bytesDone: 2 };
    });
    const res = await call(createAndroidTransfer(native), {
      onProgress: () => {
        throw new Error('rappel défaillant');
      },
    });
    expect(res.bytesDone).toBe(2);
  });

  it('demande les notifications une seule fois, sans attendre la réponse', async () => {
    native.requestNotifications.mockImplementation(() => new Promise<{ granted: boolean }>(() => undefined));
    const transfer = createAndroidTransfer(native);
    await call(transfer);
    await call(transfer);
    expect(native.requestNotifications).toHaveBeenCalledTimes(1);
  });

  it('une demande de notifications en erreur ne bloque pas le transfert', async () => {
    native.requestNotifications.mockRejectedValueOnce(nativeErr('denied'));
    await expect(call(createAndroidTransfer(native))).resolves.toMatchObject({ bytesDone: 0 });
  });

  it('annulation : cancel est appelé pour cet identifiant et le transfert lève cancelled', async () => {
    native.start.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          native.cancel.mockImplementationOnce(async () => {
            reject(nativeErr('cancelled'));
          });
        }),
    );
    const ctl = new AbortController();
    const pending = failure(call(createAndroidTransfer(native), { signal: ctl.signal }));
    await until(() => expect(native.start).toHaveBeenCalled());
    ctl.abort();
    const err = await pending;
    expect(err.code).toBe('cancelled');
    expect(err.retryable).toBe(false);
    expect(native.cancel).toHaveBeenCalledTimes(1);
    expect(native.cancel).toHaveBeenCalledWith({ id: ID });
  });

  it('signal déjà interrompu : cancelled, sans rien appeler sur le plugin', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await failure(call(createAndroidTransfer(native), { signal: ctl.signal }));
    expect(err.code).toBe('cancelled');
    expect(native.start).not.toHaveBeenCalled();
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.requestNotifications).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
  });

  const CODE_CASES: Array<[string, boolean]> = [
    ['link_expired', true],
    ['network', true],
    ['content', false],
    ['range_mismatch', false],
    ['quota_exceeded', false],
    ['store_full', false],
    ['store_failed', false],
    ['cancelled', false],
  ];
  it.each(CODE_CASES)('code natif « %s » : erreur de même code, réessayable = %s', async (code, retryable) => {
    native.start.mockRejectedValueOnce(nativeErr(code));
    const err = await failure(call(createAndroidTransfer(native)));
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
  });

  it('code inconnu ou absent : erreur réseau, réessayable', async () => {
    const transfer = createAndroidTransfer(native);
    native.start.mockRejectedValueOnce(nativeErr('inconnu'));
    const unknown = await failure(call(transfer));
    expect(unknown.code).toBe('network');
    expect(unknown.retryable).toBe(true);
    native.start.mockRejectedValueOnce(new Error('sans code'));
    const bare = await failure(call(transfer));
    expect(bare.code).toBe('network');
    expect(bare.retryable).toBe(true);
  });

  it('retire son écouteur après succès, erreur et annulation', async () => {
    const transfer = createAndroidTransfer(native);
    await call(transfer);
    expect(native.listeners.size).toBe(0);

    native.start.mockRejectedValueOnce(nativeErr('network'));
    await failure(call(transfer));
    expect(native.listeners.size).toBe(0);

    native.start.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          native.cancel.mockImplementationOnce(async () => {
            reject(nativeErr('cancelled'));
          });
        }),
    );
    const ctl = new AbortController();
    const pending = failure(call(transfer, { signal: ctl.signal }));
    await until(() => expect(native.listeners.size).toBe(1));
    ctl.abort();
    await pending;
    expect(native.listeners.size).toBe(0);
  });

  it('sans écouteur de progression, le transfert suit quand même', async () => {
    native.addListener.mockRejectedValueOnce(nativeErr('denied'));
    await expect(call(createAndroidTransfer(native))).resolves.toMatchObject({ bytesDone: 0 });
  });

  it('l’URL n’apparaît jamais dans l’erreur, même si le plugin la cite', async () => {
    native.start.mockRejectedValueOnce(nativeErr('network', `coupure sur ${URL_LINK}`));
    const err = await failure(call(createAndroidTransfer(native)));
    expect(err.code).toBe('network');
    expect(err.message).not.toContain('cdn.example.test');
    expect(String(err.cause ?? '')).not.toContain('cdn.example.test');
    expect(JSON.stringify(err)).not.toContain('cdn.example.test');
    expect(JSON.stringify(err)).not.toContain('secret');
  });
});

describe('DownloadManager sur Android', () => {
  const resolver: LinkResolver = { resolve: async () => ({ url: URL_LINK, size: 1000 }) };

  function manager(): DownloadManager {
    const { store, transfer } = createAndroidDownloads(native);
    return new DownloadManager({
      resolver,
      http: NO_HTTP,
      store,
      index: new MemoryDownloadIndex(),
      transfer,
      sleep: async () => undefined,
    });
  }

  it('un transfert qui se termine passe à done, et le plugin finalise le fichier', async () => {
    native.start.mockImplementationOnce(async ({ id }) => {
      native.emit(id, { bytesDone: 400, bytesTotal: 1000 });
      native.fill(id, 1000);
      return { bytesDone: 1000, bytesTotal: 1000, etag: '"e"' };
    });
    const m = manager();
    await m.init();
    const item = await m.enqueue({ metaId: 'tt0001', title: 'Film', source: SOURCE });
    await until(() => expect(m.get(item.id)?.state).toBe('done'));
    expect(native.finalize).toHaveBeenCalledWith({ id: ID });
    expect(m.get(item.id)).toMatchObject({ bytesDone: 1000, bytesTotal: 1000, etag: '"e"' });
    expect(native.start).toHaveBeenCalledWith(expect.objectContaining({ id: ID, url: URL_LINK, title: 'Film' }));
  });

  it('une erreur quota_exceeded du plugin met le téléchargement en pause avec ce code', async () => {
    native.start.mockRejectedValueOnce(nativeErr('quota_exceeded'));
    const m = manager();
    await m.init();
    const item = await m.enqueue({ metaId: 'tt0001', title: 'Film', source: SOURCE });
    await until(() => expect(m.get(item.id)?.state).toBe('paused'));
    expect(m.get(item.id)?.error?.code).toBe('quota_exceeded');
  });
});
