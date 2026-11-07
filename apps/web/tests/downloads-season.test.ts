// Saison entière (ODY-234) : plan puis mise en file en une seule vérification de quota.
// Le magasin et le transfert sont fournis par registerDownloadPlatform ; les sources sont simulées ; aucun OPFS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferFn } from '../src/downloads/manager';
import {
  getDownloads, planSeasonDownload, purgeAll, purgeForOwnerChange, registerDownloadPlatform, requestDownload, requestSeasonDownload,
  resetDownloadsForTests, type DownloadTarget,
} from '../src/downloads/service';
import { setDownloadSettings } from '../src/downloads/settings';
import { DownloadError, type DownloadStore } from '../src/downloads/types';
import type { SourceView } from '../src/sources/info';
import type { SourceRequest } from '../src/sources/load';
import { HLS_URL, httpStream, viewOf } from './downloads-fixtures';

const GB = 1024 ** 3;

// État partagé avec les fausses dépendances (hissé pour les fabriques de vi.mock).
const state = vi.hoisted(() => ({
  shell: false,
  /** Sources de tout épisode sans entrée dans `perEpisode`. */
  views: [] as SourceView[],
  perEpisode: new Map<number, SourceView[]>(),
  /** Épisodes dont le chargement échoue (erreur réseau). */
  failing: new Set<number>(),
  /** Chargement bloqué tant que cette promesse n'est pas résolue. */
  gate: null as null | Promise<void>,
  delayMs: 0,
  /** Épisodes chargés, dans l'ordre des appels (null pour un film). */
  loads: [] as Array<number | null>,
  inFlight: 0,
  maxInFlight: 0,
  index: null as null | { all(): Promise<unknown[]> },
}));

vi.mock('../src/player/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/player/shell')>();
  return { ...actual, isShellEnvironment: () => state.shell };
});

vi.mock('../src/sources/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/load')>();
  const loaded = async (req: SourceRequest) => {
    const ep = req.episode ?? null;
    state.loads.push(ep);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (state.gate) await state.gate;
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (ep !== null && state.failing.has(ep)) throw new Error('réseau coupé');
      const views = (ep !== null && state.perEpisode.get(ep)) || state.views;
      return { imdb: 'tt1', views, pending: [] };
    } finally {
      state.inFlight -= 1;
    }
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

const SERIE = 'tv:1399';
const episode = (n: number, season = 1): DownloadTarget => ({ key: SERIE, type: 'tv', id: '1399', name: 'Game of Thrones', season, episode: n });
const saison = (count: number, season = 1): DownloadTarget[] => Array.from({ length: count }, (_, i) => episode(i + 1, season));
const view = (filename: string, size: number | undefined, resolution: '1080p' | '720p' = '1080p', languages = ['fr']): SourceView =>
  viewOf(httpStream({ resolution, filename, languages, ...(size !== undefined ? { size } : {}) }));

/** Téléchargements présents dans le gestionnaire (état synchrone, sans passer par le cache). */
const enCours = async () => (await getDownloads())?.list() ?? [];

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
    remove: async () => undefined,
    usage: async () => ({ used: 0 }),
  };
}

/** Transfert qui n'aboutit jamais : il attend l'annulation (pause ou suppression). */
const waitingTransfer: TransferFn = (p) =>
  new Promise((_, reject) => {
    p.signal.addEventListener('abort', () => reject(new DownloadError('cancelled', false)));
  });

beforeEach(() => {
  localStorage.clear();
  state.shell = false;
  state.views = [];
  state.perEpisode.clear();
  state.failing.clear();
  state.gate = null;
  state.delayMs = 0;
  state.loads = [];
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.index = null;
  resetDownloadsForTests();
  registerDownloadPlatform({ store: fakeStore(), transfer: waitingTransfer });
});

afterEach(async () => {
  state.gate = null;
  await purgeAll();
  resetDownloadsForTests();
  localStorage.clear();
});

describe('plan de saison : contenu', () => {
  it('somme des tailles connues et nombre d’entrées sans taille', async () => {
    state.views = [view('a.mkv', 2 * GB)];
    state.perEpisode.set(2, [view('b.mkv', GB)]);
    state.perEpisode.set(3, [view('c.mkv', undefined)]);
    const plan = await planSeasonDownload(saison(3));
    expect(plan.entries.map((e) => e.target.episode)).toEqual([1, 2, 3]);
    expect(plan.totalBytes).toBe(3 * GB);
    expect(plan.unknownCount).toBe(1);
    expect(plan.unavailable).toEqual([]);
  });

  it('épisodes déjà présents dans la file : exclus (ni entrées ni indisponibles), non rechargés', async () => {
    state.views = [view('a.mkv', GB)];
    await requestDownload(episode(1));
    state.loads = [];
    const plan = await planSeasonDownload(saison(3));
    expect(plan.entries.map((e) => e.target.episode)).toEqual([2, 3]);
    expect(plan.unavailable).toEqual([]);
    expect(state.loads.sort()).toEqual([2, 3]);
  });

  it('épisode sans source (aucune, ou HLS seul) : indisponible, sans échec global', async () => {
    state.views = [view('a.mkv', GB)];
    state.perEpisode.set(2, []);
    state.perEpisode.set(3, [viewOf(httpStream({ url: HLS_URL, filename: 'hls.m3u8' }))]);
    const plan = await planSeasonDownload(saison(3));
    expect(plan.entries.map((e) => e.target.episode)).toEqual([1]);
    expect(plan.unavailable.map((t) => t.episode)).toEqual([2, 3]);
  });

  it('erreur réseau d’un épisode isolée : indisponible, les autres restent planifiés', async () => {
    state.views = [view('a.mkv', GB)];
    state.failing.add(2);
    const plan = await planSeasonDownload(saison(3));
    expect(plan.entries.map((e) => e.target.episode)).toEqual([1, 3]);
    expect(plan.unavailable.map((t) => t.episode)).toEqual([2]);
  });

  it('doublons dans la liste : un seul plan par épisode', async () => {
    state.views = [view('a.mkv', GB)];
    const plan = await planSeasonDownload([...saison(2), episode(1)]);
    expect(plan.entries.map((e) => e.target.episode)).toEqual([1, 2]);
    expect(state.loads).toHaveLength(2);
  });

  it('classement : la qualité mémorisée est présélectionnée pour chaque épisode', async () => {
    state.views = [view('hd.mkv', 2 * GB, '1080p'), view('sd.mkv', GB, '720p')];
    setDownloadSettings({ quality: '720p' });
    const plan = await planSeasonDownload(saison(2));
    expect(plan.entries.map((e) => e.choice.group)).toEqual(['720p', '720p']);
  });

  it('liste vide : plan vide, sans chargement', async () => {
    const plan = await planSeasonDownload([]);
    expect(plan).toEqual({ entries: [], unavailable: [], totalBytes: 0, unknownCount: 0 });
    expect(state.loads).toEqual([]);
  });

  it('plafond : au-delà de 50 épisodes, les suivants sont indisponibles et ne sont pas chargés', async () => {
    state.views = [view('a.mkv', GB)];
    const plan = await planSeasonDownload(saison(55));
    expect(plan.entries).toHaveLength(50);
    expect(plan.unavailable.map((t) => t.episode)).toEqual([51, 52, 53, 54, 55]);
    expect(state.loads).toHaveLength(50);
    expect(plan.capped).toBe(5); // distincts des épisodes sans source
  });

  it('plafond : un épisode sans source n’est pas compté comme dépassant la limite', async () => {
    state.views = [view('a.mkv', GB)];
    state.perEpisode.set(2, []);
    const plan = await planSeasonDownload(saison(3));
    expect(plan.unavailable).toHaveLength(1);
    expect(plan.capped).toBeUndefined();
  });

  it('signal : fermer la feuille (abort) arrête la résolution des épisodes restants', async () => {
    state.views = [view('a.mkv', GB)];
    state.delayMs = 5;
    const ctl = new AbortController();
    const pending = planSeasonDownload(saison(30), { signal: ctl.signal });
    await new Promise((resolve) => setTimeout(resolve, 8));
    ctl.abort();
    const plan = await pending;
    expect(state.loads.length).toBeLessThan(30);
    expect(plan.entries).toEqual([]);
  });

  it('progression : appelée à chaque épisode traité, jusqu’à total / total', async () => {
    state.views = [view('a.mkv', GB)];
    const calls: Array<[number, number]> = [];
    await planSeasonDownload(saison(5), { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls.map(([done]) => done)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.every(([, total]) => total === 5)).toBe(true);
  });

  it('pas de gestionnaire : store_failed, comme requestDownload', async () => {
    resetDownloadsForTests();
    await expect(planSeasonDownload(saison(2))).rejects.toMatchObject({ code: 'store_failed' });
  });
});

describe('plan de saison : concurrence', () => {
  it('quatre chargements au plus en même temps, les douze épisodes sont chargés', async () => {
    state.views = [view('a.mkv', GB)];
    state.delayMs = 2;
    const plan = await planSeasonDownload(saison(12));
    expect(plan.entries).toHaveLength(12);
    expect(state.loads).toHaveLength(12);
    expect(state.maxInFlight).toBe(4);
  });
});

describe('mise en file de la saison', () => {
  it('chaque entrée du plan devient un téléchargement, avec sa référence de flux', async () => {
    state.views = [view('a.mkv', GB)];
    const plan = await planSeasonDownload(saison(3));
    const items = await requestSeasonDownload(plan);
    expect(items.map((i) => i.id).sort()).toEqual(['tv:1399:1:1', 'tv:1399:1:2', 'tv:1399:1:3']);
    expect(items[0].source.ref?.match.filename).toBe('a.mkv');
    expect((await enCours()).map((i) => i.id).sort()).toEqual(['tv:1399:1:1', 'tv:1399:1:2', 'tv:1399:1:3']);
  });

  it('quota : dépassement sur la somme des tailles, rien n’est ajouté (chaque épisode seul tient)', async () => {
    setDownloadSettings({ limitBytes: 5 * GB });
    state.views = [view('gros.mkv', 2 * GB)];
    const plan = await planSeasonDownload(saison(3));
    await expect(requestSeasonDownload(plan)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await enCours()).toEqual([]);
  });

  it('quota : somme dans la limite, la saison passe', async () => {
    setDownloadSettings({ limitBytes: 5 * GB });
    state.views = [view('gros.mkv', 2 * GB)];
    const plan = await planSeasonDownload(saison(2));
    const items = await requestSeasonDownload(plan);
    expect(items).toHaveLength(2);
  });

  it('Wi-Fi seul sur mobile : refus réseau, aucune mise en file', async () => {
    state.views = [view('a.mkv', GB)];
    const plan = await planSeasonDownload(saison(2));
    setDownloadSettings({ wifiOnly: true });
    Object.defineProperty(navigator, 'connection', { value: { type: 'cellular' }, configurable: true });
    try {
      await expect(requestSeasonDownload(plan)).rejects.toMatchObject({ code: 'network' });
      expect(await enCours()).toEqual([]);
    } finally {
      Reflect.deleteProperty(navigator, 'connection');
    }
  });

  it('plan vide : renvoie [] sans rien mettre en file', async () => {
    const plan = await planSeasonDownload([]);
    await expect(requestSeasonDownload(plan)).resolves.toEqual([]);
    expect(await enCours()).toEqual([]);
  });

  it('purge entre le plan et la mise en file : plan caduc, renvoie []', async () => {
    state.views = [view('a.mkv', GB)];
    const plan = await planSeasonDownload(saison(3));
    expect(plan.entries).toHaveLength(3);
    await purgeAll();
    await expect(requestSeasonDownload(plan)).resolves.toEqual([]);
    expect(await enCours()).toEqual([]);
  });

  it('purge de changement de compte pendant un chargement bloqué : plan vide', async () => {
    state.views = [view('a.mkv', GB)];
    let release: () => void = () => undefined;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = planSeasonDownload(saison(3));
    await vi.waitFor(() => expect(state.loads.length).toBeGreaterThan(0));
    const gate = purgeForOwnerChange();
    release();
    const plan = await pending;
    await gate;
    expect(plan).toEqual({ entries: [], unavailable: [], totalBytes: 0, unknownCount: 0 });
  });
});
