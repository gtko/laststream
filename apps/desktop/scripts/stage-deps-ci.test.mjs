import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  bsdTarCandidates, buildDeps, checkPeExecutable, checkSha256, checkWebDist, checkZipEntries, downloadNodeExe,
  findBsdTar, listZipEntries, nodeExeUrl, normalizeOptions, parseCliArgs, resolveCoreBundle, sha256Hex, stageDeps, zipArgs,
} from './stage-deps-ci.mjs';

const VERSION = '1.0.33';
const TAG = 'desktop-v1.0.33';
const NODE_VERSION = 'v22.23.4';
// SHA-256 officiel de win-x64/node.exe pour v22.23.4 (SHASUMS256.txt de nodejs.org).
const NODE_SHA_OFFICIAL = 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f';
const COMMIT = '0081b52d6f3c4a1e9b7d2c8e5f0a1b2c3d4e5f60';
const BUILT_AT = '2026-11-07T22:00:00.000Z';
const FULL_ARGS = [
  '--version', VERSION, '--web-dist', 'web', '--core-bundle', 'bundle',
  '--node-version', NODE_VERSION, '--node-sha256', NODE_SHA_OFFICIAL, '--out', 'out',
];

// bsdtar sert a ecrire les zip : absent (ex. tar GNU seul), les tests qui en ont besoin sont ignores.
const TAR = findBsdTar();
const SKIP_NO_BSDTAR = TAR === null ? 'bsdtar absent (Windows : tar.exe de System32)' : false;

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-deps-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nodeExeUrl : URL officielle win-x64 ; version hors v22.x.y refusee', () => {
  assert.equal(nodeExeUrl(NODE_VERSION), 'https://nodejs.org/dist/v22.23.4/win-x64/node.exe');
  for (const bad of ['22.23.4', 'v20.19.0', 'v22.x.1', 'v22.23.4 ']) {
    assert.throws(() => nodeExeUrl(bad), /Version Node invalide/, bad);
  }
});

test('sha256Hex : vecteur de reference (« abc », FIPS 180-2)', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('checkSha256 : accepte l\'empreinte attendue en majuscules, refuse un ecart avec les deux empreintes', () => {
  const actual = sha256Hex(Buffer.from('abc'));
  assert.equal(checkSha256(actual, actual.toUpperCase(), 'node.exe'), actual);
  assert.throws(
    () => checkSha256(sha256Hex(Buffer.from('abd')), actual, 'node.exe'),
    (e) => /SHA-256 de node\.exe different/.test(e.message) && e.message.includes(actual) && e.message.includes('Archive refusee'),
  );
  assert.throws(() => checkSha256(actual, 'abc', 'node.exe'), /SHA-256 attendu de node\.exe invalide/);
});

test('checkPeExecutable : la signature MZ est exigee', () => {
  assert.doesNotThrow(() => checkPeExecutable(Buffer.from('MZ\x90\x00'), 'node.exe'));
  assert.throws(() => checkPeExecutable(Buffer.from('\x7fELF'), 'node.exe'), /MZ/);
  assert.throws(() => checkPeExecutable(Buffer.alloc(0), 'node.exe'), /MZ/);
});

test('buildDeps : schema et ordre des cles identiques a stage-release-deps.ps1', () => {
  const deps = buildDeps({
    version: VERSION,
    builtAt: BUILT_AT,
    commit: COMMIT,
    nodeVersion: NODE_VERSION,
    nodeSha256: NODE_SHA_OFFICIAL,
    uiZip: { sha256: 'a'.repeat(64), size: 1234 },
    addonZip: { sha256: 'b'.repeat(64), size: 5678 },
  });
  assert.deepEqual(Object.keys(deps), ['version', 'tag', 'builtAt', 'repos', 'files', 'nodeExe']);
  assert.deepEqual(Object.keys(deps.repos), ['laststream-app', 'lastaddon']);
  assert.deepEqual(Object.keys(deps.files), ['ui.zip', 'lastaddon.zip']);
  assert.deepEqual(Object.keys(deps.nodeExe), ['version', 'sha256', 'origin']);
  assert.deepEqual(deps, {
    version: '1.0.33',
    tag: 'desktop-v1.0.33',
    builtAt: BUILT_AT,
    repos: {
      'laststream-app': { branch: 'main', commit: COMMIT },
      lastaddon: { branch: 'main', commit: COMMIT },
    },
    files: {
      'ui.zip': { sha256: 'a'.repeat(64), size: 1234 },
      'lastaddon.zip': { sha256: 'b'.repeat(64), size: 5678 },
    },
    nodeExe: {
      version: 'v22.23.4',
      sha256: NODE_SHA_OFFICIAL,
      origin: 'https://nodejs.org/dist/v22.23.4/win-x64/node.exe',
    },
  });
});

test('buildDeps : refuse version, commit, SHA-256, date ou taille invalides', () => {
  const base = {
    version: VERSION,
    builtAt: BUILT_AT,
    commit: COMMIT,
    nodeVersion: NODE_VERSION,
    nodeSha256: NODE_SHA_OFFICIAL,
    uiZip: { sha256: 'a'.repeat(64), size: 1 },
    addonZip: { sha256: 'b'.repeat(64), size: 2 },
  };
  assert.throws(() => buildDeps({ ...base, version: '1.0' }), /Version invalide/);
  assert.throws(() => buildDeps({ ...base, commit: 'abc' }), /Commit invalide/);
  assert.throws(() => buildDeps({ ...base, nodeSha256: 'ABC' }), /SHA-256 de node\.exe invalide/);
  assert.throws(() => buildDeps({ ...base, builtAt: 'pas une date' }), /builtAt invalide/);
  assert.throws(() => buildDeps({ ...base, uiZip: { sha256: 'a'.repeat(64), size: -1 } }), /ui\.zip invalide/);
  assert.throws(() => buildDeps({ ...base, addonZip: { sha256: 'zz', size: 2 } }), /lastaddon\.zip invalide/);
});

test('bsdTarCandidates : tar.exe de System32 sous Windows, tar du PATH ailleurs', () => {
  assert.deepEqual(
    bsdTarCandidates({ platform: 'win32', env: { SystemRoot: 'D:\\WINDOWS' } }),
    ['D:\\WINDOWS\\System32\\tar.exe'],
  );
  assert.deepEqual(bsdTarCandidates({ platform: 'win32', env: {} }), ['C:\\Windows\\System32\\tar.exe']);
  assert.deepEqual(bsdTarCandidates({ platform: 'linux', env: {} }), ['tar']);
});

test('zipArgs : -a choisit le format zip, entrees relatives a stageDir', () => {
  assert.deepEqual(
    zipArgs('C:\\out\\ui.zip', 'C:\\stage', ['ui']),
    ['-a', '-c', '-f', 'C:\\out\\ui.zip', '-C', 'C:\\stage', 'ui'],
  );
});

test('checkZipEntries : refuse une entree hors du dossier attendu ou un fichier manquant', () => {
  const opts = { zipName: 'ui.zip', prefix: 'ui', required: ['ui/index.html'] };
  assert.doesNotThrow(() => checkZipEntries(['ui/', 'ui/index.html'], opts));
  assert.throws(() => checkZipEntries(['ui/index.html', 'autre/x.js'], opts), /hors de ui\//);
  assert.throws(() => checkZipEntries(['ui/', 'ui/a.js'], opts), /incomplet : absent ui\/index\.html/);
});

test('resolveCoreBundle : dossier dist-bundle ou fichier lastaddon.cjs ; erreurs explicites sinon', () => withTmp((dir) => {
  assert.throws(() => resolveCoreBundle(join(dir, 'absent')), /introuvable/);
  mkdirSync(join(dir, 'vide'));
  assert.throws(() => resolveCoreBundle(join(dir, 'vide')), /lastaddon\.cjs absent/);
  mkdirSync(join(dir, 'bundle'));
  writeFileSync(join(dir, 'bundle', 'lastaddon.cjs'), 'module.exports = {};');
  assert.equal(resolveCoreBundle(join(dir, 'bundle')), join(dir, 'bundle', 'lastaddon.cjs'));
  assert.equal(resolveCoreBundle(join(dir, 'bundle', 'lastaddon.cjs')), join(dir, 'bundle', 'lastaddon.cjs'));
  writeFileSync(join(dir, 'autre.cjs'), 'x');
  assert.throws(() => resolveCoreBundle(join(dir, 'autre.cjs')), /lastaddon\.cjs attendu/);
}));

test('checkWebDist : index.html requis dans --web-dist', () => withTmp((dir) => {
  assert.throws(() => checkWebDist(dir), /sans index\.html/);
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  assert.doesNotThrow(() => checkWebDist(dir));
}));

test('parseCliArgs : options completes, chemins absolus, SHA-256 normalise en minuscules', () => {
  const o = parseCliArgs([
    ...FULL_ARGS.map((a) => (a === NODE_SHA_OFFICIAL ? a.toUpperCase() : a)),
    '--commit', COMMIT,
  ]);
  assert.equal(o.version, VERSION);
  assert.equal(o.webDist, resolve('web'));
  assert.equal(o.coreBundle, resolve('bundle'));
  assert.equal(o.nodeVersion, NODE_VERSION);
  assert.equal(o.nodeSha256, NODE_SHA_OFFICIAL);
  assert.equal(o.out, resolve('out'));
  assert.equal(o.commit, COMMIT);
  assert.equal(o.branch, 'main');
});

test('parseCliArgs : refuse option manquante, inconnue, positionnelle ou mal formee', () => {
  assert.throws(() => parseCliArgs(FULL_ARGS.slice(0, -2)), /--out manquante/);
  assert.throws(() => parseCliArgs([...FULL_ARGS, '--inconnue', 'x']), /Unknown option/);
  assert.throws(() => parseCliArgs([...FULL_ARGS, 'positionnel']), /Unexpected argument/);
  assert.throws(() => parseCliArgs(['--version', '1.0', ...FULL_ARGS.slice(2)]), /--version invalide/);
  assert.throws(
    () => parseCliArgs(FULL_ARGS.map((a) => (a === NODE_VERSION ? 'v20.19.0' : a))),
    /--node-version invalide/,
  );
  assert.throws(() => normalizeOptions({ ...parseCliArgs(FULL_ARGS), commit: 'xyz' }), /--commit invalide/);
});

test('downloadNodeExe : renvoie les octets, echoue sur un statut HTTP non 2xx (serveur loopback)', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.end(Buffer.from('MZbytes'));
    } else {
      res.statusCode = 404;
      res.end('absent');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await downloadNodeExe(`${base}/ok`)).toString(), 'MZbytes');
    await assert.rejects(downloadNodeExe(`${base}/absent`), /HTTP 404/);
  } finally {
    server.close();
  }
});

test('stageDeps : node.exe au mauvais SHA-256 -> erreur explicite, aucune sortie produite', () => withTmp(async (dir) => {
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html>');
  const core = join(dir, 'core');
  mkdirSync(core);
  writeFileSync(join(core, 'lastaddon.cjs'), 'module.exports = {};');
  const out = join(dir, 'out');
  let calls = 0;
  await assert.rejects(
    stageDeps({
      version: VERSION,
      webDist: web,
      coreBundle: core,
      nodeVersion: NODE_VERSION,
      nodeSha256: NODE_SHA_OFFICIAL,
      out,
      commit: COMMIT,
      builtAt: BUILT_AT,
      fetchNode: async (url) => {
        calls += 1;
        assert.equal(url, 'https://nodejs.org/dist/v22.23.4/win-x64/node.exe');
        return Buffer.from('MZ faux node.exe');
      },
    }),
    /SHA-256 de node\.exe \(v22\.23\.4\) different du SHA-256 attendu/,
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(out), false);
}));

test('stageDeps : ui.zip, lastaddon.zip et deps.json exacts, contenus relisibles', { skip: SKIP_NO_BSDTAR }, () => withTmp(async (dir) => {
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1);');
  const core = join(dir, 'core-bundle');
  mkdirSync(core);
  const cjs = Buffer.from('module.exports = { ok: true };\n');
  writeFileSync(join(core, 'lastaddon.cjs'), cjs);
  const fakeNode = Buffer.concat([Buffer.from('MZ'), Buffer.from('faux node.exe pour le test')]);
  const nodeSha = sha256Hex(fakeNode);
  const fetched = [];
  const out = join(dir, 'out');

  const deps = await stageDeps({
    version: VERSION,
    webDist: web,
    coreBundle: core,
    nodeVersion: NODE_VERSION,
    nodeSha256: nodeSha,
    out,
    commit: COMMIT,
    builtAt: BUILT_AT,
    tarBin: TAR,
    fetchNode: async (url) => {
      fetched.push(url);
      return fakeNode;
    },
  });

  assert.deepEqual(fetched, ['https://nodejs.org/dist/v22.23.4/win-x64/node.exe']);
  assert.deepEqual(readdirSync(out).sort(), ['deps.json', 'lastaddon.zip', 'ui.zip']);
  const onDisk = JSON.parse(readFileSync(join(out, 'deps.json'), 'utf8'));
  assert.deepEqual(onDisk, deps);
  assert.equal(onDisk.tag, TAG);
  assert.equal(onDisk.nodeExe.sha256, nodeSha);
  for (const name of ['ui.zip', 'lastaddon.zip']) {
    const bytes = readFileSync(join(out, name));
    assert.equal(onDisk.files[name].sha256, sha256Hex(bytes), `sha256 de ${name}`);
    assert.equal(onDisk.files[name].size, bytes.length, `taille de ${name}`);
  }

  for (const name of ['ui.zip', 'lastaddon.zip']) {
    assert.equal(readFileSync(join(out, name)).subarray(0, 2).toString('latin1'), 'PK', `${name} est un zip (signature PK)`);
  }
  const uiEntries = listZipEntries(TAR, join(out, 'ui.zip'));
  assert.ok(uiEntries.includes('ui/index.html') && uiEntries.includes('ui/assets/app.js'), uiEntries.join(', '));
  const addonZip = join(out, 'lastaddon.zip');
  const addonEntries = listZipEntries(TAR, addonZip);
  assert.ok(
    addonEntries.includes('lastaddon/lastaddon.cjs') && addonEntries.includes('lastaddon/node.exe'),
    addonEntries.join(', '),
  );
  const extract = (entry) => spawnSync(TAR, ['-x', '-O', '-f', addonZip, entry]).stdout;
  assert.deepEqual(extract('lastaddon/node.exe'), fakeNode);
  assert.deepEqual(extract('lastaddon/lastaddon.cjs'), cjs);
}));
