import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  arg, buildManifest, parseInstallerName, versionCode,
} from './windows-manifest.mjs';

const SHA = 'a'.repeat(64);

test('parseInstallerName accepte X.Y.Z et refuse le reste', () => {
  assert.equal(parseInstallerName('Laststream-Setup-1.0.17.exe'), '1.0.17');
  assert.throws(() => parseInstallerName('Autre-Setup-1.0.17.exe'));
  assert.throws(() => parseInstallerName('Laststream-Setup-1.0.exe'));
  assert.throws(() => parseInstallerName('../Laststream-Setup-1.0.17.exe'));
});

test('versionCode croit avec la version', () => {
  assert.equal(versionCode('1.0.17'), 1000017);
  assert.ok(versionCode('1.0.18') > versionCode('1.0.17'));
  assert.ok(versionCode('1.1.0') > versionCode('1.0.999'));
  assert.ok(versionCode('2.0.0') > versionCode('1.999.999'));
  assert.throws(() => versionCode('1.0'));
  assert.throws(() => versionCode('1.0.1000'));
});

test('buildManifest produit le schema Android + descripteur de l updater natif', () => {
  const m = buildManifest({
    name: 'Laststream-Setup-1.0.17.exe', sha256: SHA, size: 123, notes: 'n', publishedAt: '2026-10-23T00:00:00.000Z',
    baseUrl: 'https://exemple.test/app/windows/',
  });
  assert.equal(m.version, '1.0.17');
  assert.equal(m.versionName, '1.0.17');
  assert.equal(m.versionCode, 1000017);
  assert.equal(m.url, 'https://exemple.test/app/windows/Laststream-Setup-1.0.17.exe');
  assert.equal(m.sha256, SHA);
  assert.equal(m.size, 123);
  assert.equal(m.notes, 'n');
  assert.equal(m.versionDesc, 'https://exemple.test/app/windows/latest.json');
  assert.deepEqual(m.files, [{ name: 'Laststream-Setup-1.0.17.exe', url: m.url, checksum: SHA, os: 'windows' }]);
});

test('buildManifest refuse sha256, taille ou base invalides', () => {
  const ok = { name: 'Laststream-Setup-1.0.17.exe', sha256: SHA, size: 1 };
  assert.throws(() => buildManifest({ ...ok, sha256: 'ABC' }));
  assert.throws(() => buildManifest({ ...ok, sha256: SHA.toUpperCase() }));
  assert.throws(() => buildManifest({ ...ok, size: 0 }));
  assert.throws(() => buildManifest({ ...ok, baseUrl: 'http://exemple.test' }));
});

test('arg ignore une valeur absente ou qui est un autre drapeau (PowerShell 5.1 supprime les arguments vides)', () => {
  assert.equal(arg(['x.exe', '--notes', 'ok', '--out', 'f'], '--notes'), 'ok');
  assert.equal(arg(['x.exe', '--notes', '--out', 'f'], '--notes'), undefined);
  assert.equal(arg(['x.exe', '--notes', '--out', 'f'], '--out'), 'f');
  assert.equal(arg(['x.exe', '--notes'], '--notes'), undefined);
  assert.equal(arg(['x.exe'], '--notes'), undefined);
});

test('build ecrit le flux quand le script est lance directement (chemins Windows compris)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ls-manifest-'));
  const exe = join(dir, 'Laststream-Setup-1.0.65.exe');
  writeFileSync(exe, 'installeur');
  const out = join(dir, 'latest.json');
  const script = fileURLToPath(new URL('./windows-manifest.mjs', import.meta.url));
  execFileSync(process.execPath, [script, 'build', exe, '--notes', 'Laststream v1.0.65', '--out', out]);
  const m = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(m.url, 'https://app.laststream.app/app/windows/Laststream-Setup-1.0.65.exe');
  assert.equal(m.files[0].os, 'windows');
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
});
