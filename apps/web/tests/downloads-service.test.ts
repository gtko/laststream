// Service des téléchargements (ODY-204) : disponibilité, file, choix du flux, quota, feuille, abonnement, purge.
// Le magasin et le transfert sont fournis par registerDownloadPlatform ; les sources du titre sont simulées ; aucun OPFS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferFn } from '../src/downloads/manager';
import {
  downloadIdFor, getSpace, listDownloads, listSourceChoices, platformAvailability, purgeAll, recommendedChoice, registerDownloadPlatform,
  requestDownload, resetDownloadsForTests, subscribeDownloads, type DownloadTarget,
} from '../src/downloads/service';
import { getDownloadSettings, setDownloadSettings } from '../src/downloads/settings';
import { DownloadError, type DownloadStore, type SpaceInfo } from '../src/downloads/types';
import type { SourceView } from '../src/sources/info';
import { HLS_URL, HTTP_URL, httpStream, viewOf } from './downloads-fixtures';

const GB = 1024 ** 3;
const MOVIE: DownloadTarget = { key: 'movie:693134', type: 'movie', id: '693134', name: 'Dune' };

// État partagé avec les fausses dépendances (hissé pour les fabriques de vi.mock).
const state = vi.hoisted(() => ({
  shell: false,
  views: [] as SourceView[],
  loadCalls: 0,
  index: null as null | { all(): Promise<unknown[]> },
}));

vi.mock('../src/player/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/player/shell')>();
  return { ...actual, isShellEnvironment: () => state.shell };
});

vi.mock('../src/sources/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/load')>();
  const loaded = async () => {
    state.loadCalls += 1;
    return { imdb: 'tt1', views: state.views, pending: [] };
  };
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
  return {
    ...actual,
    createDownloadIndex: () => {
      const idx = new actual.MemoryDownloadIndex();
      state.index = idx;
      return idx;
    },
  };
});

let transfers: Array<{ url: string }> = [];
let removed: string[] = [];

function fakeStore(opts: { removeFails?: boolean } = {}): DownloadStore {
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
      if (opts.removeFails) throw new Error('disque indisponible');
    },
    usage: async () => ({ used: 0 }),
  };
}

/** Transfert qui n'aboutit jamais : il attend l'annulation (pause ou suppression). Note le lien reçu, en mémoire seulement. */
const waitingTransfer: TransferFn = (p) => {
  transfers.push({ url: p.url });
  return new Promise((_, reject) => {
    p.signal.addEventListener('abort', () => reject(new DownloadError('cancelled', false)));
  });
};

beforeEach(() => {
  localStorage.clear();
  state.shell = false;
  state.views = [];
  state.loadCalls = 0;
  state.index = null;
  transfers = [];
  removed = [];
  resetDownloadsForTests();
});

afterEach(async () => {
  await purgeAll();
  resetDownloadsForTests();
  localStorage.clear();
});

describe('disponibilité', () => {
  it('navigateur sans stockage : indisponible, avec une raison lisible', () => {
    const a = platformAvailability();
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason.length).toBeGreaterThan(10);
  });

  it('coque Windows : disponible, le magasin de la coque (ODY-201) sert par défaut', () => {
    state.shell = true;
    expect(platformAvailability()).toEqual({ ok: true });
  });

  it('une plateforme enregistrée rend le service disponible', () => {
    state.shell = true;
    registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
    expect(platformAvailability()).toEqual({ ok: true });
  });
});

describe('ajout à la file', () => {
  beforeEach(() => {
    registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  });

  it('film : référence du flux, taille estimée, et aucune URL dans l’index', async () => {
    state.views = [viewOf(httpStream({ origin: 'Lumio', filename: 'Dune.2021.mkv', size: 2 * GB }))];
    const item = await requestDownload(MOVIE);
    expect(item.id).toBe(downloadIdFor(MOVIE));
    expect(item.id).toBe('movie:693134');
    expect(item.source.copies).toEqual([]);
    expect(item.source.ref?.match).toMatchObject({ filename: 'Dune.2021.mkv', size: 2 * GB, addon: 'Lumio' });
    expect(item.estimatedSize).toBe(2 * GB);
    // Le lien arrive au transfert, en mémoire ; l'index n'en garde rien.
    await vi.waitFor(() => expect(transfers).toEqual([{ url: HTTP_URL }]));
    const serialized = JSON.stringify(await state.index?.all());
    expect(serialized).toContain('Dune.2021.mkv');
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('apikey');
  });

  it('choix de qualité et de langues : pris en compte, puis mémorisés', async () => {
    state.views = [
      viewOf(httpStream({ resolution: '720p', languages: ['en'], filename: 'a.mkv', size: GB }), 0),
      viewOf(httpStream({ resolution: '1080p', languages: ['fr'], filename: 'b.mkv', size: 2 * GB }), 1),
    ];
    const item = await requestDownload(MOVIE, { quality: '1080p', langs: ['fr'] });
    expect(item.source.ref?.match.filename).toBe('b.mkv');
    expect(item.source.quality).toBe('1080p');
    expect(getDownloadSettings()).toMatchObject({ quality: '1080p', langs: ['fr'] });
  });

  it('flux HLS seul : erreur « content », rien n’est ajouté', async () => {
    state.views = [viewOf(httpStream({ url: HLS_URL }))];
    await expect(requestDownload(MOVIE)).rejects.toMatchObject({ code: 'content' });
    expect(listDownloads()).toEqual([]);
  });

  it('hors Wi-Fi seulement sur connexion mobile : refus réseau, aucun chargement des sources', async () => {
    setDownloadSettings({ wifiOnly: true });
    Object.defineProperty(navigator, 'connection', { value: { type: 'cellular' }, configurable: true });
    try {
      await expect(requestDownload(MOVIE)).rejects.toMatchObject({ code: 'network' });
      expect(state.loadCalls).toBe(0);
    } finally {
      Reflect.deleteProperty(navigator, 'connection');
    }
  });

  it('limite d’espace dépassée : refus avant d’ajouter', async () => {
    setDownloadSettings({ limitBytes: GB });
    state.views = [viewOf(httpStream({ filename: 'gros.mkv', size: 2 * GB }))];
    await expect(requestDownload(MOVIE)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(listDownloads()).toEqual([]);
  });
});

describe('feuille des choix', () => {
  beforeEach(() => {
    registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  });

  it('une entrée par source téléchargeable, classées par résolution puis langue, sans flux HLS', async () => {
    state.views = [
      viewOf(httpStream({ resolution: '720p', languages: ['en'], filename: 'a', size: GB }), 0),
      viewOf(httpStream({ resolution: '1080p', languages: ['en'], filename: 'b', size: 2 * GB }), 1),
      viewOf(httpStream({ resolution: '1080p', languages: ['fr'], filename: 'c', size: 3 * GB }), 2),
      viewOf(httpStream({ resolution: '2160p', languages: ['fr'], url: HLS_URL, filename: 'd' }), 3),
    ];
    const choices = await listSourceChoices(MOVIE);
    expect(choices.map((c) => [c.key, c.group, c.sizeBytes])).toEqual([
      ['2', '1080p', 3 * GB], // le français passe avant la version anglaise, à résolution égale
      ['1', '1080p', 2 * GB],
      ['0', '720p', GB],
    ]);
  });

  it('aucun sondage : une seule recherche, et la liste gardée sert à « autre source »', async () => {
    state.views = [
      viewOf(httpStream({ resolution: '1080p', filename: 'a.mkv', size: GB, origin: 'Lumio' }), 0),
      viewOf(httpStream({ resolution: '720p', filename: 'b.mkv', size: GB / 2 }), 1),
    ];
    const first = await listSourceChoices(MOVIE);
    expect(first).toHaveLength(2);
    expect(state.loadCalls).toBe(1);
    const next = await listSourceChoices(MOVIE, { exclude: { filename: 'a.mkv', size: GB, addon: 'Lumio' } });
    expect(next.map((c) => c.key)).toEqual(['1']);
    expect(state.loadCalls).toBe(1);
  });

  it('source choisie : lancée telle quelle (pas la mieux classée), et mémorisée', async () => {
    state.views = [
      viewOf(httpStream({ resolution: '1080p', languages: ['fr'], filename: 'a.mkv', size: 4 * GB }), 0),
      viewOf(httpStream({ resolution: '720p', languages: ['en'], filename: 'b.mkv', size: GB }), 1),
    ];
    const choices = await listSourceChoices(MOVIE);
    const item = await requestDownload(MOVIE, { source: choices[1] });
    expect(item.source.ref?.match.filename).toBe('b.mkv');
    expect(item.estimatedSize).toBe(GB);
    expect(getDownloadSettings()).toMatchObject({ quality: '720p', langs: ['en'] });
  });

  it('présélection : qualité mémorisée si elle existe, sinon la meilleure ; jamais une source plus grosse que l’espace libre', async () => {
    state.views = [
      viewOf(httpStream({ resolution: '2160p', filename: 'a', size: 20 * GB }), 0),
      viewOf(httpStream({ resolution: '1080p', filename: 'b', size: 4 * GB }), 1),
      viewOf(httpStream({ resolution: '720p', filename: 'c', size: GB }), 2),
    ];
    const choices = await listSourceChoices(MOVIE);
    expect(recommendedChoice(choices, null)?.group).toBe('2160p');
    expect(recommendedChoice(choices, 10 * GB)?.group).toBe('1080p');
    expect(recommendedChoice(choices, GB / 2)).toBeNull();
    setDownloadSettings({ quality: '720p' });
    expect(recommendedChoice(choices, null)?.group).toBe('720p');
    setDownloadSettings({ quality: '2160p' });
    expect(recommendedChoice(choices, 10 * GB)?.group).toBe('1080p'); // la mémorisée ne tient pas : repli sur ce qui tient
  });
});

describe('liens hors de la politique web', () => {
  beforeEach(() => {
    // Sans transfert de plateforme : c'est le transport web, donc les hôtes publics https seulement.
    resetDownloadsForTests();
    registerDownloadPlatform({ store: fakeStore() });
  });

  it('un flux http:// ou une adresse IP est exclu de la feuille et de la file', async () => {
    state.views = [
      viewOf(httpStream({ url: 'http://media.example.test/films/dune.mkv', resolution: '1080p', filename: 'a.mkv', size: GB }), 0),
      viewOf(httpStream({ url: 'https://192.168.1.20/films/dune.mkv', resolution: '720p', filename: 'b.mkv', size: GB }), 1),
      viewOf(httpStream({ url: 'https://localhost:8080/films/dune.mkv', resolution: '2160p', filename: 'c.mkv', size: GB }), 2),
    ];
    expect(await listSourceChoices(MOVIE)).toEqual([]);
    await expect(requestDownload(MOVIE)).rejects.toMatchObject({ code: 'content' });
    expect(listDownloads()).toEqual([]);
    expect(transfers).toEqual([]);
  });
});

describe('abonnement, espace et purge', () => {
  beforeEach(() => {
    registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
  });

  it('abonnement : appel immédiat, puis à chaque ajout ; plus d’appel après désabonnement', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeDownloads((items) => seen.push(items.length));
    expect(seen[0]).toBe(0);
    state.views = [viewOf(httpStream({ filename: 'a.mkv' }))];
    await requestDownload(MOVIE);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1));
    unsubscribe();
    const before = seen.length;
    resetDownloadsForTests();
    expect(seen.length).toBe(before);
  });

  it('espace : la limite choisie est celle du gestionnaire, et son changement est pris en compte', async () => {
    setDownloadSettings({ limitBytes: 5 * GB });
    expect(await getSpace()).toMatchObject({ used: 0, limit: 5 * GB } as Partial<SpaceInfo>);
    setDownloadSettings({ limitBytes: null });
    expect(await getSpace()).toMatchObject({ limit: null });
  });

  it('purge : tout est retiré (fichier et index) ; une erreur du magasin ne fait rien lever', async () => {
    resetDownloadsForTests();
    registerDownloadPlatform({ store: fakeStore({ removeFails: true }), transfer: waitingTransfer });
    state.views = [viewOf(httpStream({ filename: 'a.mkv' }))];
    await requestDownload(MOVIE);
    await expect(purgeAll()).resolves.toBeUndefined();
    expect(listDownloads()).toEqual([]);
    expect(removed).toEqual(['movie:693134']);
    expect(await state.index?.all()).toEqual([]);
  });
});
