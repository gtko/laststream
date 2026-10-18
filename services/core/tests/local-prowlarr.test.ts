import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeConfig } from '../src/config/codec.js';
import { configJsonSchema, parseConfig } from '../src/config/schema.js';
import { getStreams, type PipelineContext } from '../src/pipeline.js';
import type { FetchFn } from '../src/sources/http.js';
import {
  apiKeyFromXml,
  clearLocalProwlarrCache,
  defaultConfigPath,
  detectLocalProwlarr,
  effectiveSources,
  LOCAL_PROWLARR_CACHE_MS,
  localProwlarrStatus,
  localProwlarrStatusOf,
  type LocalProwlarr,
  type LocalProwlarrIo,
} from '../src/sources/local-prowlarr.js';
import { clearProwlarrDiscoveryCache } from '../src/sources/prowlarr.js';
import type { ContentRef } from '../src/types.js';
import { json, SECRET, startApp } from './lt-harness.js';

/* Prowlarr local : détection (env, config.xml, cache, mode public), sources effectives, pipeline et routes.
 * Aucun réseau : fetch et lecture de fichiers sont simulés. La clé de test n'apparaît jamais dans une réponse. */

const KEY = 'LOCAL-PROWLARR-KEY-7731';
const BASE = 'http://localhost:9696';
const HASH = '4'.repeat(40);
const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const LOCAL: LocalProwlarr = { baseUrl: BASE, apiKey: KEY, indexerCount: 1 };

const INDEXERS = [
  {
    id: 1,
    name: 'Alpha',
    protocol: 'torrent',
    enable: true,
    privacy: 'public',
    capabilities: { movieSearchParams: ['q', 'imdbId'], tvSearchParams: ['q', 'season', 'ep', 'imdbId'] },
  },
];

const RESULTS = [
  {
    guid: 'guid-1',
    title: 'Film.2001.1080p.BluRay.x264',
    protocol: 'torrent',
    size: 2_000_000_000,
    seeders: 12,
    magnetUrl: `magnet:?xt=urn:btih:${HASH}&dn=Film`,
    indexerId: 1,
  },
];

type Handler = (url: URL, init?: RequestInit) => Response;

/** Faux fetch : enregistre les appels, sans réseau. */
function fakeFetch(handler: Handler) {
  const mock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(new URL(raw), init));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

/** Prowlarr local qui répond : indexeurs et résultats de recherche. Les autres hôtes renvoient 404. */
const prowlarrHandler: Handler = (url) => {
  if (url.origin === BASE && url.pathname === '/api/v1/indexer') return json(INDEXERS);
  if (url.origin === BASE && url.pathname === '/api/v1/search') return json(RESULTS);
  return json({}, 404);
};

const noFile = (): string => {
  throw new Error('ENOENT');
};

/** Entrées de détection par défaut : aucun fichier, Linux, fetch qui répond. */
function io(env: Record<string, string>, extra: Partial<LocalProwlarrIo> = {}): LocalProwlarrIo {
  return { env, readFile: noFile, fetch: fakeFetch(prowlarrHandler).fetch, platform: 'linux', homeDir: '/home/tester', ...extra };
}

const CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>\n<Config>\n  <Port>9696</Port>\n  <ApiKey>${KEY}</ApiKey>\n</Config>`;

beforeEach(() => {
  clearLocalProwlarrCache();
  clearProwlarrDiscoveryCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('détection : clé API', () => {
  it('lit la clé dans LASTADDON_PROWLARR_KEY et valide par la découverte des indexeurs', async () => {
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    const readFile = vi.fn(noFile);
    const found = await detectLocalProwlarr(io({ LASTADDON_PROWLARR_KEY: KEY }, { fetch, readFile }));
    expect(found).toEqual(LOCAL);
    expect(readFile).not.toHaveBeenCalled();
    const [called, init] = mock.mock.calls[0] ?? [];
    expect(String(called)).toBe(`${BASE}/api/v1/indexer`);
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe(KEY);
  });

  it('lit la clé dans config.xml (balise ApiKey) au chemin de LASTADDON_PROWLARR_CONFIG_PATH', async () => {
    const readFile = vi.fn((path: string) => {
      if (path === '/srv/prowlarr/config.xml') return CONFIG_XML;
      throw new Error('ENOENT');
    });
    const found = await detectLocalProwlarr(io({ LASTADDON_PROWLARR_CONFIG_PATH: '/srv/prowlarr/config.xml' }, { readFile }));
    expect(found).toEqual(LOCAL);
    expect(readFile).toHaveBeenCalledWith('/srv/prowlarr/config.xml');
  });

  it('chemin par défaut Windows : C:\\ProgramData\\Prowlarr\\config.xml', async () => {
    const readFile = vi.fn(noFile);
    await detectLocalProwlarr(io({}, { readFile, platform: 'win32' }));
    expect(readFile).toHaveBeenCalledWith('C:\\ProgramData\\Prowlarr\\config.xml');
    expect(defaultConfigPath('win32', '/ignored')).toBe('C:\\ProgramData\\Prowlarr\\config.xml');
  });

  it('chemin par défaut Linux : ~/.config/Prowlarr/config.xml', async () => {
    const readFile = vi.fn(noFile);
    await detectLocalProwlarr(io({}, { readFile, platform: 'linux', homeDir: '/home/tester' }));
    expect(readFile).toHaveBeenCalledWith(join('/home/tester', '.config', 'Prowlarr', 'config.xml'));
  });

  it('clé introuvable (ni variable ni fichier) : null, sans appel réseau', async () => {
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    expect(await detectLocalProwlarr(io({}, { fetch }))).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('extrait la balise ApiKey sans renvoyer le reste du document', () => {
    expect(apiKeyFromXml(CONFIG_XML)).toBe(KEY);
    expect(apiKeyFromXml('<Config></Config>')).toBeUndefined();
  });
});

describe('détection : validation et cache', () => {
  it('instance qui refuse la clé (HTTP 401) : null, jamais d’exception', async () => {
    const { fetch } = fakeFetch(() => json({}, 401));
    await expect(detectLocalProwlarr(io({ LASTADDON_PROWLARR_KEY: KEY }, { fetch }))).resolves.toBeNull();
  });

  it('instance injoignable (fetch rejeté) : null, jamais d’exception', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const fetch = failing as unknown as FetchFn;
    await expect(detectLocalProwlarr(io({ LASTADDON_PROWLARR_KEY: KEY }, { fetch }))).resolves.toBeNull();
  });

  it('LASTADDON_PROWLARR_URL remplace la base, sans slash final', async () => {
    const { fetch, mock } = fakeFetch((url) =>
      url.origin === 'http://127.0.0.1:9797' && url.pathname === '/api/v1/indexer' ? json(INDEXERS) : json({}, 404),
    );
    const found = await detectLocalProwlarr(
      io({ LASTADDON_PROWLARR_KEY: KEY, LASTADDON_PROWLARR_URL: 'http://127.0.0.1:9797/' }, { fetch }),
    );
    expect(found).toEqual({ baseUrl: 'http://127.0.0.1:9797', apiKey: KEY, indexerCount: 1 });
    expect(String(mock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:9797/api/v1/indexer');
  });

  it('LASTADDON_PROWLARR_AUTO=0 désactive la détection : null, ni lecture ni appel', async () => {
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    const readFile = vi.fn(noFile);
    const found = await detectLocalProwlarr(io({ LASTADDON_PROWLARR_AUTO: '0', LASTADDON_PROWLARR_KEY: KEY }, { fetch, readFile }));
    expect(found).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(mock).not.toHaveBeenCalled();
  });

  it('mode public : désactivé par défaut, activé seulement par LASTADDON_PROWLARR_AUTO=1', async () => {
    const off = fakeFetch(prowlarrHandler);
    expect(await detectLocalProwlarr(io({ LASTADDON_PUBLIC: '1', LASTADDON_PROWLARR_KEY: KEY }, { fetch: off.fetch }))).toBeNull();
    expect(off.mock).not.toHaveBeenCalled();

    clearLocalProwlarrCache();
    const on = fakeFetch(prowlarrHandler);
    const found = await detectLocalProwlarr(
      io({ LASTADDON_PUBLIC: '1', LASTADDON_PROWLARR_AUTO: '1', LASTADDON_PROWLARR_KEY: KEY }, { fetch: on.fetch }),
    );
    expect(found).toEqual(LOCAL);
  });

  it('résultat mis en cache 60 s ; clé lue une seule fois après un succès', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    const readFile = vi.fn((path: string) => {
      if (path.endsWith('config.xml')) return CONFIG_XML;
      throw new Error('ENOENT');
    });
    const deps = io({ LASTADDON_PROWLARR_CONFIG_PATH: '/x/config.xml' }, { fetch, readFile });

    expect(await detectLocalProwlarr(deps)).toEqual(LOCAL);
    vi.setSystemTime(new Date(Date.now() + LOCAL_PROWLARR_CACHE_MS - 1_000));
    expect(await detectLocalProwlarr(deps)).toEqual(LOCAL);
    expect(mock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 2_000));
    expect(await detectLocalProwlarr(deps)).toEqual(LOCAL);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('un échec est aussi mis en cache : pas de nouvelle sonde avant 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { fetch, mock } = fakeFetch(() => json({}, 500));
    const deps = io({ LASTADDON_PROWLARR_KEY: KEY }, { fetch });
    expect(await detectLocalProwlarr(deps)).toBeNull();
    expect(await detectLocalProwlarr(deps)).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('statut public et sources effectives', () => {
  it('statut sans URL ni clé, libellé conforme', () => {
    const status = localProwlarrStatus(LOCAL);
    expect(status).toEqual({ detected: true, indexers: 1, label: 'Prowlarr local détecté (1 indexeurs)' });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain(BASE);
    expect(localProwlarrStatus(null)).toEqual({ detected: false, indexers: 0, label: 'Aucun Prowlarr local détecté' });
  });

  it('fournisseur absent ou en échec : statut « non détecté »', async () => {
    expect(await localProwlarrStatusOf(undefined)).toMatchObject({ detected: false });
    expect(
      await localProwlarrStatusOf(() => {
        throw new Error('boom');
      }),
    ).toMatchObject({ detected: false, indexers: 0 });
  });

  it('les sources explicites ne sont jamais remplacées par le Prowlarr local', () => {
    const config = parseConfig({ sources: [{ type: 'upstream', name: 'Amont', url: 'https://up.example.com' }] });
    expect(effectiveSources(config, LOCAL)).toEqual(config.sources);
  });

  it('sans source : le Prowlarr local est utilisé seul, sauf si autoProwlarr est faux', () => {
    const auto = parseConfig({});
    expect(auto.autoProwlarr).toBe(true);
    expect(effectiveSources(auto, LOCAL)).toEqual([
      { type: 'prowlarr', name: 'Prowlarr local', baseUrl: BASE, apiKey: KEY },
    ]);
    expect(effectiveSources(parseConfig({ autoProwlarr: false }), LOCAL)).toEqual([]);
    expect(effectiveSources(auto, null)).toEqual([]);
  });

  it('le champ autoProwlarr est dans le schéma, libellé en français, défaut true', () => {
    const schema = configJsonSchema() as { properties: Record<string, { title?: string; default?: unknown }> };
    expect(schema.properties.autoProwlarr?.title).toBe('Utiliser le Prowlarr local détecté');
    expect(schema.properties.autoProwlarr?.default).toBe(true);
  });
});

describe('pipeline : repli sur le Prowlarr local', () => {
  const movieCtx = (fetch: FetchFn, extra: Partial<PipelineContext> = {}): PipelineContext => ({
    playBaseUrl: 'https://addon.test',
    configToken: 'TOKEN',
    secret: 'local-prowlarr-pipeline-secret',
    fetch,
    probe: async () => null,
    cache: false,
    ...extra,
  });

  it('configuration sans source : interroge le Prowlarr local détecté', async () => {
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    const provider = vi.fn(async () => LOCAL);
    const result = await getStreams(parseConfig({}), MOVIE, movieCtx(fetch, { localProwlarr: provider }));

    expect(provider).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls.some(([input]) => String(input).startsWith(`${BASE}/api/v1/search`))).toBe(true);
    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('configuration avec sources explicites : le fournisseur n’est pas appelé', async () => {
    const { fetch, mock } = fakeFetch(prowlarrHandler);
    const provider = vi.fn(async () => LOCAL);
    const config = parseConfig({ sources: [{ type: 'upstream', name: 'Amont', url: 'https://up.example.com' }] });
    await getStreams(config, MOVIE, movieCtx(fetch, { localProwlarr: provider }));
    expect(provider).not.toHaveBeenCalled();
    expect(mock.mock.calls.some(([input]) => String(input).startsWith(BASE))).toBe(false);
  });

  it('autoProwlarr désactivé : pas d’appel au fournisseur, aucune source', async () => {
    const { fetch } = fakeFetch(prowlarrHandler);
    const provider = vi.fn(async () => LOCAL);
    const result = await getStreams(parseConfig({ autoProwlarr: false }), MOVIE, movieCtx(fetch, { localProwlarr: provider }));
    expect(provider).not.toHaveBeenCalled();
    expect(result.streams).toEqual([]);
  });

  it('fournisseur en échec : la requête reste valide, sans source', async () => {
    const { fetch } = fakeFetch(prowlarrHandler);
    const provider = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await getStreams(parseConfig({}), MOVIE, movieCtx(fetch, { localProwlarr: provider }));
    expect(result.streams).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('routes : statut sans fuite de clé', () => {
  it('GET /config/schema expose localProwlarr sans clé ni URL', async () => {
    const app = await startApp({ localProwlarr: async () => LOCAL });
    try {
      const res = await fetch(`${app.baseUrl}/config/schema`);
      const text = await res.text();
      const body = JSON.parse(text) as { localProwlarr: unknown };
      expect(body.localProwlarr).toEqual({ detected: true, indexers: 1, label: 'Prowlarr local détecté (1 indexeurs)' });
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(BASE);
    } finally {
      await app.close();
    }
  });

  it('POST /config/test expose localProwlarr sans clé', async () => {
    const app = await startApp({ localProwlarr: async () => LOCAL });
    try {
      const res = await fetch(`${app.baseUrl}/config/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ localProwlarr: { detected: true, indexers: 1 } });
      expect(text).not.toContain(KEY);
    } finally {
      await app.close();
    }
  });

  it('GET stream sans source : les résultats du Prowlarr local sont renvoyés, sans clé', async () => {
    const mocked = fakeFetch(prowlarrHandler);
    const app = await startApp({ fetch: mocked.fetch, localProwlarr: async () => LOCAL });
    try {
      const token = encodeConfig({}, SECRET);
      const res = await fetch(`${app.baseUrl}/${token}/stream/movie/tt1234567.json`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('Film.2001.1080p');
      expect(text).not.toContain(KEY);
    } finally {
      await app.close();
    }
  });
});
