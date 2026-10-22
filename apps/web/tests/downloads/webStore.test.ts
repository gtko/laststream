import { describe, expect, it, vi } from 'vitest';
import type { SegmentBackend } from '../../src/downloads/segmented';
import { DownloadError, type DownloadErrorCode } from '../../src/downloads/types';
import { webDownloadErrorMessage } from '../../src/downloads/webMessages';
import { WebDownloadStore } from '../../src/downloads/webStore';
import type { StorageManagerLike } from '../../src/downloads/webStorage';

/** Contenu déterministe d'un segment écrit. */
const bytesOf = (n: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 5 + 1) % 256);

/** Stockage en mémoire aux mêmes primitives qu'OPFS ou IndexedDB (`SegmentBackend`). */
function memoryBackend(kind: SegmentBackend['kind'] = 'opfs') {
  const files = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  const backend: SegmentBackend = {
    kind,
    list: async (id) =>
      [...(files.get(id)?.entries() ?? [])]
        .sort(([a], [b]) => a - b)
        .map(([start, data]) => ({ start, length: data.length })),
    write: async (id, start, data) => {
      const segments = files.get(id) ?? new Map<number, Uint8Array<ArrayBuffer>>();
      segments.set(start, data.slice());
      files.set(id, segments);
    },
    read: async (id, segment) => new Blob([files.get(id)?.get(segment.start) ?? new Uint8Array(0)]),
    remove: async (id, starts) => {
      if (starts === undefined) files.delete(id);
      else for (const start of starts) files.get(id)?.delete(start);
    },
    usage: async () => {
      let total = 0;
      for (const segments of files.values()) for (const data of segments.values()) total += data.length;
      return total;
    },
  };
  return { backend, files };
}

/** Octets d'un Blob, lus comme dans les autres tests (FileReader, sans décodage de texte). */
const readBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  }).then((buf) => new Uint8Array(buf));

const NO_BACKEND_INFO = { backend: null, usage: null, quota: null, available: null, persisted: null };

describe('WebDownloadStore : aucun stockage disponible', () => {
  it('open lève store_failed sans écrire, et le magasin se signale sans backend', async () => {
    const store = new WebDownloadStore({ detect: async () => null, storage: {} });
    await expect(store.open('a')).rejects.toBeInstanceOf(DownloadError);
    await expect(store.open('a')).rejects.toMatchObject({ code: 'store_failed', retryable: false });
    expect(await store.size('a')).toBe(0);
    expect(await store.usage()).toEqual({ used: 0 });
    expect(await store.file('a')).toBeNull();
    expect(await store.info()).toEqual(NO_BACKEND_INFO);
    await expect(store.remove('a')).resolves.toBeUndefined();
  });

  it('détection qui rejette : identique à l’absence de stockage', async () => {
    const store = new WebDownloadStore({
      detect: async () => {
        throw new Error('navigation privée');
      },
      storage: {},
    });
    await expect(store.open('a')).rejects.toMatchObject({ code: 'store_failed' });
    expect(await store.size('a')).toBe(0);
    expect((await store.info()).backend).toBeNull();
  });

  it('la détection n’est faite qu’une fois, même appelée à plusieurs reprises', async () => {
    const detect = vi.fn(async () => null);
    const store = new WebDownloadStore({ detect, storage: {} });
    await store.size('a');
    await store.usage();
    await store.info();
    await expect(store.open('a')).rejects.toBeInstanceOf(DownloadError);
    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe('WebDownloadStore : avec un stockage', () => {
  it('open, écriture, taille, fichier puis suppression', async () => {
    const { backend } = memoryBackend();
    const store = new WebDownloadStore({ detect: async () => backend, storage: {} });
    const sink = await store.open('a');
    expect(await sink.size()).toBe(0);
    await sink.write(0, bytesOf(10));
    await sink.close();
    expect(await store.size('a')).toBe(10);

    const file = await store.file('a');
    expect(file).not.toBeNull();
    expect(file?.size).toBe(10);
    expect(await readBytes(file as Blob)).toEqual(bytesOf(10));

    await store.remove('a');
    expect(await store.size('a')).toBe(0);
    expect(await store.file('a')).toBeNull();
  });

  it('une nouvelle ouverture reprend au point déjà écrit', async () => {
    const { backend } = memoryBackend();
    const store = new WebDownloadStore({ detect: async () => backend, storage: {} });
    await (await store.open('a')).write(0, bytesOf(10));
    const sink = await store.open('a');
    expect(await sink.size()).toBe(10);
    await sink.write(10, bytesOf(5));
    expect(await store.size('a')).toBe(15);
  });

  it('usage : octets occupés, et espace disponible quand le navigateur l’estime', async () => {
    const { backend } = memoryBackend();
    const storage: StorageManagerLike = { estimate: async () => ({ usage: 10, quota: 100 }) };
    const store = new WebDownloadStore({ detect: async () => backend, storage });
    await (await store.open('a')).write(0, bytesOf(10));
    expect(await store.usage()).toEqual({ used: 10, available: 90 });
  });

  it('usage sans estimation du navigateur : seulement les octets occupés', async () => {
    const { backend } = memoryBackend();
    const store = new WebDownloadStore({ detect: async () => backend, storage: {} });
    await (await store.open('a')).write(0, bytesOf(10));
    expect(await store.usage()).toEqual({ used: 10 });
  });

  it('info : stockage en service, quota, persistance', async () => {
    const { backend } = memoryBackend('indexeddb');
    const storage: StorageManagerLike = {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => true,
    };
    const store = new WebDownloadStore({ detect: async () => backend, storage });
    expect(await store.info()).toEqual({ backend: 'indexeddb', usage: 10, quota: 100, available: 90, persisted: true });
  });

  it('persistance demandée une seule fois, au premier open, sans attendre sa réponse', async () => {
    const { backend } = memoryBackend();
    const persist = vi.fn(() => new Promise<boolean>(() => {})); // ne se résout jamais
    const storage: StorageManagerLike = { persisted: async () => false, persist };
    const store = new WebDownloadStore({ detect: async () => backend, storage, userGesture: () => true });
    await store.open('a');
    await store.open('b');
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('persistance non demandée sans geste récent (reprise au chargement), puis demandée au premier geste', async () => {
    const { backend } = memoryBackend();
    const persist = vi.fn(async () => true);
    const storage: StorageManagerLike = { persisted: async () => false, persist };
    let gesture = false;
    const store = new WebDownloadStore({ detect: async () => backend, storage, userGesture: () => gesture });
    await store.open('a');
    await new Promise((r) => setTimeout(r, 0));
    expect(persist).not.toHaveBeenCalled();
    gesture = true;
    await store.open('b');
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  });

  it('persist() public : vrai si le navigateur accorde la persistance', async () => {
    const { backend } = memoryBackend();
    const storage: StorageManagerLike = { persisted: async () => false, persist: async () => true };
    const store = new WebDownloadStore({ detect: async () => backend, storage });
    expect(await store.persist()).toBe(true);
  });
});

describe('webDownloadErrorMessage : un message par code', () => {
  // `Record` exige chaque code : un nouveau code sans message ne compile pas.
  const ALL_CODES: Record<DownloadErrorCode, true> = {
    link_expired: true,
    resolve_failed: true,
    account: true,
    content: true,
    network: true,
    range_mismatch: true,
    quota_exceeded: true,
    store_full: true,
    store_failed: true,
    store_denied: true,
    store_folder: true,
    store_timeout: true,
    cancelled: true,
  };

  it.each(Object.keys(ALL_CODES) as DownloadErrorCode[])('%s : message non vide, sans lien', (code) => {
    const message = webDownloadErrorMessage(code);
    expect(message.trim().length).toBeGreaterThan(0);
    expect(message).not.toMatch(/https?:\/\/|apikey|debrid\.example/i);
  });
});
