import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker, { fallbackEnabled, isBlockedPath, parseTunnelUrl } from '../src/index.js';

const SECRET = 'secret-de-test-registre-0123456789';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Liaison CORE de test : `handler(request)` ; sans handler, core est en panne (exception), ce qui exerce le repli tunnel. */
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

function makeEnv(initial, core = coreBinding()) {
  const store = new Map(initial ? [['tunnel', JSON.stringify(initial)]] : []);
  return {
    REGISTER_SECRET: SECRET,
    RETRY_DELAY_MS: 1,
    CORE: core,
    EDGE_SECRET: 'secret-de-test-du-relais-0123456789',
    LASTSTREAM_ROUTE: {
      get: async (key, opt) => (store.has(key) ? (opt === 'json' || opt?.type === 'json' ? JSON.parse(store.get(key)) : store.get(key)) : null),
      put: async (key, value) => {
        store.set(key, value);
      },
    },
    store,
  };
}

const call = (env, path, init) => worker.fetch(new Request(`https://laststream.example${path}`, init), env);
const register = (env, secret, url) =>
  call(env, '/__laststream/register', { method: 'POST', headers: { 'x-register-secret': secret }, body: JSON.stringify({ url }) });

describe('enregistrement', () => {
  it('refuse sans secret ou avec un mauvais secret (401)', async () => {
    const env = makeEnv();
    assert.equal((await register(env, 'faux', 'https://abc.trycloudflare.com')).status, 401);
    assert.equal((await call(env, '/__laststream/register', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(env.store.size, 0);
  });
  it('accepte une URL trycloudflare et la stocke', async () => {
    const env = makeEnv();
    assert.equal((await register(env, SECRET, 'https://abc-def.trycloudflare.com/')).status, 200);
    assert.equal(JSON.parse(env.store.get('tunnel')).url, 'https://abc-def.trycloudflare.com');
  });
  it('refuse les autres URL (400)', async () => {
    const env = makeEnv();
    const bad = [
      'http://abc.trycloudflare.com',
      'https://evil.example',
      'https://trycloudflare.com.evil.example',
      'https://u:p@abc.trycloudflare.com',
      'https://abc.trycloudflare.com:8443',
      'pas une url',
      42,
    ];
    for (const value of bad) {
      assert.equal((await register(env, SECRET, value)).status, 400, String(value));
    }
    assert.equal(env.store.size, 0);
  });
  it('GET refusé (405)', async () => {
    assert.equal((await call(makeEnv(), '/__laststream/register')).status, 405);
  });
});

describe('chemins interdits', () => {
  it('relais TV HLS : bloqué, y compris variantes encodées', async () => {
    const paths = ['/abc/lt/tv/hls', '/abc/LT/TV/HLS', '/abc/lt/tv/hls/', '/abc/lt/tv/%68ls', '/abc/lt/tv/%2568ls', '/abc//lt/./tv/hls', '/abc/lt/x/../tv/hls'];
    for (const p of paths) assert.equal(isBlockedPath(p), true, p);
    const env = makeEnv({ url: 'https://abc.trycloudflare.com' });
    assert.equal((await call(env, '/abc/lt/tv/hls?u=1')).status, 403);
  });
  it('les autres chemins TV restent permis', () => {
    for (const p of ['/abc/lt/tv/channels', '/abc/lt/tv/epg', '/health']) assert.equal(isBlockedPath(p), false, p);
  });
});

describe('relais', () => {
  it('503 clair sans tunnel enregistré', async () => {
    const res = await call(makeEnv(), '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'upstream_unreachable');
  });
  it('503 clair si le tunnel est injoignable', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('boom');
    };
    const res = await call(makeEnv({ url: 'https://abc.trycloudflare.com' }), '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'upstream_unreachable');
  });
  it('relaie méthode, chemin, query, corps ; remplace les en-têtes de confiance ; renvoie la réponse', async () => {
    let seen;
    globalThis.fetch = async (target, init) => {
      seen = { target, init, body: await new Response(init.body).text() };
      return new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json', 'keep-alive': 'timeout=5', 'x-up': '1' },
      });
    };
    const env = makeEnv({ url: 'https://abc.trycloudflare.com' });
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
        'x-register-secret': 'zzz',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-up'), '1');
    assert.equal(res.headers.get('keep-alive'), null);
    assert.equal(seen.target, 'https://abc.trycloudflare.com/user/login?a=1');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.body, '{"x":1}');
    const h = seen.init.headers;
    assert.equal(h.get('authorization'), 'Bearer t');
    assert.equal(h.get('x-laststream-edge'), env.EDGE_SECRET);
    assert.equal(h.get('x-laststream-client-ip'), '198.51.100.4');
    assert.equal(h.get('x-forwarded-host'), 'laststream.example');
    assert.equal(h.get('x-forwarded-proto'), 'https');
    assert.equal(h.get('x-register-secret'), null);
    assert.equal(h.get('cf-connecting-ip'), null);
  });
  it('parseTunnelUrl : cas limites', () => {
    assert.equal(parseTunnelUrl('https://a.b-c.trycloudflare.com/x?y'), 'https://a.b-c.trycloudflare.com');
    assert.equal(parseTunnelUrl('https://-a.trycloudflare.com'), null);
  });
});

describe('résilience', () => {
  const env0 = () => makeEnv({ url: 'https://abc.trycloudflare.com' });
  const sequence = (...steps) => {
    let calls = 0;
    globalThis.fetch = async () => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      if (step instanceof Error) throw step;
      return new Response(step.body ?? 'x', { status: step.status });
    };
    return () => calls;
  };
  const post = (path = '/x') => call(env0(), path, { method: 'POST', body: 'abc', headers: { 'content-length': '3' } });

  it('GET : réessaie sur 530 puis 503, puis réussit', async () => {
    const calls = sequence({ status: 530 }, { status: 503 }, { status: 200, body: 'ok' });
    const res = await call(env0(), '/health');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(calls(), 3);
  });
  it('GET : erreur réseau persistante, 2 réessais maximum puis 503 JSON', async () => {
    const calls = sequence(new TypeError('boom'));
    const res = await call(env0(), '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'upstream_unreachable');
    assert.equal(calls(), 3);
  });
  it('GET : un 503 persistant du serveur est restitué tel quel', async () => {
    const calls = sequence({ status: 503, body: 'indispo' });
    const res = await call(env0(), '/health');
    assert.equal(res.status, 503);
    assert.equal(await res.text(), 'indispo');
    assert.equal(calls(), 3);
  });
  it('POST avec corps : un seul nouvel essai sur erreur de connexion, corps renvoyé intact', async () => {
    const bodies = [];
    let n = 0;
    globalThis.fetch = async (_t, init) => {
      bodies.push(await new Response(init.body).text());
      n += 1;
      if (n === 1) throw new TypeError('connexion refusée');
      return new Response('ok', { status: 201 });
    };
    const res = await call(env0(), '/x', { method: 'POST', body: '{"a":1}', headers: { 'content-length': '7' } });
    assert.equal(res.status, 201);
    assert.deepEqual(bodies, ['{"a":1}', '{"a":1}']);
  });
  it('POST avec corps : pas de nouvel essai sur 503 ; un seul sur échecs répétés', async () => {
    let calls = sequence({ status: 503 });
    let res = await post();
    assert.equal(res.status, 503);
    assert.equal(calls(), 1);
    calls = sequence(new TypeError('boom'));
    res = await post();
    assert.equal(res.status, 503);
    assert.equal(calls(), 2);
  });
  it('POST à corps vide : traité comme idempotent (2 réessais)', async () => {
    const calls = sequence({ status: 530 });
    const res = await call(env0(), '/x', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(calls(), 3);
  });
  it('le KV est relu à chaque requête', async () => {
    const env = env0();
    const targets = [];
    globalThis.fetch = async (t) => {
      targets.push(t);
      return new Response('ok');
    };
    await call(env, '/a');
    env.store.set('tunnel', JSON.stringify({ url: 'https://neuf.trycloudflare.com' }));
    await call(env, '/a');
    assert.deepEqual(targets, ['https://abc.trycloudflare.com/a', 'https://neuf.trycloudflare.com/a']);
  });
  it('erreur : page HTML FR avec rechargement pour un navigateur, JSON sinon', async () => {
    sequence(new TypeError('boom'));
    const html = await call(env0(), '/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(html.status, 503);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const text = await html.text();
    assert.match(text, /Laststream redémarre/);
    assert.match(text, /http-equiv="refresh" content="5"/);
    const api = await call(env0(), '/health', { headers: { accept: 'application/json' } });
    assert.match(api.headers.get('content-type'), /json/);
    const none = await call(makeEnv(), '/', { headers: { accept: 'text/html' } });
    assert.match(none.headers.get('content-type'), /text\/html/);
  });
});

describe('lastaddon-core par Service Binding', () => {
  const okCore = (status = 200, text = 'depuis core') => coreBinding(() => new Response(text, { status, headers: { 'x-core': '1' } }));
  const noTunnelFetch = () => {
    globalThis.fetch = async () => {
      throw new Error('le tunnel ne doit pas être appelé');
    };
  };

  it('relaie toutes les routes vers core avec les en-têtes de confiance, sans toucher au tunnel', async () => {
    noTunnelFetch();
    const core = okCore(201);
    const env = makeEnv({ url: 'https://abc.trycloudflare.com' }, core);
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
  it('un 4xx de core est restitué sans repli', async () => {
    noTunnelFetch();
    const res = await call(makeEnv({ url: 'https://abc.trycloudflare.com' }, okCore(401)), '/user/login', { method: 'POST' });
    assert.equal(res.status, 401);
  });
  it('relais TV HLS : 403 sans appeler core', async () => {
    const core = okCore();
    assert.equal((await call(makeEnv(null, core), '/abc/lt/tv/hls')).status, 403);
    assert.equal(core.calls.length, 0);
  });
  it('réessaie core sur 503 transitoire puis réussit', async () => {
    let n = 0;
    const core = coreBinding(() => new Response('x', { status: (n += 1) < 3 ? 503 : 200 }));
    noTunnelFetch();
    const res = await call(makeEnv(null, core), '/health');
    assert.equal(res.status, 200);
    assert.equal(core.calls.length, 3);
  });
  it('core 5xx + tunnel enregistré : repli vers le tunnel', async () => {
    const seen = [];
    globalThis.fetch = async (target) => {
      seen.push(target);
      return new Response('depuis le PC', { status: 200 });
    };
    const res = await call(makeEnv({ url: 'https://abc.trycloudflare.com' }, okCore(500, 'oups')), '/torrents');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'depuis le PC');
    assert.deepEqual(seen, ['https://abc.trycloudflare.com/torrents']);
  });
  it('core 5xx sans tunnel enregistré : le 5xx de core est restitué', async () => {
    noTunnelFetch();
    const res = await call(makeEnv(null, okCore(500, 'oups')), '/torrents');
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'oups');
  });
  it('core 5xx + tunnel qui échoue aussi : le 5xx de core est restitué', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('boom');
    };
    const res = await call(makeEnv({ url: 'https://abc.trycloudflare.com' }, okCore(500, 'oups')), '/torrents');
    assert.equal(res.status, 500);
  });
  it('TUNNEL_FALLBACK=0 : aucun repli', async () => {
    noTunnelFetch();
    const env = makeEnv({ url: 'https://abc.trycloudflare.com' }, okCore(500, 'oups'));
    env.TUNNEL_FALLBACK = '0';
    assert.equal((await call(env, '/torrents')).status, 500);
    assert.equal(fallbackEnabled(env), false);
    assert.equal(fallbackEnabled({}), true);
  });
  it('core injoignable sans tunnel : page d’attente HTML pour un navigateur', async () => {
    noTunnelFetch();
    const res = await call(makeEnv(null), '/', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Laststream redémarre/);
  });
});
