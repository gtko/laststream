import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeConfig, encodeConfig } from '../src/config/codec.js';
import type { ConfigInput } from '../src/config/schema.js';
import { postJson, type RunningApp, SECRET, startApp } from './lt-harness.js';

/** Secrets factices de la configuration : aucun ne doit jamais sortir de /config/decode. */
const SECRETS = {
  tmdbToken: 'tmdb-token-LONGSECRET-abcd1234',
  tvdbApiKey: '0123456789abcdef0123456789abcdef',
  tvdbPin: 'pin-9876',
  openrouterApiKey: 'openrouter-key-111',
  debridApiKey: 'AD-KEY-0123456789',
  torznabApiKey: 'short1',
} as const;

const CONFIG: ConfigInput = {
  services: {
    tmdbToken: SECRETS.tmdbToken,
    tvdbApiKey: SECRETS.tvdbApiKey,
    tvdbPin: SECRETS.tvdbPin,
    openrouterApiKey: SECRETS.openrouterApiKey,
    openrouterModel: 'test/model',
  },
  debrid: { service: 'alldebrid', apiKey: SECRETS.debridApiKey },
  sources: [{ type: 'torznab', name: 'Indexeur', baseUrl: 'https://indexer.example.com/api', apiKey: SECRETS.torznabApiKey }],
  maxResults: 12,
};

let app: RunningApp;

beforeAll(async () => {
  app = await startApp({});
});

afterAll(async () => {
  await app.close();
});

const encoded = (config: ConfigInput = CONFIG): string => encodeConfig(config, SECRET);
const decodeBody = (config: unknown): Promise<Response> => fetch(`${app.baseUrl}/config/decode`, postJson({ config }));
const encodeBody = (body: unknown): Promise<Response> => fetch(`${app.baseUrl}/config/encode`, postJson(body));
const plainSecrets = (): string[] => Object.values(SECRETS);

describe('POST /config/decode', () => {
  it('renvoie la configuration avec chaque secret remplacé par son masque, jamais la valeur', async () => {
    const res = await decodeBody(encoded());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = await res.text();
    for (const value of plainSecrets()) expect(raw).not.toContain(value);
    const body = JSON.parse(raw) as {
      services: Record<string, unknown>;
      debrid: { apiKey: unknown };
      sources: { name: string; apiKey: unknown }[];
      maxResults: number;
    };
    expect(body.services.tmdbToken).toEqual({ set: true, last4: '…1234' });
    expect(body.services.tvdbApiKey).toEqual({ set: true, last4: '…cdef' });
    expect(body.services.tvdbPin).toEqual({ set: true });
    expect(body.services.openrouterApiKey).toEqual({ set: true, last4: '…-111' });
    expect(body.debrid.apiKey).toEqual({ set: true, last4: '…6789' });
    expect(body.sources[0]).toEqual({ type: 'torznab', name: 'Indexeur', baseUrl: 'https://indexer.example.com/api', apiKey: { set: true } });
  });

  it('ne change pas les champs non secrets (modèle, nombre de résultats)', async () => {
    const body = (await (await decodeBody(encoded())).json()) as { services: { openrouterModel: string }; maxResults: number };
    expect(body.services.openrouterModel).toBe('test/model');
    expect(body.maxResults).toBe(12);
  });

  it('service sans clé : pas de masque pour ce champ', async () => {
    const body = (await (await decodeBody(encoded({ services: { tmdbToken: SECRETS.tmdbToken } }))).json()) as {
      services: Record<string, unknown>;
    };
    expect(body.services).not.toHaveProperty('tvdbApiKey');
    expect(body.services.tmdbToken).toEqual({ set: true, last4: '…1234' });
  });

  it('configuration illisible ou corps sans chaîne : 400 invalid_config, sans écho', async () => {
    const garbage = await decodeBody('pas une config !');
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: 'invalid_config' });

    const missing = await fetch(`${app.baseUrl}/config/decode`, postJson({ other: SECRETS.tmdbToken }));
    expect(missing.status).toBe(400);
    const raw = await missing.text();
    expect(JSON.parse(raw)).toEqual({ error: 'invalid_config', issues: ['config: chaîne encodée attendue'] });
    expect(raw).not.toContain(SECRETS.tmdbToken);
  });
});

describe('POST /config/encode avec { previous, config }', () => {
  it('garde les secrets vides, absents, masqués ou au libellé « …xxxx » ; applique le reste', async () => {
    const patch = {
      services: {
        tmdbToken: { set: true, last4: '…1234' },
        tvdbApiKey: '',
        openrouterApiKey: '…-111',
        openrouterModel: 'autre/modele',
      },
      debrid: { service: 'alldebrid', apiKey: { set: true, last4: '…6789' } },
      sources: [{ type: 'torznab', name: 'Indexeur', baseUrl: 'https://indexer.example.com/api', apiKey: { set: true } }],
      maxResults: 20,
    };
    const res = await encodeBody({ previous: encoded(), config: patch });
    expect(res.status).toBe(200);
    const decoded = decodeConfig(((await res.json()) as { config: string }).config, SECRET, { allowPlain: false });
    expect(decoded.services.tmdbToken).toBe(SECRETS.tmdbToken);
    expect(decoded.services.tvdbApiKey).toBe(SECRETS.tvdbApiKey);
    expect(decoded.services.tvdbPin).toBe(SECRETS.tvdbPin);
    expect(decoded.services.openrouterApiKey).toBe(SECRETS.openrouterApiKey);
    expect(decoded.debrid?.apiKey).toBe(SECRETS.debridApiKey);
    expect(decoded.sources[0]).toMatchObject({ name: 'Indexeur', apiKey: SECRETS.torznabApiKey });
    expect(decoded.services.openrouterModel).toBe('autre/modele');
    expect(decoded.maxResults).toBe(20);
  });

  it('une nouvelle valeur remplace l\'ancienne', async () => {
    const res = await encodeBody({ previous: encoded(), config: { services: { tmdbToken: 'nouveau-jeton-000000' } } });
    expect(res.status).toBe(200);
    const decoded = decodeConfig(((await res.json()) as { config: string }).config, SECRET, { allowPlain: false });
    expect(decoded.services.tmdbToken).toBe('nouveau-jeton-000000');
    expect(decoded.services.tvdbApiKey).toBe(SECRETS.tvdbApiKey);
  });

  it('sans section services : tous les secrets précédents sont gardés ; sans objet debrid : debrid retiré', async () => {
    const res = await encodeBody({ previous: encoded(), config: { maxResults: 33 } });
    const decoded = decodeConfig(((await res.json()) as { config: string }).config, SECRET, { allowPlain: false });
    expect(decoded.maxResults).toBe(33);
    expect(decoded.services.tmdbToken).toBe(SECRETS.tmdbToken);
    expect(decoded.debrid).toBeUndefined();
  });

  it('sans config : la configuration précédente est reconduite à l\'identique', async () => {
    const res = await encodeBody({ previous: encoded() });
    const decoded = decodeConfig(((await res.json()) as { config: string }).config, SECRET, { allowPlain: false });
    expect(decoded.maxResults).toBe(12);
    expect(decoded.services.tvdbPin).toBe(SECRETS.tvdbPin);
    expect(decoded.sources[0]?.name).toBe('Indexeur');
  });

  it('secret masqué sans configuration précédente : 400 invalid_config, sans écho', async () => {
    const res = await encodeBody({ config: { services: { tmdbToken: { set: true, last4: '…1234' } } } });
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ error: 'invalid_config', issues: expect.any(Array) });
    expect(raw).not.toContain(SECRETS.tmdbToken);
  });

  it('source sans correspondance (autre nom) avec masque : 400 invalid_config', async () => {
    const patch = { sources: [{ type: 'torznab', name: 'Autre', baseUrl: 'https://indexer.example.com/api', apiKey: { set: true } }] };
    const res = await encodeBody({ previous: encoded(), config: patch });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_config' });
  });

  it('précédente illisible : 400 invalid_config, sans écho', async () => {
    const res = await encodeBody({ previous: 'pas une config !', config: { maxResults: 5 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_config' });
  });

  it('forme directe inchangée : une configuration brute est chiffrée telle quelle', async () => {
    const res = await encodeBody({ maxResults: 10, services: { tmdbToken: SECRETS.tmdbToken } });
    expect(res.status).toBe(200);
    const decoded = decodeConfig(((await res.json()) as { config: string }).config, SECRET, { allowPlain: false });
    expect(decoded.maxResults).toBe(10);
    expect(decoded.services.tmdbToken).toBe(SECRETS.tmdbToken);
  });
});
