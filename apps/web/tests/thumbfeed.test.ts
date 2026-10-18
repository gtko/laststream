import { describe, expect, it } from 'vitest';
import { FEED_CACHE, MAX_FEED_FAILURES, MAX_PARALLEL, serverHasThumbs, sliceIndex, ThumbFeed, wantedSlices, type FeedDeps } from '../src/player/thumbfeed';

describe('aperçu mpv : tranches de 30 s', () => {
  it('arrondit à la tranche la plus proche et borne à la durée', () => {
    expect(sliceIndex(0, 3600)).toBe(0);
    expect(sliceIndex(14.9, 3600)).toBe(0);
    expect(sliceIndex(15, 3600)).toBe(1);
    expect(sliceIndex(44.9, 3600)).toBe(1);
    expect(sliceIndex(45, 3600)).toBe(2);
    expect(sliceIndex(-5, 3600)).toBe(0);
    expect(sliceIndex(3599, 3600)).toBe(120); // dernière tranche : floor(3600/30)
    expect(sliceIndex(110, 110)).toBe(3); // 110/30 arrondi = 4, borné à floor(110/30) = 3
  });

  it('précharge autour du curseur : courante, puis avant/arrière, dans les bornes', () => {
    expect(wantedSlices(5, 20)).toEqual([5, 6, 4, 7, 3]);
    expect(wantedSlices(0, 20)).toEqual([0, 1, 2]);
    expect(wantedSlices(20, 20)).toEqual([20, 19, 18]);
  });

  it("option masquée tant que le serveur n'annonce pas la capacité", () => {
    expect(serverHasThumbs({ ok: true, capabilities: { thumbs: true } })).toBe(true);
    expect(serverHasThumbs({ ok: true, capabilities: { thumbs: false } })).toBe(false);
    expect(serverHasThumbs({ ok: true })).toBe(false);
    expect(serverHasThumbs(null)).toBe(false);
    expect(serverHasThumbs('x')).toBe(false);
  });
});

interface Call {
  index: number;
  signal: AbortSignal;
  resolve: (status: number, body?: unknown) => void;
}

function harness(overrides: Partial<FeedDeps> = {}) {
  const calls: Call[] = [];
  const ready: Array<[number, string]> = [];
  const revoked: string[] = [];
  let registrations = 0;
  let blobs = 0;
  const deps: FeedDeps = {
    register: async () => { registrations += 1; return 'k' + registrations; },
    imageUrl: (key, index) => `/${key}/${index}.webp`,
    fetchFn: (url, init) => new Promise((resolve, reject) => {
      const index = Number(/\/(\d+)\.webp$/.exec(url)![1]);
      init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')));
      calls.push({
        index,
        signal: init.signal,
        resolve: (status, body) => resolve({ status, blob: async () => new Blob(['x']), json: async () => body ?? {} } as never),
      });
    }),
    makeUrl: () => `blob:${(blobs += 1)}`,
    revokeUrl: (url) => { revoked.push(url); },
    wait: async () => undefined,
    onReady: (index, url) => { ready.push([index, url]); },
    ...overrides,
  };
  return { feed: new ThumbFeed(deps), calls, ready, revoked, registrations: () => registrations };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('aperçu mpv : chargement des images', () => {
  it('demande la tranche arrondie et ses voisines, au plus MAX_PARALLEL à la fois', async () => {
    const h = harness();
    expect(h.feed.request(44, 3600)).toBeNull(); // rien d'affiché tant que l'image n'est pas prête
    await tick();
    expect(h.calls.map((c) => c.index)).toEqual([1, 2, 0].slice(0, MAX_PARALLEL));
    expect(h.registrations()).toBe(1);
  });

  it("affiche l'image dès qu'elle est prête, la rend ensuite sans nouvelle requête", async () => {
    const h = harness();
    h.feed.request(60, 3600);
    await tick();
    h.calls.find((c) => c.index === 2)!.resolve(200);
    await tick();
    expect(h.ready[0]![0]).toBe(2);
    expect(h.feed.request(61, 3600)).toBe(h.ready[0]![1]);
    expect(h.calls.filter((c) => c.index === 2)).toHaveLength(1);
  });

  it("annule les requêtes périmées quand le curseur s'éloigne", async () => {
    const h = harness();
    h.feed.request(60, 3600);
    await tick();
    const old = [...h.calls];
    expect(old.length).toBeGreaterThan(0);
    h.feed.request(1800, 3600);
    await tick();
    for (const c of old) expect(c.signal.aborted).toBe(true);
    expect(h.calls.some((c) => c.index === 60 && !c.signal.aborted)).toBe(true);
    h.feed.cancel();
    expect(h.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(h.feed.inFlight).toBe(0);
  });

  it('202 : la tranche est redemandée ; 404 : elle est abandonnée sans bruit', async () => {
    const h = harness();
    h.feed.request(0, 3600);
    await tick();
    h.calls.find((c) => c.index === 0)!.resolve(202, { pending: true });
    await tick();
    const retries = h.calls.filter((c) => c.index === 0);
    expect(retries).toHaveLength(2);
    retries[1]!.resolve(404, { error: 'not_found' });
    await tick();
    expect(h.calls.filter((c) => c.index === 0)).toHaveLength(2); // pas de nouvel essai
    expect(h.feed.dead).toBe(false);
  });

  it('source inconnue du serveur : une seule ré-inscription', async () => {
    const h = harness();
    h.feed.request(0, 3600);
    await tick();
    h.calls.find((c) => c.index === 0)!.resolve(404, { error: 'unknown_source' });
    await tick();
    await tick();
    expect(h.registrations()).toBe(2);
  });

  it("source refusée ou échecs répétés : plus d'aperçu pour cette source, sans exception", async () => {
    const refused = harness({ register: async () => null });
    expect(refused.feed.request(0, 3600)).toBeNull();
    await tick();
    expect(refused.feed.dead).toBe(true);
    expect(refused.calls).toHaveLength(0);

    const failing = harness();
    for (let i = 0; i < MAX_FEED_FAILURES + 2 && !failing.feed.dead; i += 1) {
      failing.feed.request(0, 3600);
      await tick();
      for (const c of failing.calls.splice(0)) c.resolve(500);
      await tick();
    }
    expect(failing.feed.dead).toBe(true);
    expect(failing.feed.request(0, 3600)).toBeNull();
  });

  it('reset libère les images et repart de zéro ; le cache est borné', async () => {
    const h = harness();
    h.feed.request(0, 100000);
    await tick();
    h.calls.find((c) => c.index === 0)!.resolve(200);
    await tick();
    h.feed.reset();
    expect(h.revoked).toHaveLength(1);
    expect(h.feed.imageFor(0)).toBeNull();
    expect(FEED_CACHE).toBeGreaterThan(10);
  });
});
