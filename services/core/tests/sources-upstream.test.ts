import { describe, expect, it, vi } from 'vitest';
import type { ContentRef } from '../src/types.js';
import { fetchWithTimeout, redactUrl, type FetchFn } from '../src/sources/http.js';
import { fetchUpstream, testUpstream } from '../src/sources/upstream.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const SERIES: ContentRef = { type: 'series', id: 'tt1234567:1:2', imdbId: 'tt1234567', season: 1, episode: 2 };
const BASE_URL = 'https://up.example.com/addon';
const SOURCE = { name: 'Amont', url: `${BASE_URL}/manifest.json` };
const SECRET_KEY = 'UP-SECRET-KEY-42';

/** Faux fetch : aucun appel réseau, la réponse est produite par le gestionnaire fourni. */
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(handler);
  return { fetch: mock as unknown as FetchFn, mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Renvoie l'erreur levée par la promesse ; échoue si elle se résout. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('aucune erreur levée');
}

/** Fetch qui ne répond jamais et se rejette seulement lorsque le signal est annulé. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

describe('fetchUpstream', () => {
  it('appelle {base}/stream/{type}/{id}.json et mappe les streams avec sourceName et sourceKind', async () => {
    const { fetch, mock } = mockFetch(async () =>
      jsonResponse({ streams: [{ name: 'Torrentio', title: 'Film 1080p', infoHash: 'ABCDEF' }] }),
    );

    const streams = await fetchUpstream(SOURCE, MOVIE, { fetch });

    expect(mock.mock.calls[0]?.[0]).toBe('https://up.example.com/addon/stream/movie/tt1234567.json');
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ sourceName: 'Amont', sourceKind: 'upstream' });
  });

  it('retire /manifest.json de l’URL source et accepte aussi une URL de base', async () => {
    const { fetch, mock } = mockFetch(async () => jsonResponse({ streams: [] }));

    await fetchUpstream({ name: 'A', url: `${BASE_URL}/manifest.json` }, MOVIE, { fetch });
    await fetchUpstream({ name: 'A', url: `${BASE_URL}/` }, MOVIE, { fetch });

    expect(mock.mock.calls[0]?.[0]).toBe(mock.mock.calls[1]?.[0]);
    expect(mock.mock.calls[1]?.[0]).toBe('https://up.example.com/addon/stream/movie/tt1234567.json');
  });

  it('encode l’identifiant de série (tt:1:2) dans le chemin', async () => {
    const { fetch, mock } = mockFetch(async () => jsonResponse({ streams: [] }));

    await fetchUpstream(SOURCE, SERIES, { fetch });

    expect(mock.mock.calls[0]?.[0]).toBe('https://up.example.com/addon/stream/series/tt1234567%3A1%3A2.json');
  });

  it('mappe filename et sizeBytes depuis behaviorHints et conserve les hints', async () => {
    const { fetch } = mockFetch(async () =>
      jsonResponse({
        streams: [{ behaviorHints: { filename: 'Film.2024.mkv', videoSize: 4_294_967_296, bingeGroup: 'x' } }],
      }),
    );

    const [stream] = await fetchUpstream(SOURCE, MOVIE, { fetch });

    expect(stream?.filename).toBe('Film.2024.mkv');
    expect(stream?.sizeBytes).toBe(4_294_967_296);
    expect(stream?.behaviorHints).toEqual({ filename: 'Film.2024.mkv', videoSize: 4_294_967_296, bingeGroup: 'x' });
  });

  it('garde name, title et description bruts, sans parsing', async () => {
    const { fetch } = mockFetch(async () =>
      jsonResponse({
        streams: [{ name: 'Torrentio\n4k', title: 'Film 2160p FRENCH\n👤 42', description: 'VOSTFR' }],
      }),
    );

    const [stream] = await fetchUpstream(SOURCE, MOVIE, { fetch });

    expect(stream?.name).toBe('Torrentio\n4k');
    expect(stream?.title).toBe('Film 2160p FRENCH\n👤 42');
    expect(stream?.description).toBe('VOSTFR');
  });

  it('met l’infoHash en minuscules et conserve fileIdx, url et sources', async () => {
    const { fetch } = mockFetch(async () =>
      jsonResponse({
        streams: [
          { infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', fileIdx: 2, url: 'https://cdn/x.mkv', sources: ['tracker:udp://t'] },
        ],
      }),
    );

    const [stream] = await fetchUpstream(SOURCE, MOVIE, { fetch });

    expect(stream?.infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(stream?.fileIdx).toBe(2);
    expect(stream?.url).toBe('https://cdn/x.mkv');
    expect(stream?.sources).toEqual(['tracker:udp://t']);
  });

  it('ignore les entrées de streams qui ne sont pas des objets', async () => {
    const { fetch } = mockFetch(async () => jsonResponse({ streams: [null, 'texte', 7, { name: 'ok' }] }));

    const streams = await fetchUpstream(SOURCE, MOVIE, { fetch });

    expect(streams.map((s) => s.name)).toEqual(['ok']);
  });

  it('HTTP 500 : lève une erreur qui nomme la source et le code, sans clé', async () => {
    const { fetch } = mockFetch(async () => new Response('boom', { status: 500 }));

    const error = await errorOf(fetchUpstream(SOURCE, MOVIE, { fetch }));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Source "Amont" : HTTP 500');
  });

  it('JSON invalide : lève une erreur sûre', async () => {
    const { fetch } = mockFetch(async () => new Response('<html>pas du JSON</html>', { status: 200 }));

    await expect(fetchUpstream(SOURCE, MOVIE, { fetch })).rejects.toThrow('Source "Amont" : réponse JSON invalide');
  });

  it('réponse sans tableau streams : lève une erreur', async () => {
    const { fetch } = mockFetch(async () => jsonResponse({ message: 'hello' }));

    await expect(fetchUpstream(SOURCE, MOVIE, { fetch })).rejects.toThrow(/champ streams absent/);
  });

  it('délai dépassé : la requête est annulée et l’erreur est explicite', async () => {
    const { fetch, mock } = mockFetch(hangingFetch);

    await expect(fetchUpstream(SOURCE, MOVIE, { fetch, timeoutMs: 20 })).rejects.toThrow(
      'Source "Amont" : délai dépassé (20 ms)',
    );
    const init = mock.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
  });

  it('les erreurs ne contiennent ni la clé apikey ni l’URL, même si le fetch échoue avec une URL', async () => {
    const keyedSource = { name: 'Amont', url: `${BASE_URL}/manifest.json?apikey=${SECRET_KEY}` };
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    });

    const error = await errorOf(fetchUpstream(keyedSource, MOVIE, { fetch }));

    expect(error.message).toBe('Source "Amont" : erreur réseau');
    expect(error.message).not.toContain(SECRET_KEY);
    expect(error.message).not.toContain('up.example.com');
  });

  it('URL source invalide : erreur générique sans l’URL saisie', async () => {
    const { fetch, mock } = mockFetch(async () => jsonResponse({ streams: [] }));

    await expect(fetchUpstream({ name: 'Cassée', url: `not a url ${SECRET_KEY}` }, MOVIE, { fetch })).rejects.toThrow(
      'Source "Cassée" : URL source invalide',
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('testUpstream', () => {
  it('ok quand le manifest contient un id', async () => {
    const { fetch, mock } = mockFetch(async () => jsonResponse({ id: 'org.up', resources: ['stream'] }));

    const result = await testUpstream(SOURCE, { fetch });

    expect(result).toEqual({ ok: true });
    expect(mock.mock.calls[0]?.[0]).toBe('https://up.example.com/addon/manifest.json');
  });

  it('ok quand le manifest contient resources (sans id)', async () => {
    const { fetch } = mockFetch(async () => jsonResponse({ resources: ['stream'] }));

    await expect(testUpstream(SOURCE, { fetch })).resolves.toEqual({ ok: true });
  });

  it('HTTP 404 : ok à false, erreur sans clé', async () => {
    const { fetch } = mockFetch(async () => new Response('nope', { status: 404 }));

    const result = await testUpstream({ name: 'Amont', url: `${BASE_URL}?apikey=${SECRET_KEY}` }, { fetch });

    expect(result).toEqual({ ok: false, error: 'Source "Amont" : HTTP 404' });
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it('JSON sans id ni resources : ok à false', async () => {
    const { fetch } = mockFetch(async () => jsonResponse({ name: 'pas un manifest' }));

    const result = await testUpstream(SOURCE, { fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('manifest invalide');
  });
});

describe('redactUrl', () => {
  it('masque les valeurs apikey, api_key et token dans la query, sans toucher au reste', () => {
    expect(redactUrl('https://a.example.com/x?apikey=SECRET&foo=1')).toBe('https://a.example.com/x?apikey=***&foo=1');
    expect(redactUrl('https://a.example.com/x?foo=1&api_key=SECRET')).toBe('https://a.example.com/x?foo=1&api_key=***');
    expect(redactUrl('https://a.example.com/x?token=SECRET')).toBe('https://a.example.com/x?token=***');
  });

  it('masque les identifiants d’URL et le segment suivant /config/', () => {
    expect(redactUrl('https://user:pass@h.example.com/config/XYZ/manifest.json')).toBe(
      'https://***@h.example.com/config/***/manifest.json',
    );
  });

  it('laisse intacte une URL sans secret', () => {
    expect(redactUrl('https://a.example.com/stream/movie/tt1.json?lang=fr')).toBe(
      'https://a.example.com/stream/movie/tt1.json?lang=fr',
    );
  });
});

describe('fetchWithTimeout', () => {
  it('renvoie la réponse quand elle arrive dans le délai', async () => {
    const { fetch } = mockFetch(async () => jsonResponse({ ok: true }));

    const response = await fetchWithTimeout(fetch, 'https://a.example.com/', {}, 1000);

    expect(await response.json()).toEqual({ ok: true });
  });

  it('annule la requête et lève une erreur de délai dépassé', async () => {
    const { fetch } = mockFetch(hangingFetch);

    await expect(fetchWithTimeout(fetch, 'https://a.example.com/', {}, 20)).rejects.toThrow('délai dépassé (20 ms)');
  });
});
