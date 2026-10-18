import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker from '../src/index.js';
import { hostAllowed, MAX_RANGE_BYTES, parseRangeTarget, verifyRangeToken } from '../src/range.js';

const SECRET = 'secret-de-test-du-relais-de-plages-0123';
const URL_OK = 'https://abc.debrid.it/dl/film.mkv';
const ORIGIN = 'http://localhost:8080';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Même calcul que lastAddon (src/lt/thumbs/range-token.ts). */
async function sign(url, { secret = SECRET, ttl = 6 * 3600, nowMs = Date.now() } = {}) {
  const exp = Math.floor(nowMs / 1000) + ttl;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`range1\n${exp}\n${url}`)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return `${exp}.${btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

const env = { RANGE_SECRET: SECRET, RANGE_ENABLED: '1' };
const ask = async (query, { origin = ORIGIN, method = 'GET', e = env } = {}) => {
  const q = new URLSearchParams(query);
  const headers = origin === null ? {} : { origin };
  return worker.fetch(new Request(`https://laststream.example/__laststream/range?${q}`, { method, headers }), e);
};
const good = async (over = {}) => ({ u: URL_OK, s: '0', e: '99', t: await sign(over.u ?? URL_OK), ...over });

describe('relais de plages : coupé par défaut', () => {
  it('sans RANGE_ENABLED=1 : 410, aucun appel amont', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    const r = await ask(await good(), { e: { RANGE_SECRET: SECRET } });
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error, 'range_disabled');
  });
});

describe('relais de plages : refus', () => {
  it('sans jeton ou avec un jeton invalide (401)', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    assert.equal((await ask({ u: URL_OK, s: '0', e: '9' })).status, 401);
    assert.equal((await ask({ ...(await good()), t: 'x.y' })).status, 401);
    assert.equal((await ask({ ...(await good()), t: await sign(URL_OK, { secret: 'autre-secret' }) })).status, 401);
    assert.equal((await ask({ ...(await good()), t: await sign(URL_OK, { nowMs: Date.now() - 7 * 3600e3 }) })).status, 401); // expiré
    assert.equal((await ask({ ...(await good()), t: await sign(URL_OK, { ttl: 30 * 24 * 3600 }) })).status, 401); // trop long
  });
  it('jeton émis pour une autre URL (401)', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    const t = await sign('https://abc.debrid.it/dl/autre.mkv');
    assert.equal((await ask({ ...(await good()), t })).status, 401);
  });
  it('domaine non autorisé ou URL non https (403)', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    for (const u of [
      'https://evil.example/x', 'https://debrid.it.evil.example/x', 'https://evildebrid.it/x', 'https://debrid.it/x',
      'http://abc.debrid.it/x', 'https://127.0.0.1/x', 'https://u:p@abc.debrid.it/x', 'https://abc.debrid.it:8443/x', 'pas une url',
    ]) {
      const r = await ask({ ...(await good({ u })), t: await sign(u) });
      assert.equal(r.status, 403, u);
    }
  });
  it('plage trop grande ou invalide', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    assert.equal((await ask(await good({ s: '0', e: String(MAX_RANGE_BYTES) }))).status, 413);
    assert.equal((await ask(await good({ s: '5', e: '4' }))).status, 400);
    assert.equal((await ask(await good({ s: '-1', e: '4' }))).status, 400);
    assert.equal((await ask(await good({ s: 'a', e: '4' }))).status, 400);
  });
  it('origine hors liste (403), méthode autre que GET (405), secret absent (503)', async () => {
    globalThis.fetch = async () => assert.fail('aucun appel amont attendu');
    assert.equal((await ask(await good(), { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ask(await good(), { method: 'POST' })).status, 405);
    assert.equal((await ask(await good(), { e: { RANGE_ENABLED: '1' } })).status, 503);
  });
});

describe('relais de plages : accepté', () => {
  it('relaie une plage de 4 Mo exactement, avec CORS', async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, range: init.headers.range, redirect: init.redirect };
      return new Response(new Uint8Array(10), { status: 206, headers: { 'content-range': 'bytes 100-109/5000', 'content-length': '10' } });
    };
    const r = await ask(await good({ s: '100', e: String(100 + MAX_RANGE_BYTES - 1) }));
    assert.equal(r.status, 206);
    assert.equal(seen.url, URL_OK);
    assert.equal(seen.range, `bytes=100-${100 + MAX_RANGE_BYTES - 1}`);
    assert.equal(seen.redirect, 'manual');
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(r.headers.get('access-control-expose-headers'), /content-range/);
    assert.equal(r.headers.get('content-range'), 'bytes 100-109/5000');
    assert.equal((await r.arrayBuffer()).byteLength, 10);
  });
  it('préflight OPTIONS, sous-domaines alldebrid', async () => {
    const r = await ask({}, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    assert.ok(parseRangeTarget('https://x.y.alldebrid.com/f', {}));
  });
  it('amont qui ignore Range (200) : coupé, jamais relayé en entier', async () => {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } }), { status: 200 });
    const r = await ask(await good());
    assert.equal(r.status, 502);
    assert.equal(cancelled, true);
  });
  it('redirection : suivie seulement vers un domaine autorisé', async () => {
    globalThis.fetch = async (url) =>
      url === URL_OK
        ? new Response(null, { status: 302, headers: { location: 'https://evil.example/y' } })
        : assert.fail('ne doit pas suivre');
    assert.equal((await ask(await good())).status, 502);
    globalThis.fetch = async (url) =>
      url === URL_OK
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.debrid.it/y' } })
        : new Response(new Uint8Array(3), { status: 206, headers: { 'content-range': 'bytes 0-2/9' } });
    assert.equal((await ask(await good())).status, 206);
  });
});

describe('utilitaires', () => {
  it('hostAllowed et verifyRangeToken', async () => {
    assert.equal(hostAllowed('a.debrid.it', ['*.debrid.it']), true);
    assert.equal(hostAllowed('debrid.it', ['*.debrid.it']), false);
    assert.equal(hostAllowed('1.2.3.4', ['*.debrid.it']), false);
    assert.equal(await verifyRangeToken(SECRET, URL_OK, await sign(URL_OK)), true);
    assert.equal(await verifyRangeToken('', URL_OK, await sign(URL_OK)), false);
  });
});
