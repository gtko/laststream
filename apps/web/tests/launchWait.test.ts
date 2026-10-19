import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { awaitLaunchable, clearSourceCache, loadSources, type LoadedSources, type SourceRequest } from '../src/sources/load';
import { describeLaunch, isGoodMatch, recommend } from '../src/sources/rank';
import type { SourceView } from '../src/sources/info';

const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/play/c/' + n,
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50 + n, estBitrateKbps: 5000, ...extra },
});

/** 720p non cachée : une source lisible, mais pas une « bonne correspondance ». */
const MEH = (n: number) => stream(n, { cached: false, resolution: '720p', height: 720 });

const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };

interface SimAddon {
  name: string;
  /** Instant (ms depuis le début du test) où l'addon répond. */
  at: number;
  streams: unknown[];
}

/** Faux lastAddon à horloge simulée : un addon dont l'instant de réponse est passé apparaît dans la liste, les autres sont en attente. */
function simulatedAddons(addons: SimAddon[]) {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const state = () => {
    const done = addons.filter((a) => elapsed() >= a.at);
    return { streams: done.flatMap((a) => a.streams), pending: addons.filter((a) => elapsed() < a.at).map((a) => a.name) };
  };
  const statusCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const s = state();
    if (url.includes('/lt/streams/status/')) {
      statusCalls.push(url);
      return new Response(JSON.stringify({ pending: s.pending, count: s.streams.length }), { status: 200 });
    }
    return new Response(JSON.stringify({ streams: s.streams, ...(s.pending.length ? { pending: s.pending } : {}) }), { status: 200 });
  }));
  return { start, statusCalls };
}

const readable = (views: readonly SourceView[]) => views.some((v) => v.playable && !v.client);
const pick = (views: readonly SourceView[]) => recommend(views, null, 'fr');
const good = (rec: ReturnType<typeof pick>) => isGoodMatch(rec);

/** Lance l'attente, avance l'horloge simulée, et renvoie le choix avec l'instant (depuis le début) où il a été rendu. */
async function launchAt(first: LoadedSources, start: number, horizonMs: number) {
  let doneAt = -1;
  const promise = awaitLaunchable(first, { request: REQ, since: start, readable, recommend: pick, good }).then((choice) => {
    doneAt = Date.now() - start;
    return choice;
  });
  await vi.advanceTimersByTimeAsync(horizonMs);
  const choice = await promise;
  return { choice, doneAt };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings();
  clearCache();
  clearSourceCache();
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('lancement sans attendre les addons lents', () => {
  it('une source lisible (720p) : la lecture part après la fenêtre de grâce, avant la réponse du lent', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [MEH(1)] },
      { name: 'loostream', at: 30_000, streams: [stream(2)] },
    ]);
    const first = await loadSources(REQ);
    expect(first.pending).toEqual(['loostream']);
    const { choice, doneAt } = await launchAt(first, sim.start, 10_000);
    expect(doneAt).toBeGreaterThanOrEqual(2_500);
    expect(doneAt).toBeLessThan(3_000);
    expect(choice.rec?.view.stream.url).toBe('https://x/play/c/1');
    expect(choice.loaded.views).toHaveLength(1);
    expect(choice.loaded.pending).toEqual(['loostream']);
    expect(sim.statusCalls.length).toBeGreaterThan(0);
  });

  it('une source qui satisfait les préférences arrivée pendant la fenêtre : lancement tout de suite, la meilleure parmi celles reçues', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [MEH(1)] },
      { name: 'YGG', at: 1_000, streams: [stream(2)] },
      { name: 'loostream', at: 30_000, streams: [MEH(3)] },
    ]);
    const first = await loadSources(REQ);
    const { choice, doneAt } = await launchAt(first, sim.start, 10_000);
    expect(doneAt).toBeLessThan(2_500);
    expect(choice.rec?.view.stream.url).toBe('https://x/play/c/2');
    expect(choice.loaded.views.map((v) => v.stream.url).sort()).toEqual(['https://x/play/c/1', 'https://x/play/c/2']);
  });

  it('préférence satisfaite dès la première liste : aucune attente, aucun sondage', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [stream(1)] },
      { name: 'loostream', at: 30_000, streams: [stream(2)] },
    ]);
    const first = await loadSources(REQ);
    const choice = await awaitLaunchable(first, { request: REQ, since: sim.start, readable, recommend: pick, good });
    expect(Date.now() - sim.start).toBe(0);
    expect(choice.rec?.view.stream.url).toBe('https://x/play/c/1');
    expect(sim.statusCalls).toHaveLength(0);
  });

  it('source lisible tardive (6 s) : délai global de 8 s depuis le début de l’attente', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 6_000, streams: [MEH(1)] },
      { name: 'loostream', at: 30_000, streams: [stream(2)] },
    ]);
    const first = await loadSources(REQ);
    expect(first.views).toHaveLength(0);
    const { choice, doneAt } = await launchAt(first, sim.start, 25_000);
    expect(doneAt).toBeGreaterThanOrEqual(8_000);
    expect(doneAt).toBeLessThan(8_500);
    expect(choice.rec?.view.stream.url).toBe('https://x/play/c/1');
  });

  it('aucune source lisible : on attend le délai existant (20 s), comme avant', async () => {
    const sim = simulatedAddons([{ name: 'loostream', at: 60_000, streams: [stream(1)] }]);
    const first = await loadSources(REQ);
    const { choice, doneAt } = await launchAt(first, sim.start, 40_000);
    expect(doneAt).toBeGreaterThanOrEqual(20_000);
    expect(doneAt).toBeLessThan(20_500);
    expect(choice.rec).toBeNull();
    expect(choice.loaded.pending).toEqual(['loostream']);
  });

  it('« Choisir moi-même » (stop) : l’attente s’arrête dès la pause suivante, sans lancer', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [MEH(1)] },
      { name: 'loostream', at: 30_000, streams: [stream(2)] },
    ]);
    const first = await loadSources(REQ);
    let picked = false;
    setTimeout(() => { picked = true; }, 1_000);
    let doneAt = -1;
    const promise = awaitLaunchable(first, { request: REQ, since: sim.start, readable, recommend: pick, good, stop: () => picked }).then((c) => {
      doneAt = Date.now() - sim.start;
      return c;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const choice = await promise;
    expect(doneAt).toBeGreaterThanOrEqual(1_000);
    expect(doneAt).toBeLessThan(2_500);
    expect(choice.loaded.pending).toEqual(['loostream']);
  });
});

describe('libellé du lancement', () => {
  it('nomme les addons encore en recherche', () => {
    expect(describeLaunch(10, ['loostream'])).toBe('Lancement avec 10 sources (loostream encore en recherche)');
    expect(describeLaunch(1, ['C411', 'YGG', 'Torrent9'])).toBe('Lancement avec 1 source (C411, YGG et 1 autre encore en recherche)');
  });
});
