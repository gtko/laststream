import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config/schema.js';
import { getStreams, type PipelineContext } from '../src/pipeline.js';
import type { FetchFn } from '../src/sources/http.js';
import type { LocalProwlarr } from '../src/sources/local-prowlarr.js';
import type { ContentRef } from '../src/types.js';

/*
 * Les seules sources par défaut sont les addons Stremio amont : torznab, Prowlarr, Jackett et le Prowlarr local détecté
 * ne sont jamais interrogés tant que LASTADDON_LEGACY_INDEXERS n'est pas à 1.
 */

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const UP = 'https://up.example.test';
const hosts: string[] = [];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fakeFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  hosts.push(url.hostname);
  if (url.hostname === 'up.example.test' && url.pathname.startsWith('/stream/')) {
    return json({ streams: [{ name: 'Up', title: 'Film.2024.1080p.WEB-DL.x264-GRP', url: 'https://cdn.example.test/film.mkv' }] });
  }
  if (url.hostname === 'v3-cinemeta.strem.io') return json({ meta: { runtime: '120 min' } });
  return json({});
}) as unknown as FetchFn;

const ctx = (extra: Partial<PipelineContext> = {}): PipelineContext => ({
  playBaseUrl: 'http://localhost',
  configToken: 'tok',
  secret: 'secret',
  fetch: fakeFetch,
  cache: false,
  wait: 'full',
  ...extra,
});

const config = () =>
  parseConfig({
    autoProwlarr: true,
    localProwlarr: { enabled: true },
    sources: [
      { type: 'upstream', name: 'Amont', url: UP },
      { type: 'torznab', name: 'Torz', baseUrl: 'https://torz.example.test', apiKey: 'k-torz' },
      { type: 'prowlarr', name: 'Prow', baseUrl: 'https://prow.example.test', apiKey: 'k-prow' },
      { type: 'jackett', name: 'Jack', baseUrl: 'https://jack.example.test', apiKey: 'k-jack' },
    ],
  });

afterEach(() => {
  hosts.length = 0;
  vi.unstubAllEnvs();
});

describe('indexeurs désactivés par défaut', () => {
  it('le schéma n active plus le Prowlarr local par défaut', () => {
    const parsed = parseConfig({});
    expect(parsed.autoProwlarr).toBe(false);
    expect(parsed.localProwlarr.enabled).toBe(false);
  });

  it('seul l addon amont est interrogé, même si la configuration contient des indexeurs', async () => {
    const local = vi.fn(async (): Promise<LocalProwlarr | null> => ({ baseUrl: 'http://localhost:9696', apiKey: 'k-local', indexerCount: 1 }));
    const result = await getStreams(config(), MOVIE, ctx({ localProwlarr: local }));
    expect(result.errors).toEqual([]);
    expect(hosts).toContain('up.example.test');
    expect(hosts.filter((h) => /torz|prow|jack|localhost/.test(h))).toEqual([]);
    expect(local).not.toHaveBeenCalled();
  });

  it('LASTADDON_LEGACY_INDEXERS=1 rétablit l ancien comportement', async () => {
    vi.stubEnv('LASTADDON_LEGACY_INDEXERS', '1');
    await getStreams(config(), MOVIE, ctx());
    expect(hosts).toContain('torz.example.test');
  });

  it('les routes /config/indexers ne sont pas montées par défaut', async () => {
    const app = createApp({ secret: 'secret', allowPlain: true, fetch: fakeFetch as unknown as typeof fetch });
    const res = await app.request('/config/indexers', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
  });
});
