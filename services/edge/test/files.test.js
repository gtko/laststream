import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker from '../src/index.js';

const BYTES = new Uint8Array(100).map((_, i) => i);
const fakeR2 = (seen) => ({
  async get(key, opts) {
    seen.push(key);
    if (!['windows/Laststream-Setup-1.0.0.exe', 'android/laststream-1700000000.apk', 'windows/latest.json', 'windows/latest.json.sig'].includes(key)) return null;
    const rh = opts?.range?.get?.('range');
    const m = rh && /^bytes=(\d+)-(\d+)$/.exec(rh);
    const body = m ? BYTES.slice(+m[1], +m[2] + 1) : BYTES;
    return {
      size: 100, httpEtag: '"e"', body, range: m ? { offset: +m[1], length: +m[2] - +m[1] + 1 } : undefined,
      writeHttpMetadata() {},
    };
  },
});
const get = (path, init = {}, seen = []) =>
  worker.fetch(new Request(`https://laststream.example${path}`, init), { APP_FILES: fakeR2(seen), CORE: { fetch: async () => new Response('core', { status: 404 }) } });

describe('installateur Windows depuis R2', () => {
  const P = '/app/windows/Laststream-Setup-1.0.0.exe';
  it('GET : 200, type exe, attachment', async () => {
    const r = await get(P);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="Laststream-Setup-1\.0\.0\.exe"$/);
    assert.equal(r.headers.get('content-length'), '100');
  });
  it('HEAD sans corps, plage -> 206', async () => {
    const h = await get(P, { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(await h.text(), '');
    const r = await get(P, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/100');
  });
  it('noms hors regex ou méthode POST refusés', async () => {
    const seen = [];
    for (const p of ['/app/windows/Laststream-Setup-1.0.exe', '/app/windows/evil.exe', '/app/windows/../x.exe', '/app/windows/Laststream-Setup-1.0.0.exe.zip']) {
      const r = await get(p, {}, seen);
      assert.notEqual(r.status, 200, p);
    }
    assert.deepEqual(seen, []);
    assert.equal((await get(P, { method: 'POST' })).status, 405);
  });
  it('introuvable -> 404 ; APK toujours servi', async () => {
    assert.equal((await get('/app/windows/Laststream-Setup-9.9.9.exe')).status, 404);
    const a = await get('/app/android/laststream-1700000000.apk');
    assert.equal(a.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(a.headers.get('content-disposition'), null);
  });
});

describe('flux de version Windows depuis R2', () => {
  const F = '/app/windows/latest.json';
  it('GET : 200, JSON, cache court, sans attachment', async () => {
    const r = await get(F);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(r.headers.get('content-disposition'), null);
  });
  it('HEAD sans corps, plage -> 206', async () => {
    const h = await get(F, { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(await h.text(), '');
    const r = await get(F, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/100');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
  });
  it('l\'installeur garde son cache immuable ; POST refusé ; autres JSON refusés', async () => {
    const exe = await get('/app/windows/Laststream-Setup-1.0.0.exe');
    assert.equal(exe.headers.get('cache-control'), 'public, max-age=86400, immutable');
    assert.equal((await get(F, { method: 'POST' })).status, 405);
    const seen = [];
    for (const p of ['/app/windows/other.json', '/app/windows/latest.json.bak', '/app/android/other.json']) {
      assert.notEqual((await get(p, {}, seen)).status, 200, p);
    }
    assert.deepEqual(seen, []);
  });
  it('signature du flux : 200, texte, cache court ; autres .sig refusés', async () => {
    const r = await get(`${F}.sig`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(r.headers.get('content-disposition'), null);
    const seen = [];
    for (const p of ['/app/windows/other.json.sig', '/app/windows/latest.json.sig.bak', '/app/android/latest.json.sig']) {
      assert.notEqual((await get(p, {}, seen)).status, 200, p);
    }
    assert.deepEqual(seen, []);
  });
});

describe('flux de version Android depuis R2', () => {
  const A = '/app/android/latest.json';
  const env = (stored, core) => ({
    APP_FILES: {
      async get(key) {
        if (key !== 'android/latest.json' || !stored) return null;
        return { size: 2, httpEtag: '"a"', body: '{}', writeHttpMetadata() {} };
      },
    },
    CORE: { fetch: core },
  });
  it('présent dans R2 : 200, JSON, cache court', async () => {
    const r = await worker.fetch(new Request(`https://laststream.example${A}`), env(true, async () => new Response('core', { status: 500 })));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
  });
  it('absent de R2 : relais habituel (ancien flux servi avec l\'application)', async () => {
    let relayed = 0;
    const r = await worker.fetch(new Request(`https://laststream.example${A}`), env(false, async () => { relayed += 1; return Response.json({ versionCode: 1 }); }));
    assert.equal(relayed, 1);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { versionCode: 1 });
  });
  it('POST refusé', async () => {
    const r = await worker.fetch(new Request(`https://laststream.example${A}`, { method: 'POST' }), env(true, async () => new Response('core')));
    assert.equal(r.status, 405);
  });
});
