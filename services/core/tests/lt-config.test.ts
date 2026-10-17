import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { configJsonSchema, ConfigValidationError, parseConfig } from '../src/config/schema.js';
import { isLiteralSafe, parseSafeUrl, createPublicGuard, UnsafeTargetError } from '../src/lt/guard.js';
import { fakeLookup, json, KEYS, mockUpstream, postJson, startApp, tokenFor, type RunningApp, type MockUpstream } from './lt-harness.js';

describe('schéma de configuration : services', () => {
  it('libellés et descriptions en français dans /config/schema', () => {
    const schema = configJsonSchema() as {
      properties: { services: { title?: string; properties: Record<string, { title?: string; description?: string }> } };
    };
    const services = schema.properties.services;
    expect(services.title).toBe('Services');
    expect(services.properties.tmdbToken).toMatchObject({ title: 'Jeton TMDB (lecture v4)' });
    expect(services.properties.tmdbToken?.description).toContain('Bearer');
    expect(services.properties.openrouterApiKey?.title).toBe('Clé OpenRouter');
    expect(services.properties.openrouterModel?.title).toBe('Modèle OpenRouter');
  });

  it('services absent : valeurs par défaut (modèle openai/gpt-4o-mini) et aucune clé', () => {
    const config = parseConfig({});
    expect(config.services.openrouterModel).toBe('openai/gpt-4o-mini');
    expect(config.services.tmdbToken).toBeUndefined();
  });

  it('une clé vide est refusée', () => {
    expect(() => parseConfig({ services: { tmdbToken: '' } })).toThrow(ConfigValidationError);
  });

  it('le schéma d entrée ne rend pas services obligatoire', () => {
    const schema = configJsonSchema() as { required?: string[] };
    expect(schema.required ?? []).not.toContain('services');
  });
});

describe('POST /config/test : services', () => {
  let upstream: MockUpstream;
  let app: RunningApp;

  beforeAll(async () => {
    upstream = mockUpstream({
      'https://api.themoviedb.org/3/configuration': (call) => {
        const bearer = call.headers.authorization === `Bearer ${KEYS.tmdbToken}`;
        const apiKey = call.url.searchParams.get('api_key') === KEYS.tmdbApiKey;
        return bearer || apiKey ? json({ images: {} }) : json({ status_message: 'invalid' }, 401);
      },
      'https://api.mdblist.com/imdb/movie/tt0133093': () => json({ error: 'bad key' }, 401),
      'https://api4.thetvdb.com/v4/login': () => json({ data: { token: 'session' } }),
      'https://openrouter.ai/api/v1/auth/key': () => json({ data: { label: 'ok' } }),
      'https://webservice.fanart.tv/v3/movies/603': () => json({ error: 'nope' }, 401),
    });
    app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    await app.close();
  });

  it('teste chaque clé configurée, sans jamais renvoyer une clé ni une URL', async () => {
    const config = {
      services: {
        tmdbToken: KEYS.tmdbToken,
        tmdbApiKey: KEYS.tmdbApiKey,
        mdblistApiKey: KEYS.mdblistApiKey,
        tvdbApiKey: KEYS.tvdbApiKey,
        openrouterApiKey: KEYS.openrouterApiKey,
        fanartApiKey: KEYS.fanartApiKey,
      },
    };
    const res = await fetch(`${app.baseUrl}/config/test`, postJson(config, { origin: 'http://localhost:8089' }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { sources: unknown[]; services: { name: string; type: string; ok: boolean; error?: string }[] };
    expect(body.sources).toEqual([]);
    expect(body.services.map((s) => [s.type, s.ok, s.error])).toEqual([
      ['tmdbToken', true, undefined],
      ['tmdbApiKey', true, undefined],
      ['mdblistApiKey', false, 'upstream_401'],
      ['tvdbApiKey', true, undefined],
      ['openrouterApiKey', true, undefined],
      ['fanartApiKey', false, 'upstream_401'],
    ]);
    for (const value of Object.values(KEYS)) expect(raw).not.toContain(value);
    expect(raw).not.toContain('https://');
  });

  it('service non configuré : absent du rapport', async () => {
    const res = await fetch(`${app.baseUrl}/config/test`, postJson({ services: { openrouterApiKey: KEYS.openrouterApiKey } }));
    const body = (await res.json()) as { services: { type: string }[] };
    expect(body.services.map((s) => s.type)).toEqual(['openrouterApiKey']);
  });

  it('services invalides : 400 invalid_config', async () => {
    const res = await fetch(`${app.baseUrl}/config/test`, postJson({ services: { tmdbToken: '' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config', issues: expect.any(Array) });
  });
});

describe('CORS des routes lt', () => {
  let app: RunningApp;

  beforeAll(async () => {
    app = await startApp({ lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (): string => tokenFor({ openrouterApiKey: KEYS.openrouterApiKey });

  it('GET lt : Access-Control-Allow-Origin * pour toute origine', async () => {
    const res = await fetch(`${app.baseUrl}/${token()}/lt/health`, { headers: { Origin: 'https://anywhere.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('POST lt : origine autorisée renvoyée, origine inconnue sans en-tête ACAO', async () => {
    const allowed = await fetch(`${app.baseUrl}/${token()}/lt/why`, postJson({}, { origin: 'http://localhost:8089' }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:8089');
    const foreign = await fetch(`${app.baseUrl}/${token()}/lt/why`, postJson({}, { origin: 'https://evil.example' }));
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('préflight GET depuis une origine quelconque : ACAO * ; préflight POST inconnu : aucun ACAO', async () => {
    const get = await fetch(`${app.baseUrl}/${token()}/lt/tv/channels`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://anywhere.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
    const post = await fetch(`${app.baseUrl}/${token()}/lt/why`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(post.status).toBe(204);
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('limite de débit des POST lt', () => {
  it('30 POST par minute et par IP, puis 429 rate_limited ; les GET ne sont pas limités', async () => {
    const app = await startApp({ lookupHost: fakeLookup() });
    try {
      const token = tokenFor({ openrouterApiKey: KEYS.openrouterApiKey });
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) {
        statuses.push((await fetch(`${app.baseUrl}/${token}/lt/why`, postJson({ title: '' }))).status);
      }
      expect(statuses.every((s) => s === 400)).toBe(true);
      const blocked = await fetch(`${app.baseUrl}/${token}/lt/why`, postJson({ title: '' }));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await blocked.json()).toEqual({ error: 'rate_limited' });
      expect((await fetch(`${app.baseUrl}/${token}/lt/health`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('garde d URL (adresses privées et noms locaux)', () => {
  it.each([
    'http://localhost/x',
    'http://box.local/x',
    'http://api.internal/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://169.254.169.254/latest',
    'http://192.168.0.5/x',
    'http://[::1]/x',
    'ftp://example.com/x',
  ])('refuse %s', (raw) => {
    expect(parseSafeUrl(raw)).toBeNull();
  });

  it('accepte une URL publique http(s)', () => {
    expect(parseSafeUrl('https://cdn.example.com/a.m3u8')?.hostname).toBe('cdn.example.com');
    expect(isLiteralSafe(new URL('http://8.8.8.8/x'))).toBe(true);
  });

  it('garde : contrôle littéral seulement, sans résolution DNS (contrôlée à la connexion, voir sources-pinned)', async () => {
    const guard = createPublicGuard();
    await expect(guard(new URL('https://cdn.example.com/a'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://192.168.1.9/a'))).rejects.toBeInstanceOf(UnsafeTargetError);
  });
});
