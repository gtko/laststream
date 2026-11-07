// Purge à la déconnexion (ODY-204) : le marqueur posé par une déconnexion explicite fait effacer les téléchargements du compte
// précédent AVANT toute reprise, même si la page a été rechargée. Une 401 silencieuse ne purge pas.
// L'index est partagé par tout le fichier (il survit aux rechargements simulés, comme IndexedDB) ; aucun OPFS ni Capacitor réel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOut } from '../src/data/auth';
import type { TransferFn } from '../src/downloads/manager';
import {
  getDownloads, listDownloads, purgeAll, registerDownloadPlatform, requestDownload, resetDownloadsForTests, type DownloadTarget,
} from '../src/downloads/service';
import { isPurgePending, markPurgePending } from '../src/downloads/settings';
import { DownloadError, type DownloadStore } from '../src/downloads/types';
import { createDownloadIndex } from '../src/downloads/index';
import type { SourceView } from '../src/sources/info';
import { httpStream, viewOf } from './downloads-fixtures';

const GB = 1024 ** 3;
const MOVIE: DownloadTarget = { key: 'movie:693134', type: 'movie', id: '693134', name: 'Dune' };

const state = vi.hoisted(() => ({ views: [] as SourceView[] }));

vi.mock('../src/sources/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/load')>();
  const loaded = async () => ({ imdb: 'tt1', views: state.views, pending: [] });
  return {
    ...actual,
    loadSources: loaded,
    refreshSources: loaded,
    recommendFor: (views: readonly SourceView[]) => (views.length > 0 ? { view: views[0], languageFallback: false, reason: '' } : null),
    knownBandwidthKbps: () => null,
  };
});

vi.mock('../src/downloads/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/downloads/index')>();
  // Un seul index pour tout le fichier : il survit aux rechargements simulés.
  const shared = new actual.MemoryDownloadIndex();
  return { ...actual, createDownloadIndex: () => shared };
});

vi.mock('../src/data/userApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/userApi')>();
  return { ...real, logout: vi.fn(() => Promise.resolve()) };
});

// Le spion garde le comportement réel : on compte seulement les appels de la déconnexion.
vi.mock('../src/downloads/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/downloads/service')>();
  return { ...actual, purgeAll: vi.fn(actual.purgeAll) };
});

let transfers: Array<{ url: string }> = [];
let removed: string[] = [];

function fakeStore(): DownloadStore {
  return {
    open: async () => ({
      size: async () => 0,
      write: async () => undefined,
      truncate: async () => undefined,
      finalize: async () => undefined,
      close: async () => undefined,
    }),
    size: async () => 0,
    remove: async (id: string) => {
      removed.push(id);
    },
    usage: async () => ({ used: 0 }),
  };
}

/** Transfert qui n'aboutit jamais : il attend l'annulation. Chaque démarrage de transfert est noté. */
const waitingTransfer: TransferFn = (p) => {
  transfers.push({ url: p.url });
  return new Promise((_, reject) => {
    p.signal.addEventListener('abort', () => reject(new DownloadError('cancelled', false)));
  });
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** Rechargement simulé : le gestionnaire disparaît, l'index persiste, la plateforme est enregistrée de nouveau. */
function reload(): void {
  resetDownloadsForTests();
  registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  transfers = [];
  removed = [];
}

beforeEach(() => {
  localStorage.clear();
  state.views = [];
  transfers = [];
  removed = [];
  resetDownloadsForTests();
  registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  vi.mocked(purgeAll).mockClear();
});

afterEach(async () => {
  await purgeAll();
  resetDownloadsForTests();
  localStorage.clear();
});

describe('marqueur de purge au démarrage', () => {
  it('marqueur posé : au démarrage suivant rien ne reprend, le fichier et l’index partent, le marqueur est effacé', async () => {
    state.views = [viewOf(httpStream({ filename: 'a.mkv', size: GB }))];
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    // Déconnexion puis rechargement avant la fin de la purge immédiate.
    markPurgePending();
    reload();
    const m = await getDownloads();
    expect(m?.list()).toEqual([]);
    expect(removed).toEqual(['movie:693134']);
    expect(await createDownloadIndex().all()).toEqual([]);
    expect(isPurgePending()).toBe(false);
    await flush();
    expect(transfers).toEqual([]);
  });

  it('sans marqueur, un téléchargement inachevé reprend au démarrage (témoin)', async () => {
    state.views = [viewOf(httpStream({ filename: 'a.mkv', size: GB }))];
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    reload();
    const m = await getDownloads();
    expect(m?.list()).toHaveLength(1);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
  });

  it('purgeAll sans gestionnaire : construit en mode purge, rien ne reprend, le marqueur est effacé', async () => {
    state.views = [viewOf(httpStream({ filename: 'a.mkv', size: GB }))];
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    reload();
    await purgeAll();
    expect(removed).toEqual(['movie:693134']);
    expect(await createDownloadIndex().all()).toEqual([]);
    expect(listDownloads()).toEqual([]);
    await flush();
    expect(transfers).toEqual([]);
  });
});

describe('le marqueur ne part qu’après la purge de l’index (ODY-233)', () => {
  it('plateforme indisponible + marqueur posé : le marqueur reste', async () => {
    resetDownloadsForTests(); // plus de plateforme enregistrée : jsdom n'a pas de stockage
    markPurgePending();
    await purgeAll();
    expect(isPurgePending()).toBe(true);
    expect(await getDownloads()).toBeNull();
    expect(isPurgePending()).toBe(true);
  });

  it('index qui refuse la suppression : le marqueur reste, rien ne reprend, puis la purge suivante aboutit', async () => {
    state.views = [viewOf(httpStream({ filename: 'a.mkv', size: GB }))];
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    markPurgePending();
    reload();
    const del = vi.spyOn(createDownloadIndex(), 'delete').mockRejectedValue(new Error('index indisponible'));
    expect(await getDownloads()).toBeNull();
    expect(isPurgePending()).toBe(true);
    await flush();
    expect(transfers).toEqual([]);
    expect(await createDownloadIndex().all()).toHaveLength(1);
    // Interruption entre les deux : l'index se rétablit, le démarrage suivant le vide puis efface le marqueur.
    del.mockRestore();
    reload();
    expect((await getDownloads())?.list()).toEqual([]);
    expect(await createDownloadIndex().all()).toEqual([]);
    expect(isPurgePending()).toBe(false);
    await flush();
    expect(transfers).toEqual([]);
  });

  it('index vidé mais marqueur resté (interruption) : le démarrage suivant efface le marqueur sans rien reprendre', async () => {
    markPurgePending();
    reload();
    expect((await getDownloads())?.list()).toEqual([]);
    expect(isPurgePending()).toBe(false);
  });
});

describe('déconnexion et marqueur', () => {
  it('explicite : le marqueur est posé avant le premier await, puis la purge immédiate est tentée', async () => {
    const pending = signOut(false);
    expect(isPurgePending()).toBe(true);
    await pending;
    await vi.waitFor(() => expect(purgeAll).toHaveBeenCalledTimes(1));
  });

  it('401 silencieuse (signOut(true)) : ni marqueur, ni purge', async () => {
    await signOut(true);
    await flush();
    expect(isPurgePending()).toBe(false);
    expect(purgeAll).not.toHaveBeenCalled();
  });
});

describe('lecture hors ligne et marqueur de purge', () => {
  it('marqueur posé : aucune source locale n’est servie au compte suivant', async () => {
    const { offlineSourceFor } = await import('../src/downloads/offline');
    markPurgePending();
    expect(await offlineSourceFor('web', { key: 'movie:693134' })).toBeNull();
  });
});
