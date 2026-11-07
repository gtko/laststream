import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_STORAGE_KEY, reloadSettings } from '../src/data/config';
import { clearImdbResolveCache, MISS_TTL_MS, noImdbMessage, resolveImdbId } from '../src/data/imdbResolve';
import { clearCache } from '../src/data/transport';

/* ODY-248 : chaîne de repli TMDB → Wikidata → TVmaze (TVDB puis titre + année) pour l'identifiant IMDb. */

interface World {
  extStatus?: number;
  ext?: Record<string, unknown>;
  details?: Record<string, unknown>;
  wikidata?: string | null;
  tvmazeTvdb?: Record<string, unknown> | null;
  tvmazeSearch?: Record<string, unknown> | null;
}
const calls: string[] = [];

function world(w: World): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/tmdb/') && url.includes('external_ids')) return json(w.ext ?? {}, w.extStatus ?? 200);
    if (url.includes('/tmdb/')) return json(w.details ?? {});
    if (url.startsWith('https://query.wikidata.org/')) return json({ results: { bindings: w.wikidata ? [{ imdb: { value: w.wikidata } }] : [] } });
    if (url.includes('api.tvmaze.com/lookup/shows')) return w.tvmazeTvdb ? json(w.tvmazeTvdb) : json({}, 404);
    if (url.includes('api.tvmaze.com/singlesearch/shows')) return w.tvmazeSearch ? json(w.tvmazeSearch) : json({}, 404);
    return json({}, 404);
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings();
  clearCache();
  clearImdbResolveCache();
  calls.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

const hit = (needle: string) => calls.filter((u) => u.includes(needle)).length;

describe('resolveImdbId', () => {
  it('IMDb fourni par TMDB : aucune autre source n\'est interrogée', async () => {
    world({ ext: { imdb_id: 'tt0944947' } });
    const r = await resolveImdbId('tv', 1399);
    expect(r).toMatchObject({ imdb: 'tt0944947', source: 'tmdb' });
    expect(hit('wikidata')).toBe(0);
    expect(hit('tvmaze')).toBe(0);
  });

  it('sans IMDb chez TMDB : Wikidata retrouve l\'identifiant (film, par identifiant TMDB)', async () => {
    world({ ext: { imdb_id: '' }, wikidata: 'tt1234567' });
    const r = await resolveImdbId('movie', 42);
    expect(r).toMatchObject({ imdb: 'tt1234567', source: 'wikidata' });
    const q = decodeURIComponent(calls.find((u) => u.includes('wikidata'))!);
    expect(q).toContain('P4947');
    expect(q).toContain('"42"');
  });

  it('TVDB seul : Wikidata puis TVmaze par identifiant TVDB', async () => {
    world({ ext: { imdb_id: null, tvdb_id: 81189 }, wikidata: null, tvmazeTvdb: { name: 'X', externals: { imdb: 'tt7654321' } } });
    const r = await resolveImdbId('tv', 7);
    expect(r).toMatchObject({ imdb: 'tt7654321', source: 'tvmaze' });
    expect(decodeURIComponent(calls.find((u) => u.includes('wikidata'))!)).toContain('P4835');
  });

  it('aucun identifiant : recherche TVmaze par titre, retenue seulement si titre identique et année à ±1', async () => {
    world({ ext: {}, details: { name: 'Mon Émission', first_air_date: '2023-05-01' }, tvmazeSearch: { name: 'Mon emission', premiered: '2023-04-30', externals: { imdb: 'tt1111111' } } });
    const r = await resolveImdbId('tv', 9);
    expect(r).toMatchObject({ imdb: 'tt1111111', source: 'tvmaze-title' });
  });

  it('titre différent ou année trop éloignée : faux résultat refusé, message avec les méthodes essayées', async () => {
    world({ ext: {}, details: { name: 'Mon Émission', first_air_date: '2023-05-01' }, tvmazeSearch: { name: 'Autre chose', premiered: '2023-05-01', externals: { imdb: 'tt2222222' } } });
    const wrongTitle = await resolveImdbId('tv', 10);
    expect(wrongTitle.imdb).toBeNull();
    expect(wrongTitle.tried).toEqual(['TMDB', 'Wikidata', 'TVmaze (titre et année)']);

    clearImdbResolveCache();
    world({ ext: {}, details: { name: 'Mon Émission', first_air_date: '2023-05-01' }, tvmazeSearch: { name: 'Mon Emission', premiered: '1999-01-01', externals: { imdb: 'tt2222222' } } });
    expect((await resolveImdbId('tv', 11)).imdb).toBeNull();

    const msg = noImdbMessage(wrongTitle.tried);
    expect(msg).toContain('TMDB, Wikidata, TVmaze (titre et année)');
    expect(msg).toContain('Aucun identifiant IMDb trouvé');
  });

  it('sans année TMDB, pas de recherche par titre', async () => {
    world({ ext: {}, details: { name: 'Sans date' }, tvmazeSearch: { name: 'Sans date', premiered: '2020-01-01', externals: { imdb: 'tt3333333' } } });
    expect((await resolveImdbId('tv', 12)).imdb).toBeNull();
    expect(hit('singlesearch')).toBe(0);
  });

  it('un film sans IMDb ni Wikidata : échec clair, TVmaze (séries) non interrogé', async () => {
    world({ ext: {}, wikidata: null });
    const r = await resolveImdbId('movie', 13);
    expect(r.imdb).toBeNull();
    expect(r.tried).toEqual(['TMDB', 'Wikidata']);
    expect(hit('tvmaze')).toBe(0);
  });

  it('le résultat est mémorisé par titre ; un échec est retenté après son délai', async () => {
    world({ ext: { imdb_id: 'tt0000001' } });
    await resolveImdbId('movie', 1);
    const before = calls.length;
    await resolveImdbId('movie', 1);
    expect(calls.length).toBe(before);

    world({ ext: {}, wikidata: null });
    const t0 = Date.now();
    await resolveImdbId('movie', 2, t0);
    const n = calls.length;
    await resolveImdbId('movie', 2, t0 + 1000);
    expect(calls.length).toBe(n);
    world({ ext: {}, wikidata: 'tt0000002' });
    expect((await resolveImdbId('movie', 2, t0 + MISS_TTL_MS + 1)).imdb).toBe('tt0000002');
  });

  it('un identifiant mal formé renvoyé par une source est ignoré', async () => {
    world({ ext: {}, wikidata: 'not-an-id; DROP' });
    expect((await resolveImdbId('movie', 3)).imdb).toBeNull();
  });

  it("une erreur réseau ou 5xx n'est pas mémorisée comme « pas d'identifiant » : le second appel retrouve l'identifiant", async () => {
    world({ ext: {}, extStatus: 502, wikidata: null });
    const first = await resolveImdbId('movie', 20);
    expect(first.imdb).toBeNull();
    expect(first.failed).toBe(true);
    expect(localStorage.getItem('laststream.imdbId:movie:20')).toBeNull();

    world({ ext: { imdb_id: 'tt0000020' } });
    expect((await resolveImdbId('movie', 20)).imdb).toBe('tt0000020');
  });

  it("un 404 du service est une réponse « inconnu », pas une erreur : l'échec est mémorisé", async () => {
    world({ ext: {}, wikidata: null });
    const r = await resolveImdbId('movie', 21);
    expect(r.failed).toBeUndefined();
    expect(localStorage.getItem('laststream.imdbId:movie:21')).not.toBeNull();
  });

  it('deux appels simultanés pour un même titre partagent une seule résolution', async () => {
    world({ ext: { imdb_id: 'tt0000022' } });
    const [a, b] = await Promise.all([resolveImdbId('movie', 22), resolveImdbId('movie', 22)]);
    expect(a.imdb).toBe('tt0000022');
    expect(b.imdb).toBe('tt0000022');
    expect(hit('external_ids')).toBe(1);
  });
});
