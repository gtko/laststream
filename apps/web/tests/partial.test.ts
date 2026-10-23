import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { clearSourceCache, loadSources, pollSources, statusChanged, watchSources, type SourceRequest } from '../src/sources/load';
import { describePending, isGoodMatch, recommend } from '../src/sources/rank';
import { toSourceViews } from '../src/sources/info';

const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/play/c/' + n,
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50 + n, estBitrateKbps: 5000, ...extra },
});

const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };

/** Faux lastAddon : la liste des streams et l'état de la recherche évoluent d'un appel à l'autre. */
function fakeAddon(steps: Array<{ streams: unknown[]; pending?: string[] }>) {
  let i = 0;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const step = steps[Math.min(i, steps.length - 1)];
    if (url.includes('/lt/streams/status/')) {
      const next = steps[Math.min(i + 1, steps.length - 1)];
      i = Math.min(i + 1, steps.length - 1);
      return new Response(JSON.stringify({ pending: next.pending ?? [], count: next.streams.length }), { status: 200 });
    }
    return new Response(JSON.stringify({ streams: step.streams, ...(step.pending ? { pending: step.pending } : {}) }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings();
  clearCache();
  clearSourceCache();
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('réponse partielle de lastAddon', () => {
  it('liste partielle : sources et sources en attente', async () => {
    fakeAddon([{ streams: [stream(1), stream(2)], pending: ['C411', 'YGG'] }]);
    const r = await loadSources(REQ);
    expect(r.views).toHaveLength(2);
    expect(r.pending).toEqual(['C411', 'YGG']);
  });

  it('ancienne forme de réponse (sans pending) : rien à attendre', async () => {
    fakeAddon([{ streams: [stream(1)] }]);
    const r = await loadSources(REQ);
    expect(r.pending).toEqual([]);
    expect(await pollSources(REQ, r)).toBe(r);
  });

  it('l’état de la recherche ne déclenche un rechargement que s’il a changé', () => {
    expect(statusChanged({ count: 3, pending: ['A'] }, { count: 3, pending: ['A'] })).toBe(false);
    expect(statusChanged({ count: 3, pending: ['A'] }, { count: 5, pending: ['A'] })).toBe(true);
    expect(statusChanged({ count: 3, pending: ['A', 'B'] }, { count: 3, pending: ['A'] })).toBe(true);
  });

  it('complète la liste quand la recherche avance', async () => {
    fakeAddon([{ streams: [stream(1)], pending: ['C411'] }, { streams: [stream(1), stream(2), stream(3)] }]);
    const first = await loadSources(REQ);
    const next = await pollSources(REQ, first);
    expect(next.views).toHaveLength(3);
    expect(next.pending).toEqual([]);
  });

  it('route d’état absente (ancien serveur) : on arrête d’attendre', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/status/') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ streams: [stream(1)], pending: ['X'] })))));
    const first = await loadSources(REQ);
    const next = await pollSources(REQ, first);
    expect(next.pending).toEqual([]);
    expect(next.views).toHaveLength(1);
  });

  it('surveillance : toutes les 2 s, signale les sources ajoutées, s’arrête à la fin', async () => {
    vi.useFakeTimers();
    fakeAddon([{ streams: [stream(1)], pending: ['C411'] }, { streams: [stream(1), stream(2)], pending: ['C411'] }, { streams: [stream(1), stream(2), stream(3), stream(4)] }]);
    const first = await loadSources(REQ);
    const updates: Array<[number, number, number]> = [];
    const stop = watchSources(REQ, first, (next, added) => updates.push([next.views.length, next.pending.length, added]));
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updates).toEqual([[2, 1, 1], [4, 0, 2]]);
    stop();
  });

  it('surveillance : onEnd est appelé une fois, à la fin de la recherche, avec la liste finale', async () => {
    vi.useFakeTimers();
    fakeAddon([{ streams: [stream(1)], pending: ['C411'] }, { streams: [stream(1), stream(2)], pending: ['C411'] }, { streams: [stream(1), stream(2), stream(3)] }]);
    const first = await loadSources(REQ);
    const ends: number[] = [];
    watchSources(REQ, first, () => undefined, { onEnd: (last) => ends.push(last.views.length) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ends).toEqual([3]);
  });

  it('surveillance : onEnd est appelé au délai maximal si une source reste en attente', async () => {
    vi.useFakeTimers();
    fakeAddon([{ streams: [stream(1)], pending: ['C411'] }]);
    const first = await loadSources(REQ);
    const ends: string[][] = [];
    watchSources(REQ, first, () => undefined, { maxMs: 5_000, onEnd: (last) => ends.push(last.pending) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ends).toEqual([['C411']]);
  });

  it('surveillance : arrêt demandé, onEnd n’est pas appelé', async () => {
    vi.useFakeTimers();
    fakeAddon([{ streams: [stream(1)], pending: ['C411'] }, { streams: [stream(1), stream(2)] }]);
    const first = await loadSources(REQ);
    const onEnd = vi.fn();
    const stop = watchSources(REQ, first, () => undefined, { onEnd });
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('surveillance : arrêt demandé, plus aucun appel', async () => {
    vi.useFakeTimers();
    const calls = fakeAddon([{ streams: [stream(1)], pending: ['C411'] }, { streams: [stream(1), stream(2)], pending: ['C411'] }]);
    const first = await loadSources(REQ);
    const stop = watchSources(REQ, first, () => undefined);
    stop();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBe(before);
  });
});

describe('lecture automatique sur liste partielle', () => {
  const views = (list: unknown[]) => toSourceViews(list as never);

  it('bonne correspondance : en cache, langue préférée, 1080p ou mieux', () => {
    const good = recommend(views([stream(1)]), null, 'fr');
    expect(isGoodMatch(good)).toBe(true);
  });

  it('pas assez bon : non caché, repli de langue, ou 720p', () => {
    expect(isGoodMatch(recommend(views([stream(1, { cached: false })]), null, 'fr'))).toBe(false);
    expect(isGoodMatch(recommend(views([stream(1, { languages: ['en'] })]), null, 'fr'))).toBe(false);
    expect(isGoodMatch(recommend(views([stream(1, { resolution: '720p', height: 720 })]), null, 'fr'))).toBe(false);
    expect(isGoodMatch(null)).toBe(false);
  });

  it('libellé de la recherche en cours', () => {
    expect(describePending([])).toBe('');
    expect(describePending(['C411'])).toBe('Recherche encore sur C411…');
    expect(describePending(['C411', 'YGG'])).toBe('Recherche encore sur C411, YGG…');
    expect(describePending(['C411', 'YGG', 'Torrent9'])).toBe('Recherche encore sur C411, YGG et 1 autre…');
    expect(describePending(['A', 'B', 'C', 'D'])).toBe('Recherche encore sur A, B et 2 autres…');
  });
});
