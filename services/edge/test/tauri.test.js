// App desktop Tauri : flux signé et fichiers relus depuis les releases GitHub (aucun R2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker, { tauriFeedVersion } from '../src/index.js';

const SHA = 'a'.repeat(64);
const feed = (platform, version = '1.2.3', ext = { macos: 'app.tar.gz', windows: 'setup.exe', linux: 'AppImage' }[platform.split('-')[0]]) =>
  JSON.stringify({ version, versionDesc: `https://app.laststream.app/app/tauri/${platform}/latest.json`, url: `https://app.laststream.app/app/tauri/${platform}/Laststream-${version}-${platform}.${ext}`, sha256: SHA });

const get = async (path, github, init = {}, calls = []) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push(String(url)); return github(String(url), o); };
  try {
    return await worker.fetch(new Request(`https://laststream.example${path}`, init), { APP_FILES: { get: async () => null }, CORE: { fetch: async () => new Response('core', { status: 404 }) } });
  } finally {
    globalThis.fetch = realFetch;
  }
};

describe('flux Tauri', () => {
  it('valide : version de la plateforme et fichier à l\'adresse publique attendue', () => {
    assert.equal(tauriFeedVersion(feed('macos-aarch64'), 'macos-aarch64'), '1.2.3');
    assert.equal(tauriFeedVersion(feed('windows-x86_64'), 'windows-x86_64'), '1.2.3');
    assert.equal(tauriFeedVersion(feed('linux-x86_64'), 'linux-x86_64'), '1.2.3');
    assert.equal(tauriFeedVersion(feed('macos-aarch64'), 'macos-x86_64'), null, 'autre plateforme');
    assert.equal(tauriFeedVersion(feed('macos-aarch64', '1.2.3', 'dmg'), 'macos-aarch64'), null, 'dmg : pas une archive de mise à jour');
    assert.equal(tauriFeedVersion('{', 'macos-aarch64'), null);
  });

  it('latest.json : celui de la dernière release, octet pour octet ; signature du tag annoncé', async () => {
    const text = feed('macos-aarch64');
    const github = (url) => {
      if (url === 'https://github.com/gtko/laststream/releases/latest/download/tauri-macos-aarch64-latest.json') return new Response(text);
      if (url === 'https://github.com/gtko/laststream/releases/download/v1.2.3/tauri-macos-aarch64-latest.json.sig') return new Response('SIG');
      return new Response('nope', { status: 404 });
    };
    const r = await get('/app/tauri/macos-aarch64/latest.json', github);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), text);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    const s = await get('/app/tauri/macos-aarch64/latest.json.sig', github);
    assert.equal(s.status, 200);
    assert.equal(await s.text(), 'SIG');
  });

  it('flux absent ou invalide : 404 ; plateforme inconnue : relais habituel', async () => {
    const r = await get('/app/tauri/macos-aarch64/latest.json', () => new Response(feed('windows-x86_64')));
    assert.equal(r.status, 404);
    const calls = [];
    const other = await get('/app/tauri/freebsd-x86_64/latest.json', () => new Response('x'), {}, calls);
    assert.equal(other.status, 404);
    assert.ok(!calls.some((u) => u.includes('github.com')), 'aucun appel à GitHub');
  });

  it('fichiers : relayés depuis la release du même numéro, plages comprises, sans redirection', async () => {
    const calls = [];
    const github = (url, o) => {
      assert.equal(o.headers.range, 'bytes=0-9');
      return new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 0-9/100', 'content-length': '10' } });
    };
    const r = await get('/app/tauri/macos-aarch64/Laststream-1.2.3-macos-aarch64.dmg', github, { headers: { range: 'bytes=0-9' } }, calls);
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-type'), 'application/x-apple-diskimage');
    assert.match(r.headers.get('content-disposition'), /filename="Laststream-1\.2\.3-macos-aarch64\.dmg"/);
    assert.deepEqual(calls, ['https://github.com/gtko/laststream/releases/download/v1.2.3/Laststream-1.2.3-macos-aarch64.dmg']);
  });

  it('noms hors convention ou POST : refusés sans appel à GitHub', async () => {
    for (const p of ['/app/tauri/macos-aarch64/Laststream-1.2.3-macos-x86_64.dmg', '/app/tauri/windows-x86_64/Laststream-1.2.3-windows-x86_64.dmg', '/app/tauri/macos-aarch64/../latest.json', '/app/tauri/macos-aarch64/Laststream-1.2-macos-aarch64.dmg']) {
      const calls = [];
      const r = await get(p, () => new Response('x'), {}, calls);
      assert.ok(!calls.some((u) => u.includes('releases/download')), p);
      assert.notEqual(r.status, 200, p);
    }
    const post = await get('/app/tauri/macos-aarch64/latest.json', () => new Response('x'), { method: 'POST' });
    assert.equal(post.status, 405);
  });
});
