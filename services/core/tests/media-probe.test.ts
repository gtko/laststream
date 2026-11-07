import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import { probeMedia } from '../src/media/probe.js';
import { buildMkv, buildMp4, moovOffsetOf, rangeServer } from './media-fixtures.js';

const MKV_URL = 'https://cdn.example.com/media/film.mkv';
const MP4_URL = 'https://cdn.example.com/media/film.mp4';

/** Fetch qui ne répond jamais et se rejette seulement lorsque le signal est annulé. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/** Fetch qui renvoie une suite de réponses, dans l'ordre (une par appel). */
function scripted(responses: Array<() => Response>): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses.shift();
    if (next === undefined) throw new Error('plus de réponse prévue');
    return next();
  }) as unknown as FetchFn;
  return { fetch, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeMedia : MKV', () => {
  it('lit en une requête les pistes audio, sous-titres et la durée', async () => {
    const server = rangeServer(buildMkv({ durationSec: 5400 }));

    const result = await probeMedia(MKV_URL, { fetch: server.fetch });

    expect(result).toEqual({
      container: 'mkv',
      audio: [
        { lang: 'fr', codec: 'EAC3', channels: 6, atmos: true, name: 'Français Atmos' },
        { lang: 'en', codec: 'AAC', channels: 2 },
      ],
      subtitles: [{ lang: 'fr', name: 'Français' }],
      durationSec: 5400,
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.range).toBe('bytes=0-2999999');
  });

  it('préfère LanguageBCP47 (fr-CA) à Language et le normalise en fr', async () => {
    const server = rangeServer(
      buildMkv({
        tracks: [
          { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC' },
          { number: 2, type: 'audio', codecId: 'A_AC3', language: 'eng', languageIetf: 'fr-CA', channels: 6 },
        ],
      }),
    );

    const result = await probeMedia(MKV_URL, { fetch: server.fetch });

    expect(result?.audio).toEqual([{ lang: 'fr', codec: 'AC3', channels: 6 }]);
  });

  it('renvoie les pistes complètes quand l en-tête est tronqué', async () => {
    const file = buildMkv();
    const cut = file.indexOf('A_AAC') + 2;
    const server = rangeServer(file);

    const result = await probeMedia(MKV_URL, { fetch: server.fetch, rangeBytes: cut });

    expect(result?.audio.map((track) => track.codec)).toEqual(['EAC3']);
    expect(server.calls[0]?.range).toBe(`bytes=0-${cut - 1}`);
  });

  it('gère un Segment et un Cluster à taille inconnue', async () => {
    const server = rangeServer(buildMkv({ unknownSegmentSize: true, unknownClusterSize: true, durationSec: 30 }));

    const result = await probeMedia(MKV_URL, { fetch: server.fetch });

    expect(result?.audio).toHaveLength(2);
    expect(result?.durationSec).toBeCloseTo(30, 6);
  });

  it('renvoie null quand le MKV ne contient aucune piste', async () => {
    const server = rangeServer(buildMkv({ tracks: [] }));

    expect(await probeMedia(MKV_URL, { fetch: server.fetch })).toBeNull();
  });
});

describe('probeMedia : MP4', () => {
  it('lit le moov au début du fichier en une seule requête', async () => {
    const server = rangeServer(buildMp4({ layout: 'moov-first', durationSec: 5400 }));

    const result = await probeMedia(MP4_URL, { fetch: server.fetch });

    expect(result).toEqual({
      container: 'mp4',
      audio: [
        { lang: 'fr', codec: 'EAC3', channels: 6 },
        { lang: 'en', codec: 'AAC', channels: 2 },
      ],
      subtitles: [{ lang: 'fr' }],
      durationSec: 5400,
    });
    expect(server.calls).toHaveLength(1);
  });

  it('lit un moov en fin de fichier avec une seconde requête Range à l offset exact', async () => {
    const file = buildMp4({ layout: 'moov-last', mdatBytes: 5_000_000 });
    const moov = moovOffsetOf(file);
    const server = rangeServer(file);

    const result = await probeMedia(MP4_URL, { fetch: server.fetch, rangeBytes: 1000, tailBytes: 4000 });

    expect(server.calls.map((call) => call.range)).toEqual(['bytes=0-999', `bytes=${moov}-${moov + 3999}`]);
    expect(result?.audio.map((track) => track.lang)).toEqual(['fr', 'en']);
  });

  it('lit un moov partiellement présent dans l en-tête en relisant la boîte entière', async () => {
    const file = buildMp4({ layout: 'moov-first' });
    const moov = moovOffsetOf(file);
    const moovSize = file.readUInt32BE(moov);
    const server = rangeServer(file);

    const result = await probeMedia(MP4_URL, { fetch: server.fetch, rangeBytes: moov + 30 });

    expect(server.calls[1]?.range).toBe(`bytes=${moov}-${moov + moovSize - 1}`);
    expect(result?.audio).toHaveLength(2);
  });

  it('reste tolérant quand le moov en fin dépasse tailBytes', async () => {
    const file = buildMp4({ layout: 'moov-last', mdatBytes: 5_000_000 });
    const moov = moovOffsetOf(file);
    const moovSize = file.readUInt32BE(moov);
    // Lecture de moov coupée juste après le stsd de la première piste : sa piste reste lisible.
    const tailBytes = file.indexOf('stsd', 0, 'latin1') + 40 - moov;
    expect(tailBytes).toBeLessThan(moovSize);
    const server = rangeServer(file);

    const result = await probeMedia(MP4_URL, { fetch: server.fetch, rangeBytes: 1000, tailBytes });

    expect(result?.container).toBe('mp4');
    expect(result?.audio[0]).toEqual({ lang: 'fr', codec: 'EAC3', channels: 6 });
  });

  it('renvoie null si le serveur ignore Range et que le fichier dépasse la plage lue', async () => {
    const file = buildMp4({ layout: 'moov-last', mdatBytes: 5_000_000 });
    const server = rangeServer(file, { ignoreRange: true });

    expect(await probeMedia(MP4_URL, { fetch: server.fetch, rangeBytes: 1000 })).toBeNull();
  });
});

describe('probeMedia : échecs et sécurité', () => {
  it('renvoie null pour un contenu qui n est pas un média, sans seconde requête', async () => {
    const server = rangeServer(Buffer.from('<html>erreur</html>'));

    expect(await probeMedia(MKV_URL, { fetch: server.fetch })).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it('refuse un schéma non http(s) sans appel réseau', async () => {
    const server = rangeServer(buildMkv());

    expect(await probeMedia('file:///etc/passwd', { fetch: server.fetch })).toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  it('refuse une adresse IP littérale privée sans appel réseau', async () => {
    const server = rangeServer(buildMkv());

    expect(await probeMedia('http://192.168.1.10/film.mkv', { fetch: server.fetch })).toBeNull();
    expect(await probeMedia('http://127.0.0.1:8080/film.mkv', { fetch: server.fetch })).toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  it('ne suit pas une redirection vers une adresse privée', async () => {
    const { fetch, urls } = scripted([
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    ]);

    expect(await probeMedia(MKV_URL, { fetch })).toBeNull();
    expect(urls).toEqual([MKV_URL]);
  });

  it('suit une redirection vers une adresse publique', async () => {
    const file = buildMkv();
    const target = 'https://93.184.216.34/film.mkv';
    const { fetch, urls } = scripted([
      () => new Response(null, { status: 302, headers: { location: target } }),
      () =>
        new Response(new Uint8Array(file), {
          status: 206,
          headers: { 'content-range': `bytes 0-${file.length - 1}/${file.length}` },
        }),
    ]);

    const result = await probeMedia(MKV_URL, { fetch });

    expect(urls).toEqual([MKV_URL, target]);
    expect(result?.audio).toHaveLength(2);
  });

  it('envoie Range et Accept-Encoding identity, sans jamais journaliser l URL', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const server = rangeServer(buildMkv());
    const secretUrl = 'https://cdn.example.com/media/film.mkv?apikey=SECRET-KEY-VALUE';

    const result = await probeMedia(secretUrl, { fetch: server.fetch });

    expect(result).not.toBeNull();
    expect(server.calls[0]?.headers['accept-encoding']).toBe('identity');
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it('renvoie null sur délai dépassé', async () => {
    const fetch = hangingFetch as unknown as FetchFn;

    expect(await probeMedia(MKV_URL, { fetch, timeoutMs: 20 })).toBeNull();
  });

  it('renvoie null sur erreur réseau, sans lever d exception', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchFn;

    await expect(probeMedia(MKV_URL, { fetch })).resolves.toBeNull();
  });
});
