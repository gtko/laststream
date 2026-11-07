// Cache des fiches avec ETag : corps et ETag gardés ; `If-None-Match` envoyé ; une réponse 304 réutilise le corps gardé.
// IndexedDB est simulée (jsdom n'en a pas) ; sans elle, le repli mémoire doit suffire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const URL_FICHE = 'http://localhost:7000/CFG_etag-test/lt/tmdb/movie/42?region=FR';
const FICHE = { id: 42, title: 'Film 42', overview: 'Un synopsis.', runtime: 100 };

interface Seen { url: string; ifNoneMatch: string | null }
let seen: Seen[] = [];
/** Réponse du faux serveur : 200 avec l'ETag v1, ou 304 si la requête porte v1. `etag: null` : pas d'ETag. */
let etag: string | null = 'W/"v1"';
let body: unknown = FICHE;

function serve(req: Seen): Response {
  if (etag && req.ifNoneMatch === etag) return new Response(null, { status: 304 });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (etag) headers.etag = etag;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/** Attend que les écritures asynchrones (IndexedDB simulée, repli mémoire) soient terminées. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** IndexedDB minimale : open / transaction / objectStore / get / put / clear, réponses asynchrones. */
function fakeIndexedDb(failOpen = false) {
  const data = new Map<string, unknown>();
  const request = (run: () => unknown) => {
    const r: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      r.result = run();
      r.onsuccess?.();
    });
    return r;
  };
  const store = {
    get: (k: string) => request(() => data.get(k)),
    put: (v: unknown, k: string) => request(() => { data.set(k, v); return k; }),
    clear: () => request(() => data.clear()),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
  };
  const factory = {
    open: () => {
      const r: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (failOpen) { r.onerror?.(); return; }
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { factory, data };
}

beforeEach(() => {
  vi.resetModules();
  seen = [];
  etag = 'W/"v1"';
  body = FICHE;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const req = { url: String(url), ifNoneMatch: headers.get('if-none-match') };
    seen.push(req);
    return serve(req);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cache des fiches (ETag)', () => {
  it('repli mémoire (IndexedDB absente) : 304 réutilise le corps gardé, sans nouveau téléchargement', async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    const t = await import('../src/data/transport');

    const first = await t.requestFiche<typeof FICHE>(URL_FICHE);
    await settle();
    expect(first).toEqual(FICHE);
    expect(seen[0].ifNoneMatch).toBeNull();

    // Le serveur répondrait 304 : le corps doit venir du cache, pas d'un nouveau corps.
    body = { changed: true };
    const second = await t.requestFiche<typeof FICHE>(URL_FICHE);
    expect(seen).toHaveLength(2);
    expect(seen[1].ifNoneMatch).toBe('W/"v1"');
    expect(second).toEqual(FICHE);
  });

  it('IndexedDB disponible : corps et ETag gardés, réutilisés après un rechargement du module', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const t1 = await import('../src/data/transport');
    await t1.requestFiche(URL_FICHE);
    await settle();
    expect(idb.data.get(URL_FICHE)).toEqual({ etag: 'W/"v1"', body: FICHE });

    // Nouveau chargement de l'application : mémoire vide, IndexedDB encore là.
    vi.resetModules();
    const t2 = await import('../src/data/transport');
    const again = await t2.requestFiche<typeof FICHE>(URL_FICHE);
    expect(seen[1].ifNoneMatch).toBe('W/"v1"');
    expect(again).toEqual(FICHE);
  });

  it('IndexedDB refusée à l’ouverture : repli mémoire, sans erreur', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb(true).factory);
    const t = await import('../src/data/transport');
    await t.requestFiche(URL_FICHE);
    await settle();
    const again = await t.requestFiche<typeof FICHE>(URL_FICHE);
    expect(seen[1].ifNoneMatch).toBe('W/"v1"');
    expect(again).toEqual(FICHE);
  });

  it('réponse 200 avec un nouvel ETag : l’entrée est remplacée', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const t = await import('../src/data/transport');
    await t.requestFiche(URL_FICHE);
    await settle();

    etag = 'W/"v2"';
    body = { ...FICHE, overview: 'Nouveau.' };
    const fresh = await t.requestFiche<typeof FICHE>(URL_FICHE);
    await settle();
    expect(fresh.overview).toBe('Nouveau.');
    expect(idb.data.get(URL_FICHE)).toEqual({ etag: 'W/"v2"', body: { ...FICHE, overview: 'Nouveau.' } });
  });

  it('sans ETag côté serveur : rien n’est gardé et aucun If-None-Match n’est envoyé', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    etag = null;
    const t = await import('../src/data/transport');
    await t.requestFiche(URL_FICHE);
    await settle();
    await t.requestFiche(URL_FICHE);
    expect(seen.map((s) => s.ifNoneMatch)).toEqual([null, null]);
    expect(idb.data.size).toBe(0);
  });

  it('seules les fiches TMDB, MDBList et TVDB passent par ce cache', async () => {
    const t = await import('../src/data/transport');
    expect(t.isFicheUrl('http://h/CFG/lt/tmdb/movie/1?region=FR')).toBe(true);
    expect(t.isFicheUrl('http://h/CFG/lt/mdblist/movie/tt1')).toBe(true);
    expect(t.isFicheUrl('http://h/CFG/lt/tvdb/series/1')).toBe(true);
    expect(t.isFicheUrl('http://h/CFG/lt/tv/epg?ids=a')).toBe(false);
    expect(t.isFicheUrl('http://h/CFG/lt/series/1/episodes')).toBe(false);
  });
});
