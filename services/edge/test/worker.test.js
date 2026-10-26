import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker, { isBlockedPath } from '../src/index.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Liaison CORE de test : `handler(request)` ; sans handler, core est en panne (exception). Chaque appel est enregistré. */
function coreBinding(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(request);
      if (!handler) throw new TypeError('core indisponible');
      return handler(request);
    },
  };
}

/** Liaison CORE qui joue `steps` dans l'ordre : une erreur est levée, sinon { status, body } ; la dernière étape se répète. */
function scriptedCore(...steps) {
  let n = 0;
  return coreBinding(() => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    if (step instanceof Error) throw step;
    return new Response(step.body ?? 'x', { status: step.status });
  });
}

function makeEnv(core = coreBinding()) {
  return { RETRY_DELAY_MS: 1, CORE: core, EDGE_SECRET: 'secret-de-test-du-relais-0123456789' };
}

const call = (env, path, init) => worker.fetch(new Request(`https://laststream.example${path}`, init), env);

describe('routes locales', () => {
  it('relais de plages supprimé : /__laststream/range renvoie 404 sans appel amont', async () => {
    const core = coreBinding(() => new Response('amont', { status: 200 }));
    const r = await call(makeEnv(core), '/__laststream/range?u=x&s=0&e=1&t=y');
    assert.equal(r.status, 404);
    assert.equal(core.calls.length, 0);
  });
  it('/__laststream/register répond 404 pour toutes les méthodes, sans appel à CORE', async () => {
    const core = coreBinding(() => new Response('amont', { status: 200 }));
    const env = makeEnv(core);
    assert.equal((await call(env, '/__laststream/register', { method: 'POST', body: '{"url":"https://relais.example.org"}' })).status, 404);
    assert.equal((await call(env, '/__laststream/register')).status, 404);
    assert.equal(core.calls.length, 0);
  });
});

describe('chemins interdits', () => {
  it('relais TV HLS : bloqué, y compris variantes encodées', async () => {
    const paths = ['/abc/lt/tv/hls', '/abc/LT/TV/HLS', '/abc/lt/tv/hls/', '/abc/lt/tv/%68ls', '/abc/lt/tv/%2568ls', '/abc//lt/./tv/hls', '/abc/lt/x/../tv/hls'];
    for (const p of paths) assert.equal(isBlockedPath(p), true, p);
    assert.equal((await call(makeEnv(), '/abc/lt/tv/hls?u=1')).status, 403);
  });
  it('les autres chemins TV restent permis', () => {
    for (const p of ['/abc/lt/tv/channels', '/abc/lt/tv/epg', '/health']) assert.equal(isBlockedPath(p), false, p);
  });
  it('le direct social (/user/social/live) n’est pas bloqué', () => {
    assert.equal(isBlockedPath('/user/social/live'), false);
  });
});

describe('relais', () => {
  it('relaie méthode, chemin, query, corps ; remplace les en-têtes de confiance ; renvoie la réponse', async () => {
    let seen;
    const core = coreBinding(async (request) => {
      seen = { request, body: await request.text() };
      return new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json', 'keep-alive': 'timeout=5', 'x-up': '1' },
      });
    });
    const env = makeEnv(core);
    const res = await call(env, '/user/login?a=1', {
      method: 'POST',
      body: '{"x":1}',
      headers: {
        'content-type': 'application/json',
        'content-length': '7',
        authorization: 'Bearer t',
        'cf-connecting-ip': '198.51.100.4',
        'x-laststream-edge': 'forge',
        'x-laststream-client-ip': '6.6.6.6',
        'x-forwarded-host': 'evil',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-up'), '1');
    assert.equal(res.headers.get('keep-alive'), null);
    assert.equal(seen.request.url, 'https://laststream.example/user/login?a=1');
    assert.equal(seen.request.method, 'POST');
    assert.equal(seen.body, '{"x":1}');
    const h = seen.request.headers;
    assert.equal(h.get('authorization'), 'Bearer t');
    assert.equal(h.get('x-laststream-edge'), env.EDGE_SECRET);
    assert.equal(h.get('x-laststream-client-ip'), '198.51.100.4');
    assert.equal(h.get('x-forwarded-host'), 'laststream.example');
    assert.equal(h.get('x-forwarded-proto'), 'https');
    assert.equal(h.get('cf-connecting-ip'), null);
  });
});

describe('résilience (réessais vers CORE)', () => {
  const post = (core, path = '/x') => call(makeEnv(core), path, { method: 'POST', body: 'abc', headers: { 'content-length': '3' } });

  it('GET : réessaie sur 530 puis 503, puis réussit', async () => {
    const core = scriptedCore({ status: 530 }, { status: 503 }, { status: 200, body: 'ok' });
    const res = await call(makeEnv(core), '/health');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(core.calls.length, 3);
  });
  it('GET : erreur réseau persistante, 2 réessais maximum puis 503 JSON', async () => {
    const core = scriptedCore(new TypeError('boom'));
    const res = await call(makeEnv(core), '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'upstream_unreachable');
    assert.equal(core.calls.length, 3);
  });
  it('GET : un 503 persistant de core est restitué tel quel', async () => {
    const core = scriptedCore({ status: 503, body: 'indispo' });
    const res = await call(makeEnv(core), '/health');
    assert.equal(res.status, 503);
    assert.equal(await res.text(), 'indispo');
    assert.equal(core.calls.length, 3);
  });
  it('POST avec corps : un seul nouvel essai sur erreur de connexion, corps renvoyé intact', async () => {
    const bodies = [];
    const core = coreBinding(async (request) => {
      bodies.push(await request.text());
      if (bodies.length === 1) throw new TypeError('connexion refusée');
      return new Response('ok', { status: 201 });
    });
    const res = await call(makeEnv(core), '/x', { method: 'POST', body: '{"a":1}', headers: { 'content-length': '7' } });
    assert.equal(res.status, 201);
    assert.deepEqual(bodies, ['{"a":1}', '{"a":1}']);
  });
  it('POST avec corps : pas de nouvel essai sur 503 ; un seul sur échecs répétés', async () => {
    let core = scriptedCore({ status: 503 });
    let res = await post(core);
    assert.equal(res.status, 503);
    assert.equal(core.calls.length, 1);
    core = scriptedCore(new TypeError('boom'));
    res = await post(core);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'upstream_unreachable');
    assert.equal(core.calls.length, 2);
  });
  it('POST à corps vide : traité comme idempotent (2 réessais), 530 final restitué tel quel', async () => {
    const core = scriptedCore({ status: 530 });
    const res = await call(makeEnv(core), '/x', { method: 'POST' });
    assert.equal(res.status, 530);
    assert.equal(core.calls.length, 3);
  });
  it('erreur : page HTML FR avec rechargement pour un navigateur, JSON sinon', async () => {
    const html = await call(makeEnv(), '/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(html.status, 503);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const text = await html.text();
    assert.match(text, /Laststream redémarre/);
    assert.match(text, /http-equiv="refresh" content="5"/);
    const api = await call(makeEnv(), '/health', { headers: { accept: 'application/json' } });
    assert.match(api.headers.get('content-type'), /json/);
  });
});

describe('lastaddon-core par Service Binding', () => {
  const okCore = (status = 200, text = 'depuis core') => coreBinding(() => new Response(text, { status, headers: { 'x-core': '1' } }));

  it('relaie toutes les routes vers core avec les en-têtes de confiance', async () => {
    const core = okCore(201);
    const env = makeEnv(core);
    const res = await call(env, '/user/login?a=1', {
      method: 'POST',
      body: '{"x":1}',
      headers: { 'content-length': '7', 'cf-connecting-ip': '198.51.100.4', 'x-laststream-client-ip': '6.6.6.6', authorization: 'Bearer t' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-core'), '1');
    assert.equal(await res.text(), 'depuis core');
    assert.equal(core.calls.length, 1);
    const sent = core.calls[0];
    assert.equal(new URL(sent.url).pathname + new URL(sent.url).search, '/user/login?a=1');
    assert.equal(sent.method, 'POST');
    assert.equal(await sent.text(), '{"x":1}');
    assert.equal(sent.headers.get('x-laststream-edge'), env.EDGE_SECRET);
    assert.equal(sent.headers.get('x-laststream-client-ip'), '198.51.100.4');
    assert.equal(sent.headers.get('authorization'), 'Bearer t');
    assert.equal(sent.headers.get('cf-connecting-ip'), null);
  });
  it('un 4xx de core est restitué tel quel', async () => {
    const res = await call(makeEnv(okCore(401)), '/user/login', { method: 'POST' });
    assert.equal(res.status, 401);
  });
  it('relais TV HLS : 403 sans appeler core', async () => {
    const core = okCore();
    assert.equal((await call(makeEnv(core), '/abc/lt/tv/hls')).status, 403);
    assert.equal(core.calls.length, 0);
  });
  it('réessaie core sur 503 transitoire puis réussit', async () => {
    let n = 0;
    const core = coreBinding(() => new Response('x', { status: (n += 1) < 3 ? 503 : 200 }));
    const res = await call(makeEnv(core), '/health');
    assert.equal(res.status, 200);
    assert.equal(core.calls.length, 3);
  });
  it('core 5xx hors 502/503/504 : restitué tel quel, sans réessai', async () => {
    const core = okCore(500, 'oups');
    const res = await call(makeEnv(core), '/torrents');
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'oups');
    assert.equal(core.calls.length, 1);
  });
  it('aucun appel sortant (globalThis.fetch) quand core est en panne ou renvoie 5xx', async () => {
    const outbound = [];
    globalThis.fetch = async (input) => {
      outbound.push(String(input));
      return new Response('depuis un autre serveur', { status: 200 });
    };
    const down = await call(makeEnv(), '/torrents', { headers: { accept: 'text/html' } });
    assert.equal(down.status, 503);
    assert.match(await down.text(), /Laststream redémarre/);
    const broken = await call(makeEnv(okCore(500, 'oups')), '/torrents');
    assert.equal(broken.status, 500);
    assert.deepEqual(outbound, []);
  });
  it('upgrade WebSocket /user/social/live : relayé vers CORE avec la query ticket', async () => {
    const core = okCore(200, 'socket');
    const env = makeEnv(core);
    const res = await call(env, '/user/social/live?ticket=abc.def', {
      headers: { upgrade: 'websocket', 'cf-connecting-ip': '198.51.100.4' },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'socket');
    assert.equal(core.calls.length, 1);
    const sent = core.calls[0];
    const sentUrl = new URL(sent.url);
    assert.equal(sentUrl.pathname, '/user/social/live');
    assert.equal(sentUrl.searchParams.get('ticket'), 'abc.def');
    assert.equal(sent.method, 'GET');
    assert.equal(sent.headers.get('upgrade'), 'websocket');
    assert.equal(sent.headers.get('x-laststream-edge'), env.EDGE_SECRET);
    assert.equal(sent.headers.get('x-laststream-client-ip'), '198.51.100.4');
    assert.equal(sent.headers.get('cf-connecting-ip'), null);
  });
  it('upgrade WebSocket sur un autre chemin : 426 sans appeler CORE', async () => {
    const core = okCore();
    const env = makeEnv(core);
    const paths = ['/user/social/live/', '/user/social/live/x', '/user/social/live2', '/user/social', '/USER/SOCIAL/LIVE', '/party/abc', '/health'];
    for (const path of paths) {
      const res = await call(env, path, { headers: { upgrade: 'websocket' } });
      assert.equal(res.status, 426, path);
      assert.equal((await res.json()).error, 'upgrade_required', path);
    }
    assert.equal(core.calls.length, 0);
  });
  it('upgrade WebSocket /user/social/live sans liaison CORE : 426', async () => {
    const env = makeEnv();
    env.CORE = undefined;
    const res = await call(env, '/user/social/live?ticket=abc', { headers: { upgrade: 'websocket' } });
    assert.equal(res.status, 426);
    assert.equal((await res.json()).error, 'upgrade_required');
  });
  it('requête HTTP non-upgrade sur /user/social/live : chemin HTTP habituel', async () => {
    const core = okCore(500, 'oups');
    const res = await call(makeEnv(core), '/user/social/live?ticket=abc');
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'oups');
    assert.equal(core.calls.length, 1);
    assert.equal(core.calls[0].headers.get('upgrade'), null);
  });
});
