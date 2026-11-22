// Paquet .ipk webOS (LAST-1643) : relu par un lecteur ar/tar minimal, et par `ar` et `tar` du système quand ils existent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildIpk } from './ipk.mjs';

/** Membres d'une archive ar. */
function readAr(buf) {
  assert.equal(buf.subarray(0, 8).toString('ascii'), '!<arch>\n');
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const h = buf.subarray(off, off + 60).toString('ascii');
    assert.equal(h.slice(58, 60), '`\n', 'fin d\'en-tête ar');
    const size = Number(h.slice(48, 58).trim());
    out.push({ name: h.slice(0, 16).trim(), data: buf.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  return out;
}

/** Entrées d'un tar.gz : chemin, type, contenu ; vérifie la somme de contrôle de chaque en-tête. */
function readTarGz(gz) {
  const buf = gunzipSync(gz);
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const want = parseInt(str(148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(sum, want, 'somme de contrôle tar');
    const size = parseInt(str(124, 136), 8);
    const prefix = str(345, 500);
    out.push({ path: (prefix ? prefix + '/' : '') + str(0, 100), type: str(156, 157), mode: parseInt(str(100, 108), 8), data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const appinfo = { id: 'com.laststream.app', version: '1.2.3', vendor: 'Laststream', title: 'Laststream', type: 'web', main: 'index.html' };
const files = [
  { path: 'appinfo.json', data: Buffer.from(JSON.stringify(appinfo)) },
  { path: 'index.html', data: Buffer.from('<!doctype html><title>x</title>') },
  { path: 'img/icon.png', data: Buffer.alloc(1025, 7) },
];

test("le paquet a la forme d'un .ipk d'ares-package", () => {
  const members = readAr(buildIpk({ appinfo, files, mtime: 1700000000 }));
  assert.deepEqual(members.map((m) => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(members[0].data.toString(), '2.0\n');

  const control = readTarGz(members[1].data);
  assert.deepEqual(control.map((e) => e.path), ['control']);
  const fields = Object.fromEntries(control[0].data.toString().trim().split('\n').map((l) => l.split(': ')));
  assert.equal(fields.Package, 'com.laststream.app');
  assert.equal(fields.Version, '1.2.3');
  assert.equal(fields.Architecture, 'all');
  assert.equal(fields['webOS-Package-Format-Version'], '2');

  const data = readTarGz(members[2].data);
  const base = 'usr/palm/applications/com.laststream.app/';
  assert.deepEqual(data.filter((e) => e.type === '0').map((e) => e.path), [
    base + 'appinfo.json', base + 'img/icon.png', base + 'index.html', 'usr/palm/packages/com.laststream.app/packageinfo.json',
  ]);
  // Chaque dossier parent est présent avant son contenu, en 0755.
  const dirs = data.filter((e) => e.type === '5');
  assert.ok(dirs.some((d) => d.path === base + 'img/'));
  assert.ok(dirs.every((d) => d.mode === 0o755));
  assert.deepEqual(data.find((e) => e.path === base + 'img/icon.png').data, files[2].data);
  const pkg = JSON.parse(data.find((e) => e.path.endsWith('packageinfo.json')).data.toString());
  assert.deepEqual(pkg, { id: 'com.laststream.app', version: '1.2.3', app: 'com.laststream.app' });
});

test('même entrée, même paquet (date fixée)', () => {
  assert.deepEqual(buildIpk({ appinfo, files, mtime: 1 }), buildIpk({ appinfo, files, mtime: 1 }));
});

test('refuse un identifiant ou une version que la TV refuserait', () => {
  assert.throws(() => buildIpk({ appinfo: { ...appinfo, id: 'Laststream' }, files }), /Identifiant/);
  assert.throws(() => buildIpk({ appinfo: { ...appinfo, version: '1.2' }, files }), /Version/);
  assert.throws(() => buildIpk({ appinfo, files: files.slice(1) }), /appinfo\.json/);
});

test('lisible par ar et tar du système', (t) => {
  try { execFileSync('ar', ['--version'], { stdio: 'ignore' }); execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { t.skip('ar ou tar absent'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'ipk-'));
  writeFileSync(join(dir, 'app.ipk'), buildIpk({ appinfo, files, mtime: 1700000000 }));
  assert.deepEqual(execFileSync('ar', ['t', 'app.ipk'], { cwd: dir }).toString().trim().split('\n'), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  execFileSync('ar', ['x', 'app.ipk'], { cwd: dir });
  execFileSync('tar', ['xzf', 'data.tar.gz'], { cwd: dir });
  assert.deepEqual(readFileSync(join(dir, 'usr/palm/applications/com.laststream.app/img/icon.png')), files[2].data);
});

test("l'app du dépôt est valide", () => {
  const info = JSON.parse(readFileSync(new URL('../app/appinfo.json', import.meta.url), 'utf8'));
  assert.equal(info.id, 'com.laststream.app');
  assert.equal(info.type, 'web');
  assert.equal(info.disableBackHistoryAPI, true, 'la touche Retour doit arriver à la page (ui/webosKeys.js)');
  for (const f of [info.main, info.icon, info.largeIcon, info.splashBackground]) {
    assert.ok(readFileSync(new URL('../app/' + f, import.meta.url)).length > 0, f);
  }
});
