import { describe, expect, it, vi } from 'vitest';
import { enrichWithProbe } from '../src/engine/probe-step.js';
import type { Ranked } from '../src/engine/types.js';
import type { MediaProbe, ProbeOptions } from '../src/media/probe.js';
import { ProbeCache } from '../src/media/probe-cache.js';
import { cand, ranked as asRanked } from './engine-fixtures.js';

const HASH_A = 'a'.repeat(40);
const DIRECT_URL = 'https://cdn.example.com/media/film.mkv';

const FR_EN: MediaProbe = {
  container: 'mkv',
  audio: [
    { lang: 'fr', codec: 'EAC3', channels: 6, atmos: false },
    { lang: 'en', codec: 'TrueHD', channels: 8, atmos: true },
  ],
  subtitles: [],
};

const VERIFIED_FR_EN = ['fr', 'en', 'multi'];

/** Candidat sans lien direct, avec un infoHash : jamais sondé (le serveur ne résout aucun lien débridé). */
function notDirect(hash: string): Ranked {
  return asRanked(cand({ cached: true, raw: { infoHash: hash, title: 'Film.2024.1080p.WEB-DL' } }));
}

/** Lien direct http(s). */
function direct(url: string): Ranked {
  return asRanked(cand({ raw: { url, title: 'Film.2024.1080p.WEB-DL' } }));
}

/** Lien direct distinct par indice (une sonde par lien). */
function directAt(index: number): Ranked {
  return direct(`https://cdn.example.com/media/${index}.mkv`);
}

/** Sonde factice qui renvoie toujours `result`. */
function probeMock(result: MediaProbe | null = FR_EN) {
  return vi.fn(async (_url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => result);
}

describe('enrichWithProbe : liens directs', () => {
  it('lien direct sondé : directVerified à vrai, langues vérifiées', async () => {
    const probe = probeMock();

    const [out] = await enrichWithProbe([direct(DIRECT_URL)], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe.mock.calls[0]?.[0]).toBe(DIRECT_URL);
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

  it('budget dépassé : les sondes terminées sont gardées, les autres restent inchangées, sans attendre', async () => {
    const probe = vi.fn((url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      if (url.endsWith('/1.mkv')) return new Promise<null>(() => undefined);
      return Promise.resolve(FR_EN);
    });
    const input = [directAt(0), directAt(1)];
    const started = Date.now();

    const out = await enrichWithProbe(input, {
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
    const input = [0, 1, 2, 3, 4].map(directAt);

    const out = await enrichWithProbe(input, {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 5,
      budgetMs: 2000,
    });

    expect(peak).toBe(3);
    expect(out.every((c) => c.verifiedLanguages !== undefined)).toBe(true);
  });
});

describe('enrichWithProbe : cas limites', () => {
  it('topN à 0 : aucune action, même tableau renvoyé', async () => {
    const probe = probeMock();
    const input = [notDirect(HASH_A), direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, { probe, cache: new ProbeCache<MediaProbe>(), topN: 0 });

    expect(out).toBe(input);
    expect(probe).not.toHaveBeenCalled();
  });

  it('aucun candidat éligible (sans lien direct) : même tableau renvoyé, aucune sonde', async () => {
    const probe = probeMock();
    const input = [notDirect(HASH_A)];

    const out = await enrichWithProbe(input, { probe, cache: new ProbeCache<MediaProbe>(), topN: 3 });

    expect(out).toBe(input);
    expect(probe).not.toHaveBeenCalled();
  });
});
