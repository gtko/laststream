// Propriétaire des téléchargements (ODY-231) : une 401 suivie d'une reconnexion au même compte garde les fichiers ; un autre compte
// (ou le même pseudo sur un autre serveur) ne les voit ni ne les lit : ils sont effacés, et la lecture hors ligne est bloquée
// dès la connexion. L'index est partagé par tout le fichier (il survit aux rechargements simulés) ; aucun OPFS ni Capacitor réel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/data/userApi';
import { signIn, signOut } from '../src/data/auth';
import { saveSettings } from '../src/data/config';
import type { TransferFn } from '../src/downloads/manager';
import {
  getDownloads, listDownloads, registerDownloadPlatform, requestDownload, resetDownloadsForTests, type DownloadTarget,
} from '../src/downloads/service';
import { claimDownloadsOwner, getDownloadsOwner, isPurgePending, setDownloadsOwner } from '../src/downloads/settings';
import { DownloadError, type DownloadStore } from '../src/downloads/types';
import { createDownloadIndex } from '../src/downloads/index';
import { offlineSourceFor } from '../src/downloads/offline';
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
  const shared = new actual.MemoryDownloadIndex();
  return { ...actual, createDownloadIndex: () => shared };
});

vi.mock('../src/data/userApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/userApi')>();
  return {
    ...real,
    login: vi.fn(() => Promise.resolve({ token: 't', expiresAt: Date.now() + 3_600_000 })),
    logout: vi.fn(() => Promise.resolve()),
    me: vi.fn(() => new Promise(() => undefined)),
    listProfiles: vi.fn(() => Promise.reject(new Error('hors ligne'))),
  };
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

const waitingTransfer: TransferFn = (p) => {
  transfers.push({ url: p.url });
  return new Promise((_, reject) => {
    p.signal.addEventListener('abort', () => reject(new DownloadError('cancelled', false)));
  });
};

/** Connexion puis attente de la fin de l'éventuelle purge de propriétaire. */
async function login(name: string): Promise<void> {
  await signIn(name, 'pw');
  await vi.waitFor(() => expect(isPurgePending()).toBe(false));
}

beforeEach(async () => {
  localStorage.clear();
  saveSettings({ base: 'https://app.laststream.app', mode: 'public' });
  state.views = [viewOf(httpStream({ filename: 'a.mkv', size: GB }))];
  transfers = [];
  removed = [];
  resetDownloadsForTests();
  registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  for (const row of await createDownloadIndex().all()) await createDownloadIndex().delete(row.id);
});

afterEach(async () => {
  await signOut(true);
  resetDownloadsForTests();
  localStorage.clear();
});

describe('même compte', () => {
  it('une 401 suivie d’une reconnexion au même compte garde les téléchargements', async () => {
    await login('Alice');
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    await signOut(true); // 401 silencieuse : ni marqueur ni purge
    expect(isPurgePending()).toBe(false);
    await login('alice');
    expect(isPurgePending()).toBe(false);
    expect(removed).toEqual([]);
    expect((await getDownloads())?.list()).toHaveLength(1);
    expect(await createDownloadIndex().all()).toHaveLength(1);
  });
});

describe('autre compte', () => {
  it('ne voit ni ne lit les fichiers du premier : marqueur posé dès la connexion, liste vide, fichier et index effacés', async () => {
    await login('alice');
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    await signOut(true);

    const pending = signIn('bob', 'pw');
    await pending;
    // Avant même la fin de la purge : lecture hors ligne bloquée et liste masquée.
    expect(isPurgePending()).toBe(true);
    expect(await offlineSourceFor('web', { key: MOVIE.key })).toBeNull();
    expect(listDownloads()).toEqual([]);
    await vi.waitFor(() => expect(isPurgePending()).toBe(false));

    expect(removed).toEqual(['movie:693134']);
    expect(await createDownloadIndex().all()).toEqual([]);
    expect((await getDownloads())?.list()).toEqual([]);
    expect(getDownloadsOwner()).toBe('laststream|bob');
  });

  it('getDownloads attend la fin de la purge : le nouveau compte ne reçoit pas le gestionnaire de l’ancien', async () => {
    await login('alice');
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    await signOut(true);
    await signIn('bob', 'pw');
    const m = await getDownloads();
    expect(m?.list()).toEqual([]);
    expect(removed).toEqual(['movie:693134']);
  });

  it('même pseudo sur un autre serveur : purge', async () => {
    await login('alice');
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    await signOut(true);
    saveSettings({ base: 'https://perso.example.org', mode: 'custom', custom: 'https://perso.example.org' });
    await login('alice');
    expect(removed).toEqual(['movie:693134']);
    expect(await createDownloadIndex().all()).toEqual([]);
    expect(getDownloadsOwner()).toBe('https://perso.example.org|alice');
  });

  it('déconnexion explicite : le propriétaire est oublié avec les fichiers', async () => {
    await login('alice');
    expect(getDownloadsOwner()).toBe('laststream|alice');
    await signOut(false);
    expect(getDownloadsOwner()).toBeNull();
  });
});

describe('claimDownloadsOwner', () => {
  it('même compte : rien à purger, pas de marqueur', () => {
    setDownloadsOwner('laststream|alice');
    expect(claimDownloadsOwner('laststream|alice')).toBe(false);
    expect(isPurgePending()).toBe(false);
  });

  it('sans propriétaire : une session restaurée adopte, une connexion purge (fichiers d’origine inconnue)', () => {
    expect(claimDownloadsOwner('laststream|alice', true)).toBe(false);
    expect(getDownloadsOwner()).toBe('laststream|alice');
    setDownloadsOwner(null);
    expect(claimDownloadsOwner('laststream|alice')).toBe(true);
    expect(isPurgePending()).toBe(true);
  });

  it('compte inconnu (identité vide) : jamais reconnu comme propriétaire, purge', () => {
    setDownloadsOwner('laststream|alice');
    expect(claimDownloadsOwner('', true)).toBe(true);
    expect(getDownloadsOwner()).toBeNull();
    expect(isPurgePending()).toBe(true);
  });

  it('autre compte : marqueur posé et nouveau propriétaire mémorisé', () => {
    setDownloadsOwner('laststream|alice');
    expect(claimDownloadsOwner('laststream|bob')).toBe(true);
    expect(isPurgePending()).toBe(true);
    expect(getDownloadsOwner()).toBe('laststream|bob');
  });
});
