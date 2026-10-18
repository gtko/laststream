import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { newApp, type App } from '../src/http/app-env.js';
import { clientAddress } from '../src/http/client-ip.js';
import { errorHandler, etag, notFound } from '../src/http/common.js';
import { jsonBody } from '../src/http/json-body.js';
import { originalUrl, queryParams, sendJson } from '../src/http/respond.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Mini application : corps JSON (limite configurable), écho du corps et de la requête, erreurs et 404 communs. */
function echoApp(limit?: number): App {
  const app = newApp();
  app.use('*', jsonBody(limit));
  app.post('/echo', (c) => sendJson(c, { body: c.get('body') ?? null }));
  app.get('/q', (c) => sendJson(c, { query: queryParams(c), url: originalUrl(c) }));
  app.onError(errorHandler);
  app.notFound(notFound);
  return app;
}

const post = (app: App, body: string, headers: Record<string, string> = JSON_HEADERS): Promise<Response> =>
  Promise.resolve(app.request('/echo', { method: 'POST', headers, body }));

describe('jsonBody : mêmes règles que le parseur d\'Express', () => {
  it('objet et tableau acceptés', async () => {
    const app = echoApp();
    expect(await (await post(app, '{"a":1}')).json()).toEqual({ body: { a: 1 } });
    expect(await (await post(app, '[1,2]')).json()).toEqual({ body: [1, 2] });
  });

  it('corps vide en JSON : objet vide ; autre type de contenu : pas de corps', async () => {
    const app = echoApp();
    expect(await (await post(app, '')).json()).toEqual({ body: {} });
    expect(await (await post(app, '{"a":1}', { 'content-type': 'text/plain' })).json()).toEqual({ body: null });
  });

  it('JSON invalide ou primitif : 400 bad_request générique, sans contenu', async () => {
    const app = echoApp();
    for (const body of ['{bad', '"texte"', '42', 'null']) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('au-delà de la limite : 413 (taille annoncée comme flux)', async () => {
    const app = echoApp(32);
    const big = JSON.stringify({ pad: 'x'.repeat(100) });
    const declared = await post(app, big);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'bad_request' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await app.request('/echo', { method: 'POST', headers: JSON_HEADERS, body: stream, duplex: 'half' } as RequestInit);
    expect(streamed.status).toBe(413);
  });

  it('juste sous la limite : accepté', async () => {
    const app = echoApp(64);
    expect((await post(app, JSON.stringify({ a: 'x'.repeat(40) }))).status).toBe(200);
  });

  it('jeu de caractères autre qu\'utf-8 ou encodage de contenu : 415', async () => {
    const app = echoApp();
    expect((await post(app, '{}', { 'content-type': 'application/json; charset=latin1' })).status).toBe(415);
    expect((await post(app, '{}', { ...JSON_HEADERS, 'content-encoding': 'gzip' })).status).toBe(415);
    expect((await post(app, '{}', { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  });
});

describe('réponses communes', () => {
  it('sendJson : application/json; charset=utf-8', async () => {
    const res = await echoApp().request('/q?a=1');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('paramètres répétés : tableau ; originalUrl : chemin et requête bruts', async () => {
    const res = await echoApp().request('/q?a=1&a=2&b=3');
    expect(await res.json()).toEqual({ query: { a: ['1', '2'], b: '3' }, url: '/q?a=1&a=2&b=3' });
  });

  it('route inconnue : page 404 d\'Express (HTML, nosniff, CSP), chemin échappé', async () => {
    const res = await echoApp().request('/<script>');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('Cannot GET /');
    expect(body).not.toContain('<script>');
  });

  it('erreur inattendue : 500 internal_error sans détail', async () => {
    const app = newApp();
    app.get('/boom', () => {
      throw new Error('secret interne');
    });
    app.onError(errorHandler);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app.request('/boom');
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
  });
});

describe('etag : validation conditionnelle des réponses en mémoire', () => {
  function etagApp(): App {
    const app = newApp();
    app.use('*', etag());
    app.get('/json', (c) => sendJson(c, { a: 1 }));
    app.post('/json', (c) => sendJson(c, { a: 1 }));
    app.get('/empty', (c) => c.body(null, 204));
    app.get('/fixed', (c) => c.body('x', 200, { ETag: '"fixe"', 'Content-Type': 'text/plain' }));
    app.get('/_ss/live', (c) => c.body('flux', 200, { 'Content-Type': 'text/plain' }));
    return app;
  }

  it('GET JSON : ETag faible ; If-None-Match identique : 304 sans corps ni type', async () => {
    const app = etagApp();
    const first = await app.request('/json');
    const tag = first.headers.get('etag') ?? '';
    expect(tag).toMatch(/^W\/"/);
    const again = await app.request('/json', { headers: { 'if-none-match': tag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('content-type')).toBeNull();
    expect(await again.text()).toBe('');
    const other = await app.request('/json', { headers: { 'if-none-match': 'W/"autre"' } });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ a: 1 });
  });

  it('Cache-Control: no-cache de la requête désactive le 304', async () => {
    const app = etagApp();
    const tag = (await app.request('/json')).headers.get('etag') ?? '';
    const res = await app.request('/json', { headers: { 'if-none-match': tag, 'cache-control': 'no-cache' } });
    expect(res.status).toBe(200);
  });

  it('ni POST, ni réponse vide, ni ETag déjà posé, ni relais /_ss', async () => {
    const app = etagApp();
    expect((await app.request('/json', { method: 'POST' })).headers.get('etag')).toBeNull();
    expect((await app.request('/empty')).headers.get('etag')).toBeNull();
    expect((await app.request('/fixed')).headers.get('etag')).toBe('"fixe"');
    expect((await app.request('/_ss/live')).headers.get('etag')).toBeNull();
  });
});

describe('clientAddress : IP du client', () => {
  async function ip(trustedHops: number, forwarded: string | undefined, socket: string | undefined): Promise<string | null> {
    const app = newApp();
    app.get('/ip', (c) => sendJson(c, { ip: clientAddress(c, trustedHops) ?? null }));
    const headers: Record<string, string> = forwarded === undefined ? {} : { 'x-forwarded-for': forwarded };
    const env = socket === undefined ? undefined : { incoming: { socket: { remoteAddress: socket } } };
    const res = await app.request('/ip', { headers }, env);
    return ((await res.json()) as { ip: string | null }).ip;
  }

  it('sans relais de confiance : l\'adresse de la socket, X-Forwarded-For ignoré', async () => {
    expect(await ip(0, '9.9.9.9', '10.0.0.1')).toBe('10.0.0.1');
    expect(await ip(0, undefined, undefined)).toBeNull();
  });

  it('un saut de confiance : la dernière entrée de X-Forwarded-For', async () => {
    expect(await ip(1, '8.8.8.8, 9.9.9.9', '10.0.0.1')).toBe('9.9.9.9');
    expect(await ip(1, undefined, '10.0.0.1')).toBe('10.0.0.1');
  });

  it('sans socket (requête simulée), la dernière entrée annoncée', async () => {
    expect(await ip(1, '8.8.8.8, 9.9.9.9', undefined)).toBe('9.9.9.9');
  });
});

describe('createApp : contrats HTTP conservés', () => {
  const deps = { secret: 'http-layer-secret-with-32-chars-min', allowPlain: false };

  it('/health : JSON, CORS ouvert, ETag, slash final toléré, HEAD sans corps', async () => {
    const app = createApp(deps);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request('/health/')).status).toBe(200);
    const head = await app.request('/health', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('OPTIONS : 204 sur toute route, avec CORS selon la route', async () => {
    const app = createApp(deps);
    const open = await app.request('/health', { method: 'OPTIONS' });
    expect(open.status).toBe(204);
    expect(open.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    const unknown = await app.request('/inconnue', { method: 'OPTIONS' });
    expect(unknown.status).toBe(204);
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('JSON invalide sur une route quelconque : 400 bad_request ; trop gros : 413', async () => {
    const app = createApp(deps);
    const bad = await app.request('/config/decode', { method: 'POST', headers: JSON_HEADERS, body: '{oops' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });
    const big = await app.request('/config/decode', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ config: 'x'.repeat(70 * 1024) }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'bad_request' });
  });

  it('429 : limite /config par IP, avec Retry-After et no-store', async () => {
    const app = createApp(deps);
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await app.request('/config/schema');
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(last?.headers.get('cache-control')).toBe('no-store');
    expect(await last?.json()).toEqual({ error: 'rate_limited' });
  });

  it('route inconnue : 404 HTML d\'Express ; /user inconnu : 404 JSON', async () => {
    const app = createApp(deps);
    const html = await app.request('/inconnue');
    expect(html.status).toBe(404);
    expect(html.headers.get('content-type')).toContain('text/html');
    const user = await app.request('/user/inconnue');
    expect(user.status).toBe(404);
    expect(await user.json()).toEqual({ error: 'not_found' });
    expect(user.headers.get('cache-control')).toBe('no-store');
  });

  it('identifiant de flux : suffixe .json obligatoire', async () => {
    const app = createApp(deps);
    const token = 'x'; // configuration illisible : 400 invalid_config prouve que la route est atteinte
    expect((await app.request(`/${token}/stream/movie/tt1.json`)).status).toBe(400);
    expect((await app.request(`/${token}/stream/movie/tt1`)).status).toBe(404);
  });
});
