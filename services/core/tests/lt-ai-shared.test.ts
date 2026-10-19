import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryKvCache } from '../src/platform/memory-kv-cache.js';
import { platform, setPlatform } from '../src/platform/index.js';
import type { KvCache } from '../src/platform/types.js';
import { fakeLookup, fullToken, json, KEYS, mockUpstream, type MockUpstream, postJson, type RunningApp, startApp } from './lt-harness.js';

/*
 * Recommandations partagées entre profils : le lot résolu vit au niveau 2 (KV, fournisseur openrouter) sous une clé
 * d'empreinte de goûts. Deux profils aux goûts proches déclenchent un seul appel OpenRouter ; les exclusions propres à
 * chaque profil s'appliquent après lecture du cache ; la clé et la valeur ne portent aucune donnée personnelle ; un
 * lot périmé est servi tout de suite puis rafraîchi (24 h de fraîcheur, 24 h de service périmé).
 */

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const HOUR = 3600e3;
const T0 = Date.UTC(2026, 9, 19, 12);

interface Payload {
  max_tokens: number;
  messages: { role: string; content: string }[];
}

/** Réponse du modèle : `count` titres « Film A### » numérotés, sauf si un test la remplace. */
let reply: (payload: Payload) => { items: { t: string; y: number; k: string; r: string }[] } = (payload) => {
  const count = Number(/Donne exactement (\d+) titres/.exec(payload.messages[0]?.content ?? '')?.[1] ?? 0);
  return {
    items: Array.from({ length: count }, (_, index) => ({ t: `Film A${String(index + 1).padStart(3, '0')}`, y: 2000, k: 'movie', r: 'Parce que' })),
  };
};

let upstream: MockUpstream;
let app: RunningApp;

const original = platform();
/** Valeurs écrites dans le niveau 2 « openrouter » (la dernière écriture de chaque clé). */
const written = new Map<string, string>();
const store = createMemoryKvCache(() => Date.now());
const openrouterKv: KvCache = {
  get: (key) => store.get(key),
  set: (key, value, ttlSeconds) => {
    written.set(key, value);
    return store.set(key, value, ttlSeconds);
  },
  delete: (key) => store.delete(key),
};

beforeAll(async () => {
  setPlatform({
    ...original,
    capabilities: { ...original.capabilities, sharedState: true },
    createKvCache: (namespace) => (namespace === 'openrouter' ? openrouterKv : original.createKvCache(namespace)),
  });
  upstream = mockUpstream({
    [OPENROUTER]: (call) => {
      const content = reply(JSON.parse(call.body) as Payload);
      return json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    },
    'https://api.themoviedb.org/3/search/movie': (call) => {
      const query = call.url.searchParams.get('query') ?? '';
      const match = /^Film A(\d{3})$/.exec(query);
      if (match === null) return json({ results: [] });
      return json({ results: [{ id: 65000 + Number(match[1]), title: query, release_date: '2000-01-01', poster_path: '/f.jpg' }] });
    },
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
  setPlatform(original);
});

afterEach(() => {
  vi.useRealTimers();
});

const openrouterCalls = (): number => upstream.callsTo(OPENROUTER).length;
const post = (body: unknown): Promise<Response> => fetch(`${app.baseUrl}/${fullToken()}/lt/recommend`, postJson(body));

async function itemsOf(res: Response): Promise<Record<string, unknown>[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Record<string, unknown>[] }).items;
}

const titlesOf = async (res: Response): Promise<string[]> => (await itemsOf(res)).map((item) => String(item.title));

/** Enregistrements du niveau 2 « recommend » : `e` fin de fraîcheur, `s` fin du service périmé, `v` le lot. */
interface StoredBatch {
  e: number;
  s: number;
  v: { items: { reason_fr?: string }[] };
}
const batchesInKv = (): [string, StoredBatch][] =>
  [...written].filter(([key]) => key.startsWith('recommend:')).map(([key, value]) => [key, JSON.parse(value) as StoredBatch]);

// Profil A : goûts marqués, un titre déjà vu (Film A001). Profil B : mêmes goûts, dans un autre ordre, avec des notes
// décimales et une autre taille de liste (45 demandés, même lot que 50), un autre titre déjà vu (Film A002).
const alice = {
  history: [
    { title: 'Dune', year: 2021, type: 'movie' },
    { title: 'Arrival', year: 2016, type: 'movie' },
  ],
  liked: [{ title: 'Blade Runner', year: 1982, type: 'movie' }],
  ratings: [{ title: 'Dune', year: 2021, type: 'movie', rating: 5 }],
  exclude: [{ title: 'Film A001', year: 2000 }],
  profileId: 'profil-alice',
  name: 'Alice',
};
const bob = {
  history: [
    { title: 'Arrival', year: 2016, type: 'movie' },
    { title: 'Dune', year: 2021, type: 'movie' },
  ],
  liked: [{ title: 'Blade Runner', year: 1982, type: 'movie' }],
  ratings: [{ title: 'Dune', year: 2021, type: 'movie', rating: 4.5 }],
  exclude: [{ title: 'Film A002', year: 2000 }],
  count: 45,
  profileId: 'profil-bob',
  name: 'Bob',
};

describe('lt/recommend : lot partagé par empreinte de goûts', () => {
  it('deux profils aux goûts proches : un seul appel OpenRouter, chacun retire ses propres titres déjà vus', async () => {
    const before = openrouterCalls();
    const aliceTitles = await titlesOf(await post(alice));
    expect(openrouterCalls() - before).toBe(1);
    const bobTitles = await titlesOf(await post(bob));
    expect(openrouterCalls() - before).toBe(1);

    expect(aliceTitles).toHaveLength(50);
    expect(aliceTitles).not.toContain('Film A001');
    expect(bobTitles).toHaveLength(45);
    expect(bobTitles).not.toContain('Film A002');
    expect(bobTitles).toContain('Film A001');
  });

  it('goûts différents : un second appel, et une seconde entrée de cache', async () => {
    const before = openrouterCalls();
    const other = { history: [{ title: 'Le Parrain', year: 1972, type: 'movie' }], liked: [{ title: 'Les Sopranos', year: 1999, type: 'tv' }] };
    await post(other);
    expect(openrouterCalls() - before).toBe(1);
    expect(batchesInKv()).toHaveLength(2);
  });

  it('même empreinte, historiques hors empreinte différents : le modèle ne voit ni ne sert aucun titre de l historique', async () => {
    // Les 10 titres aimés (poids 2) forment l'empreinte ; l'historique (poids 1) reste hors des 10 retenus, et diffère.
    const favourites = Array.from({ length: 10 }, (_, index) => ({
      title: `Favori ${String(index + 1).padStart(2, '0')}`,
      year: 2005,
      type: 'movie',
    }));
    const secrets = ['Secret Alpha', 'Secret Beta', 'Secret Gamma', 'Secret Delta'];
    // Le modèle cite chaque titre secret qu'il trouve dans son prompt : si l'historique y est, il fuit dans `reason_fr`.
    reply = (payload) => {
      const count = Number(/Donne exactement (\d+) titres/.exec(payload.messages[0]?.content ?? '')?.[1] ?? 0);
      const cited = secrets.filter((title) => (payload.messages[1]?.content ?? '').includes(title)).join(', ');
      return {
        items: Array.from({ length: count }, (_, index) => ({
          t: `Film A${String(index + 1).padStart(3, '0')}`,
          y: 2000,
          k: 'movie',
          r: index === 0 && cited !== '' ? `Vu : ${cited}` : 'Parce que',
        })),
      };
    };
    const before = openrouterCalls();
    const xavier = { history: [{ title: 'Secret Alpha', year: 2010, type: 'movie' }, { title: 'Secret Beta', year: 2010, type: 'movie' }], liked: favourites };
    const yvonne = { history: [{ title: 'Secret Gamma', year: 2010, type: 'movie' }, { title: 'Secret Delta', year: 2010, type: 'movie' }], liked: favourites };

    const xItems = await itemsOf(await post(xavier));
    const yItems = await itemsOf(await post(yvonne));
    expect(openrouterCalls() - before).toBe(1);

    const prompt = (JSON.parse(upstream.callsTo(OPENROUTER).slice(before)[0]?.body ?? '{}') as Payload).messages[1]?.content ?? '';
    expect(prompt).toContain('Favori 01 (2005) [movie]');
    for (const secret of secrets) expect(prompt).not.toContain(secret);
    expect(JSON.stringify(xItems)).not.toContain('Secret');
    expect(JSON.stringify(yItems)).not.toContain('Secret');
    expect(JSON.stringify(batchesInKv())).not.toContain('Secret');
  });

  it('une requête : un seul appel au modèle, même pour 80 titres (95 demandés)', async () => {
    const before = openrouterCalls();
    const titles = await titlesOf(await post({ history: [{ title: 'Volume maximal', type: 'movie' }], count: 80 }));
    expect(titles).toHaveLength(80);
    const calls = upstream.callsTo(OPENROUTER).slice(before).map((call) => JSON.parse(call.body) as Payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.max_tokens).toBe(95 * 60 + 200);
    expect(calls[0]?.messages[0]?.content).toContain('Donne exactement 95 titres');
  });

  it('clé et valeur partagées sans donnée personnelle : pas d identifiant de profil, de nom, de jeton ni de clé', async () => {
    const keys = batchesInKv().map(([key]) => key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) expect(key).toMatch(/^recommend:[0-9a-f]{64}$/);

    const stored = [...written].filter(([key]) => key.startsWith('recommend:')).map(([, value]) => value).join('\n');
    for (const secret of ['profil-alice', 'profil-bob', 'Alice', 'Bob', fullToken(), KEYS.openrouterApiKey, KEYS.tmdbToken]) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe('lt/recommend : fraîcheur 24 h, périmé servi puis rafraîchi', () => {
  it('lot frais 24 h, puis périmé servi tout de suite et rafraîchi en arrière-plan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const body = { history: [{ title: 'Lot à rafraîchir', type: 'movie' }] };
    reply = () => ({ items: [{ t: 'Film A001', y: 2000, k: 'movie', r: 'Ancien' }] });
    const before = openrouterCalls();

    const first = await itemsOf(await post(body));
    expect(first.map((item) => item.reason_fr)).toEqual(['Ancien']);
    expect(openrouterCalls() - before).toBe(1);
    const [, written24h] = batchesInKv().find(([, batch]) => batch.v.items[0]?.reason_fr === 'Ancien') ?? [];
    expect(written24h?.e).toBe(T0 + 24 * HOUR);
    expect(written24h?.s).toBe(T0 + 48 * HOUR);

    // Fraîcheur passée, service périmé encore permis : la réponse part avec l'ancien lot, sans attendre.
    vi.setSystemTime(T0 + 24 * HOUR + 60e3);
    reply = () => ({ items: [{ t: 'Film A002', y: 2000, k: 'movie', r: 'Nouveau' }] });
    const stale = await itemsOf(await post(body));
    expect(stale.map((item) => item.reason_fr)).toEqual(['Ancien']);

    // Le rafraîchissement part en arrière-plan : le niveau 2 reçoit le nouveau lot, un seul appel de plus.
    await vi.waitFor(() => expect(batchesInKv().some(([, batch]) => batch.v.items[0]?.reason_fr === 'Nouveau')).toBe(true));
    expect(openrouterCalls() - before).toBe(2);

    // Lot rafraîchi : servi tel quel, sans nouvel appel.
    const refreshed = await itemsOf(await post(body));
    expect(refreshed.map((item) => item.reason_fr)).toEqual(['Nouveau']);
    expect(openrouterCalls() - before).toBe(2);
  });

  it('lot vide : gardé 5 min seulement, pour que le profil suivant retente l appel', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    reply = () => ({ items: [] });
    const before = openrouterCalls();

    expect(await itemsOf(await post({ history: [{ title: 'Lot vide', type: 'movie' }] }))).toEqual([]);
    expect(openrouterCalls() - before).toBe(1);
    const empty = batchesInKv().filter(([, batch]) => batch.v.items.length === 0);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.[1].e).toBe(T0 + 5 * 60e3);
  });
});
