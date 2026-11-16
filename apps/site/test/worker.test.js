// Tests du Worker (src/worker.js) : redirection www vers la racine, relais /api/* vers l'app, assets pour le reste.
// Lancer avec `npm test` (node:test, aucune dépendance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const LATEST = {
  versionName: '1.0.24',
  size: 1234,
  sha256: 'abc123',
  notes: 'Notes de version',
  extra: 'champ non relayé',
};

// Faux environnement : ASSETS et APP enregistrent leurs appels et répondent sans réseau.
// APP renvoie un latest.json dont l'url pointe sur la plateforme demandée (android ou tauri/<plateforme>).
function fakeEnv() {
  const seen = { assets: [], app: [] };
  return {
    seen,
    ASSETS: {
      fetch: async (request) => {
        seen.assets.push(request.url);
        return new Response('asset', { status: 200 });
      },
    },
    APP: {
      fetch: async (input) => {
        const url = String(input);
        seen.app.push(url);
        const platform = url.slice('https://app.laststream.app/app/'.length, -'/latest.json'.length);
        return Response.json({ ...LATEST, url: `https://app.laststream.app/app/${platform}/laststream.apk` });
      },
    },
  };
}

const get = (url, env) => worker.fetch(new Request(url), env);

test('www.laststream.app/guides/x?y=1 : 301 vers la racine, chemin et requête conservés', async () => {
  const env = fakeEnv();
  const res = await get('https://www.laststream.app/guides/x?y=1', env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://laststream.app/guides/x?y=1');
  assert.deepEqual(env.seen.assets, []);
  assert.deepEqual(env.seen.app, []);
});

test('www.laststream.app/ : 301 vers https://laststream.app/', async () => {
  const env = fakeEnv();
  const res = await get('https://www.laststream.app/', env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://laststream.app/');
  assert.deepEqual(env.seen.assets, []);
});

test('www.laststream.app/api/* : la redirection passe avant le relais /api (x et android)', async () => {
  for (const path of ['/api/x', '/api/android']) {
    const env = fakeEnv();
    const res = await get('https://www.laststream.app' + path, env);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), 'https://laststream.app' + path, path);
    assert.deepEqual(env.seen.app, [], path);
    assert.deepEqual(env.seen.assets, [], path);
  }
});

test('laststream.app/ : servi par ASSETS', async () => {
  const env = fakeEnv();
  const res = await get('https://laststream.app/', env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'asset');
  assert.deepEqual(env.seen.assets, ['https://laststream.app/']);
  assert.deepEqual(env.seen.app, []);
});

// Android : flux de l'APK ; Windows, Mac (Apple Silicon, Intel), Linux : flux de l'app Tauri.
const ROUTES = {
  android: 'android',
  windows: 'tauri/windows-x86_64',
  'macos-aarch64': 'tauri/macos-aarch64',
  'macos-x86_64': 'tauri/macos-x86_64',
  linux: 'tauri/linux-x86_64',
};
for (const [route, platform] of Object.entries(ROUTES)) {
  test(`laststream.app/api/${route} : relais de ${platform}/latest.json depuis app.laststream.app`, async () => {
    const env = fakeEnv();
    const res = await get(`https://laststream.app/api/${route}`, env);
    assert.equal(res.status, 200);
    assert.deepEqual(env.seen.app, [`https://app.laststream.app/app/${platform}/latest.json`]);
    assert.deepEqual(env.seen.assets, []);
    assert.deepEqual(await res.json(), {
      versionName: LATEST.versionName,
      size: LATEST.size,
      url: `https://app.laststream.app/app/${platform}/laststream.apk`,
      sha256: LATEST.sha256,
      notes: LATEST.notes,
    });
  });
}

test('laststream.app/api/windows : fichier hors de app/tauri/windows-x86_64/ refusé (ancienne app comprise)', async () => {
  const envWith = (url) => ({ ASSETS: { fetch: async () => new Response('asset') }, APP: { fetch: async () => Response.json({ ...LATEST, url }) } });
  for (const bad of [
    'https://app.laststream.app/app/windows/Laststream-Setup-1.0.24.exe',
    'https://app.laststream.app/app/tauri/linux-x86_64/Laststream-1.0.60-linux-x86_64.AppImage',
    'https://app.laststream.app/app/tauri/windows-x86_64/../x.exe',
  ]) {
    assert.equal((await get('https://laststream.app/api/windows', envWith(bad))).status, 502, bad);
  }
});

test('laststream.app/api/autre : non relayé, servi par ASSETS', async () => {
  const env = fakeEnv();
  const res = await get('https://laststream.app/api/autre', env);
  assert.equal(res.status, 200);
  assert.deepEqual(env.seen.assets, ['https://laststream.app/api/autre']);
  assert.deepEqual(env.seen.app, []);
});

test('laststream.app/api/android : APK d\'une release GitHub du dépôt accepté, autre hôte refusé', async () => {
  const gh = 'https://github.com/gtko/laststream/releases/download/v1.0.45/Laststream-1.0.45.apk';
  const envWith = (url) => ({ ASSETS: { fetch: async () => new Response('asset') }, APP: { fetch: async () => Response.json({ ...LATEST, url }) } });
  const ok = await get('https://laststream.app/api/android', envWith(gh));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).url, gh);
  for (const bad of ['https://evil.example/x.apk', 'https://github.com/autre/depot/releases/download/v1/x.apk']) {
    assert.equal((await get('https://laststream.app/api/android', envWith(bad))).status, 502, bad);
  }
  // Windows : seulement app.laststream.app.
  const win = await get('https://laststream.app/api/windows', envWith(gh.replace('.apk', '.exe')));
  assert.equal(win.status, 502);
});
