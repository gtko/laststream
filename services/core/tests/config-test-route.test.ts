import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeConfig } from '../src/config/codec.js';
import type { ConfigInput } from '../src/config/schema.js';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, postJson, type RunningApp, SECRET, startApp } from './lt-harness.js';

/** Configuration de test : un service TMDB, un service OpenRouter et une source upstream (manifeste simulé). */
const CONFIG: ConfigInput = {
  services: { tmdbToken: KEYS.tmdbToken, openrouterApiKey: KEYS.openrouterApiKey },
  sources: [{ type: 'upstream', name: 'Source test', url: 'https://up.example.com/' }],
};

/** Résultat attendu pour CONFIG : chaque clé et chaque source testées, rien d'autre. */
const EXPECTED = {
  sources: [{ name: 'Source test', type: 'upstream', ok: true, manifest: { types: [], hasStream: true } }],
  services: [
    { name: 'TMDB (jeton v4)', type: 'tmdbToken', ok: true },
    { name: 'OpenRouter', type: 'openrouterApiKey', ok: true },
  ],
};

/** Configuration en JSON brut encodé en base64url (accepté seulement avec allowPlain). */
const plainToken = (config: ConfigInput): string => Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');

let upstream: MockUpstream;
let app: RunningApp;
let plainApp: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    'https://api.themoviedb.org/3/configuration': (call) =>
      call.headers.authorization === `Bearer ${KEYS.tmdbToken}` ? json({ images: {} }) : json({ status_message: 'invalid' }, 401),
    'https://openrouter.ai/api/v1/auth/key': () => json({ data: { label: 'ok' } }),
    'https://up.example.com/manifest.json': () => json({ id: 'up.example', resources: ['stream'] }),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
  plainApp = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), allowPlain: true });
});

afterAll(async () => {
  await app.close();
  await plainApp.close();
});

const probe = (base: string, body: unknown): Promise<Response> => fetch(`${base}/config/test`, postJson(body));

describe('POST /config/test : formes de corps acceptées', () => {
  it('objet de configuration brut (configurateur) : toutes les clés et sources testées', async () => {
    const res = await probe(app.baseUrl, CONFIG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED);
  });

  it('{ config: objet } : mêmes résultats que l\'objet brut (et non une configuration vide)', async () => {
    const res = await probe(app.baseUrl, { config: CONFIG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED);
  });

  it('{ config: chaîne chiffrée } : déchiffrée, mêmes résultats', async () => {
    const res = await probe(app.baseUrl, { config: encodeConfig(CONFIG, SECRET) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED);
  });

  it('{ config: JSON brut } refusé sans LASTADDON_ALLOW_PLAIN : 400 invalid_config', async () => {
    const res = await probe(app.baseUrl, { config: plainToken(CONFIG) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config', issues: [expect.stringMatching(/^config: /)] });
  });

  it('{ config: JSON brut } accepté avec allowPlain : mêmes résultats', async () => {
    const res = await probe(plainApp.baseUrl, { config: plainToken(CONFIG) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED);
  });

  it('{ config } de type inattendu (nombre) : 400 invalid_config, jamais une configuration vide', async () => {
    const res = await probe(app.baseUrl, { config: 42 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config', issues: ['config: chaîne encodée ou objet attendu'] });
  });

  it('{ config } chaîne illisible : 400 invalid_config', async () => {
    const res = await probe(app.baseUrl, { config: 'pas une config !' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_config' });
  });

  it('aucune clé ni URL de service dans la réponse', async () => {
    const raw = await (await probe(app.baseUrl, { config: encodeConfig(CONFIG, SECRET) })).text();
    for (const value of [KEYS.tmdbToken, KEYS.openrouterApiKey]) expect(raw).not.toContain(value);
    expect(raw).not.toContain('https://');
  });
});

describe('POST /config/test : sources désactivées et manifest d’un addon amont', () => {
  let own: MockUpstream;
  let ownApp: RunningApp;

  beforeAll(async () => {
    own = mockUpstream({
      'https://tok.example.com/TOKEN-XYZ-123/manifest.json': () =>
        json({
          id: 'tok.addon',
          name: 'Addon TOKEN-XYZ-123',
          version: '2.0',
          description: 'Flux FR',
          logo: 'https://tok.example.com/TOKEN-XYZ-123/logo.png',
          types: ['movie'],
          resources: ['stream'],
        }),
      'https://down.example.com/manifest.json': () => json({ id: 'down', resources: ['stream'] }),
    });
    ownApp = await startApp({ fetch: own.fetch, lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    await ownApp.close();
  });

  it('source désactivée : rapportée « désactivée » et jamais interrogée ; source active : manifest sans jeton', async () => {
    const res = await probe(ownApp.baseUrl, {
      sources: [
        { name: 'Off', type: 'upstream', url: 'https://down.example.com/', enabled: false },
        { name: 'On', type: 'upstream', url: 'https://tok.example.com/TOKEN-XYZ-123/manifest.json' },
      ],
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(body).sources).toEqual([
      { name: 'Off', type: 'upstream', enabled: false, ok: false, error: 'désactivée' },
      {
        name: 'On',
        type: 'upstream',
        ok: true,
        manifest: { name: 'Addon ***', version: '2.0', description: 'Flux FR', types: ['movie'], hasStream: true },
      },
    ]);
    expect(own.callsTo('https://down.example.com/manifest.json')).toHaveLength(0);
    expect(body).not.toContain('TOKEN-XYZ-123');
    expect(body).not.toContain('tok.example.com');
  });
});
