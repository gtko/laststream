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
/** Requête au Worker avec R2 simulé ; `github` simule GitHub (absent : 404, donc tout vient de R2). `calls` reçoit les adresses appelées. */
const get = async (path, init = {}, seen = [], github = () => new Response('Not Found', { status: 404 }), calls = []) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push(String(url)); return github(String(url), o); };
  try {
    return await worker.fetch(new Request(`https://laststream.example${path}`, init), { APP_FILES: fakeR2(seen), CORE: { fetch: async () => new Response('core', { status: 404 }) } });
  } finally {
    globalThis.fetch = realFetch;
  }
};

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

describe('flux de version Android depuis la release GitHub', () => {
  const A = '/app/android/latest.json';
  const FEED = {
    versionCode: 2026110951, versionName: '1.0.45',
    url: 'https://github.com/gtko/laststream/releases/download/v1.0.45/Laststream-1.0.45.apk',
    sha256: 'a'.repeat(64), size: 10, notes: 'Laststream v1.0.45',
  };
  const run = async (github, init = {}) => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); return github(); };
    let relayed = 0;
    try {
      const r = await worker.fetch(new Request(`https://laststream.example${A}`, init), {
        CORE: { fetch: async () => { relayed += 1; return Response.json({ versionCode: 1 }); } },
      });
      return { r, calls, relayed };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  it('flux valide : 200, JSON, cache court, lu sur la dernière release', async () => {
    const { r, calls, relayed } = await run(() => Response.json(FEED));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.deepEqual(await r.json(), FEED);
    assert.deepEqual(calls, ['https://github.com/gtko/laststream/releases/latest/download/android-latest.json']);
    assert.equal(relayed, 0);
  });
  it('flux absent (404) ou APK hors du dépôt : relais habituel', async () => {
    for (const github of [
      () => new Response('Not Found', { status: 404 }),
      () => Response.json({ ...FEED, url: 'https://evil.example/x.apk' }),
      () => Response.json({ ...FEED, sha256: 'xyz' }),
      () => { throw new Error('réseau'); },
    ]) {
      const { r, relayed } = await run(github);
      assert.equal(relayed, 1);
      assert.deepEqual(await r.json(), { versionCode: 1 });
    }
  });
  it('POST refusé sans appel à GitHub', async () => {
    const { r, calls } = await run(() => Response.json(FEED), { method: 'POST' });
    assert.equal(r.status, 405);
    assert.deepEqual(calls, []);
  });
});

describe('Windows depuis la dernière release GitHub', () => {
  const FEED = JSON.stringify({
    version: '1.0.54', versionName: '1.0.54', versionCode: 1000054,
    url: 'https://app.laststream.app/app/windows/Laststream-Setup-1.0.54.exe', sha256: 'e'.repeat(64), size: 123,
  }, null, 2);
  const LATEST = 'https://github.com/gtko/laststream/releases/latest/download/latest.json';
  const SIG = 'https://github.com/gtko/laststream/releases/download/v1.0.54/latest.json.sig';
  const EXE = 'https://github.com/gtko/laststream/releases/download/v1.0.54/Laststream-Setup-1.0.54.exe';
  const github = (url, o) => {
    if (url === LATEST) return new Response(FEED);
    if (url === SIG) return new Response('c2ln');
    if (url === EXE) {
      const range = o?.headers?.range;
      return range
        ? new Response('bcd', { status: 206, headers: { 'content-range': 'bytes 1-3/6', 'content-length': '3' } })
        : new Response('abcdef', { headers: { 'content-length': '6', etag: '"g"' } });
    }
    return new Response('Not Found', { status: 404 });
  };

  it('flux : celui de la release, octet pour octet (il est signé), sans lire R2', async () => {
    const seen = [];
    const r = await get('/app/windows/latest.json', {}, seen, github);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(await r.text(), FEED);
    assert.deepEqual(seen, []);
  });
  it('signature : celle du tag annoncé par le flux', async () => {
    const calls = [];
    const r = await get('/app/windows/latest.json.sig', {}, [], github, calls);
    assert.equal(await r.text(), 'c2ln');
    assert.deepEqual(calls, [LATEST, SIG]);
  });
  it('flux GitHub absent, invalide ou pointant ailleurs : repli sur R2', async () => {
    for (const bad of [
      () => new Response('Not Found', { status: 404 }),
      () => new Response('pas du json'),
      () => new Response(FEED.replace('app.laststream.app', 'evil.example')),
      () => new Response(FEED.replace('Setup-1.0.54', 'Setup-9.9.9')),
      () => { throw new Error('réseau'); },
    ]) {
      const seen = [];
      const r = await get('/app/windows/latest.json', {}, seen, bad);
      assert.equal(r.status, 200);
      assert.deepEqual(seen, ['windows/latest.json']);
    }
  });
  it('installeur absent de R2 : relayé depuis la release du même numéro, plages comprises, sans redirection', async () => {
    const r = await get('/app/windows/Laststream-Setup-1.0.54.exe', {}, [], github);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="Laststream-Setup-1\.0\.54\.exe"$/);
    assert.equal(r.headers.get('content-length'), '6');
    assert.equal(await r.text(), 'abcdef');
    const part = await get('/app/windows/Laststream-Setup-1.0.54.exe', { headers: { range: 'bytes=1-3' } }, [], github);
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(await part.text(), 'bcd');
    const head = await get('/app/windows/Laststream-Setup-1.0.54.exe', { method: 'HEAD' }, [], github);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
  it('installeur présent dans R2 : servi depuis R2, GitHub n’est pas appelé ; inconnu partout : 404', async () => {
    const calls = [];
    const r = await get('/app/windows/Laststream-Setup-1.0.0.exe', {}, [], github, calls);
    assert.equal(r.headers.get('content-length'), '100');
    assert.deepEqual(calls, []);
    assert.equal((await get('/app/windows/Laststream-Setup-9.9.9.exe', {}, [], github)).status, 404);
  });
});
