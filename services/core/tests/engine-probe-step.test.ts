import { describe, expect, it, vi } from 'vitest';
import { enrichWithProbe } from '../src/engine/probe-step.js';
import type { Ranked } from '../src/engine/types.js';
import type { MediaProbe, ProbeOptions } from '../src/media/probe.js';
import { ProbeCache, probeCacheKey } from '../src/media/probe-cache.js';
import type { FetchFn } from '../src/sources/http.js';
import type { Lang } from '../src/types.js';
import { cand, ranked as asRanked } from './engine-fixtures.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const DIRECT_URL = 'https://cdn.example.com/media/film.mkv';
/** Préfixe des liens débridés factices de ces tests. */
const RESOLVED_BASE = 'https://dl.example.com/resolved/TEST-LINK-ONLY/';

const FR_EN: MediaProbe = {
  container: 'mkv',
  audio: [
    { lang: 'fr', codec: 'EAC3', channels: 6, atmos: false },
    { lang: 'en', codec: 'TrueHD', channels: 8, atmos: true },
  ],
  subtitles: [],
};

const VERIFIED_FR_EN = ['fr', 'en', 'multi'];

function resolvedUrl(hash: string): string {
  return `${RESOLVED_BASE}${hash}`;
}

/** Candidat caché chez le débrideur, avec infoHash et langues annoncées facultatives. */
function cached(hash: string, fileIdx?: number, announced?: Lang[]): Ranked {
  return asRanked(
    cand({
      cached: true,
      raw: { infoHash: hash, fileIdx, title: 'Film.2024.1080p.WEB-DL', filename: 'Film.2024.1080p.WEB-DL.mkv' },
      parsed: announced === undefined ? undefined : { languages: announced },
    }),
  );
}

/** Candidat non caché. */
function notCached(hash: string): Ranked {
  return asRanked(cand({ cached: false, raw: { infoHash: hash, title: 'Film.2024.720p.WEB-DL' } }));
}

/** Lien direct http(s). */
function direct(url: string): Ranked {
  return asRanked(cand({ raw: { url, title: 'Film.2024.1080p.WEB-DL' } }));
}

/** Débrideur factice : renvoie un lien propre à chaque hash, ou échoue pour les hashes de `fail`. */
function debridMock(fail: (hash: string) => boolean = () => false) {
  const resolve = vi.fn(async (hash: string, _fileIdx?: number, _opts?: unknown) => {
    if (fail(hash)) throw new Error('not_ready');
    return { url: resolvedUrl(hash), filename: 'film.mkv', size: 1 };
  });
  return { resolve };
}

/** Sonde factice qui renvoie toujours `result`. */
function probeMock(result: MediaProbe | null = FR_EN) {
  return vi.fn(async (_url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => result);
}

describe('enrichWithProbe : candidats cachés', () => {
  it('fr + en vérifiés : langues multi, pistes détaillées, langues annoncées conservées', async () => {
    const debrid = debridMock();
    const probe = probeMock();
    const cache = new ProbeCache<MediaProbe>();

    const [out] = await enrichWithProbe([cached(HASH_A, 2, ['es'])], {
      debrid,
      probe,
      cache,
      topN: 1,
      season: 1,
      episode: 3,
    });

    expect(out.verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(out.verifiedAudio).toEqual([
      { lang: 'fr', codec: 'EAC3', channels: '5.1', atmos: false },
      { lang: 'en', codec: 'TrueHD', channels: '7.1', atmos: true },
    ]);
    expect(out.parsed.languages).toEqual(['es', 'fr', 'en', 'multi']);
    expect(debrid.resolve).toHaveBeenCalledWith(
      HASH_A,
      2,
      expect.objectContaining({ season: 1, episode: 3, filename: 'Film.2024.1080p.WEB-DL.mkv' }),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe(resolvedUrl(HASH_A));
    expect(cache.get(probeCacheKey(HASH_A, 2))).toEqual(FR_EN);
  });

  it("n ajoute jamais le lien débridé au résultat", async () => {
    const out = await enrichWithProbe([cached(HASH_A, 0)], {
      debrid: debridMock(),
      probe: probeMock(),
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0].verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(JSON.stringify(out)).not.toContain(RESOLVED_BASE);
  });

  it('une seule langue : pas de multi', async () => {
    const out = await enrichWithProbe([cached(HASH_A)], {
      debrid: debridMock(),
      probe: probeMock({ container: 'mkv', audio: [{ lang: 'fr', codec: 'AAC' }], subtitles: [] }),
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0].verifiedLanguages).toEqual(['fr']);
    expect(out[0].parsed.languages).toEqual(['fr']);
  });

  it('sonde réussie sans piste audio : verifiedLanguages vide (sonde faite, aucune langue)', async () => {
    const out = await enrichWithProbe([cached(HASH_A)], {
      debrid: debridMock(),
      probe: probeMock({ container: 'mp4', audio: [], subtitles: [] }),
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0].verifiedLanguages).toEqual([]);
    expect(out[0].verifiedAudio).toEqual([]);
  });

  it('transmet fetch à la sonde', async () => {
    const fetchStub = vi.fn() as unknown as FetchFn;
    const probe = probeMock();

    await enrichWithProbe([cached(HASH_A)], {
      debrid: debridMock(),
      probe,
      cache: new ProbeCache<MediaProbe>(),
      fetch: fetchStub,
      topN: 1,
    });

    expect(probe.mock.calls[0]?.[1]?.fetch).toBe(fetchStub);
  });

  it('cache déjà rempli : ni résolution du lien ni sonde', async () => {
    const debrid = debridMock();
    const probe = probeMock();
    const cache = new ProbeCache<MediaProbe>();
    cache.set(probeCacheKey(HASH_A, 0), FR_EN);

    const [out] = await enrichWithProbe([cached(HASH_A, 0)], { debrid, probe, cache, topN: 1 });

    expect(debrid.resolve).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(out.verifiedLanguages).toEqual(VERIFIED_FR_EN);
  });

  it('dedup : deux candidats de même clé donnent une seule sonde et une seule résolution', async () => {
    const debrid = debridMock();
    const probe = probeMock();

    const out = await enrichWithProbe([cached(HASH_A, 1), cached(HASH_A, 1)], {
      debrid,
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 2,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(debrid.resolve).toHaveBeenCalledTimes(1);
    expect(out[0].verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(out[1].verifiedLanguages).toEqual(VERIFIED_FR_EN);
  });

  it('non caché ou sans débrideur : ignoré', async () => {
    const debrid = debridMock();
    const probe = probeMock();
    const input = [notCached(HASH_A), cached(HASH_B)];

    const withoutDebrid = await enrichWithProbe(input, { probe, cache: new ProbeCache<MediaProbe>(), topN: 5 });
    const notCachedOnly = await enrichWithProbe([notCached(HASH_C)], {
      debrid,
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 5,
    });

    expect(withoutDebrid).toBe(input);
    expect(notCachedOnly[0].verifiedLanguages).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(debrid.resolve).not.toHaveBeenCalled();
  });

  it('topN compte les éligibles seulement, dans l ordre du classement', async () => {
    const probe = probeMock();
    const input = [notCached(HASH_C), cached(HASH_A), notCached(HASH_B), cached(HASH_B, 0)];

    const out = await enrichWithProbe(input, {
      debrid: debridMock(),
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(out[1].verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(out[3]).toBe(input[3]);
  });

  it('échec isolé : refus de sonde et erreur du débrideur n empêchent pas le troisième', async () => {
    const debrid = debridMock((hash) => hash === HASH_B);
    const probe = vi.fn(async (url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      return url.endsWith(HASH_A) ? null : FR_EN;
    });
    const input = [cached(HASH_A), cached(HASH_B), cached(HASH_C)];

    const out = await enrichWithProbe(input, { debrid, probe, cache: new ProbeCache<MediaProbe>(), topN: 3 });

    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[2].verifiedLanguages).toEqual(VERIFIED_FR_EN);
  });

  it('exception de la sonde : candidat inchangé, aucune exception remontée', async () => {
    const input = [cached(HASH_A)];
    const probe = vi.fn(async (): Promise<MediaProbe | null> => {
      throw new Error('réseau');
    });

    const out = await enrichWithProbe(input, {
      debrid: debridMock(),
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0]).toBe(input[0]);
  });

  it('budget dépassé : les sondes terminées sont gardées, les autres restent inchangées, sans attendre', async () => {
    const probe = vi.fn((url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      if (url.endsWith(HASH_B)) return new Promise<null>(() => undefined);
      return Promise.resolve(FR_EN);
    });
    const input = [cached(HASH_A), cached(HASH_B)];
    const started = Date.now();

    const out = await enrichWithProbe(input, {
      debrid: debridMock(),
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 2,
      budgetMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(out[0].verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(out[1]).toBe(input[1]);
  });

  it('concurrence : au plus 3 sondes simultanées', async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = vi.fn(async (_url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return FR_EN;
    });
    const input = [cached(HASH_A), cached(HASH_B), cached(HASH_C), cached('d'.repeat(40)), cached('e'.repeat(40))];

    const out = await enrichWithProbe(input, {
      debrid: debridMock(),
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 5,
      budgetMs: 2000,
    });

    expect(peak).toBe(3);
    expect(out.every((c) => c.verifiedLanguages !== undefined)).toBe(true);
  });
});

describe('enrichWithProbe : liens directs', () => {
  it('lien direct sondé : directVerified à vrai, aucun débrideur appelé', async () => {
    const debrid = debridMock();
    const probe = probeMock();

    const [out] = await enrichWithProbe([direct(DIRECT_URL)], {
      debrid,
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe.mock.calls[0]?.[0]).toBe(DIRECT_URL);
    expect(debrid.resolve).not.toHaveBeenCalled();
    expect(out.directVerified).toBe(true);
    expect(out.verifiedLanguages).toEqual(VERIFIED_FR_EN);
  });

  it('lien direct en échec : directVerified absent, candidat inchangé', async () => {
    const input = [direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, {
      probe: probeMock(null),
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0]).toBe(input[0]);
    expect(out[0].directVerified).toBeUndefined();
  });

  it('lien direct non http(s) : ignoré', async () => {
    const probe = probeMock();

    await enrichWithProbe([direct('ftp://cdn.example.com/film.mkv')], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe).not.toHaveBeenCalled();
  });

  it('dedup : deux liens directs identiques donnent une seule sonde', async () => {
    const probe = probeMock();

    const out = await enrichWithProbe([direct(DIRECT_URL), direct(DIRECT_URL)], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 2,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(out.every((c) => c.directVerified === true)).toBe(true);
  });
});

describe('enrichWithProbe : cas limites', () => {
  it('topN à 0 : aucune action, même tableau renvoyé', async () => {
    const debrid = debridMock();
    const probe = probeMock();
    const input = [cached(HASH_A), direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, { debrid, probe, cache: new ProbeCache<MediaProbe>(), topN: 0 });

    expect(out).toBe(input);
    expect(probe).not.toHaveBeenCalled();
    expect(debrid.resolve).not.toHaveBeenCalled();
  });

  it('aucun candidat éligible : même tableau renvoyé', async () => {
    const input = [notCached(HASH_A)];

    const out = await enrichWithProbe(input, { probe: probeMock(), cache: new ProbeCache<MediaProbe>(), topN: 3 });

    expect(out).toBe(input);
  });
});
