import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nextVersion, readCurrentVersion, writeVersion } from './version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join('apps', 'tauri', 'src-tauri');
const REPO_APP = resolve(HERE, '..', '..', APP_DIR);
const VERSION_FILES = ['Cargo.toml', 'Cargo.lock'];

/** Faux dépôt temporaire : apps/tauri/src-tauri avec des copies des deux fichiers réels. */
function realCopy() {
  const root = mkdtempSync(join(tmpdir(), 'laststream-version-'));
  mkdirSync(join(root, APP_DIR), { recursive: true });
  for (const f of VERSION_FILES) cpSync(join(REPO_APP, f), join(root, APP_DIR, f));
  return root;
}

/** Faux dépôt temporaire écrit à partir de textes donnés. */
function customCopy({ toml, lock }) {
  const root = mkdtempSync(join(tmpdir(), 'laststream-version-'));
  const dir = join(root, APP_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), toml);
  writeFileSync(join(dir, 'Cargo.lock'), lock);
  return root;
}

const read = (root, f) => readFileSync(join(root, APP_DIR, f), 'latin1');

function withRepo(make, fn) {
  const root = make();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Cargo.toml avec une autre clé `version` avant ET après [package] : seule celle de [package] doit bouger.
const TOML = '[dependencies]\nversion = "9"\n\n[package]\nname = "laststream-tauri"\nversion = "1.0.17"\n'
  + 'edition = "2021"\n\n[features]\nversion = "7"\n';
const LOCK = '[[package]]\nname = "autre"\nversion = "9.9.9"\n\n[[package]]\nname = "laststream-tauri"\n'
  + 'version = "1.0.17"\n';

test('nextVersion : patch par défaut, minor et major selon les labels', () => {
  assert.equal(nextVersion('1.0.32', []), '1.0.33');
  assert.equal(nextVersion('1.0.32', ['Feature', 'Bug']), '1.0.33');
  assert.equal(nextVersion('1.0.32', ['release:minor']), '1.1.0');
  assert.equal(nextVersion('1.4.9', ['release:minor']), '1.5.0');
  assert.equal(nextVersion('1.0.32', ['release:major']), '2.0.0');
  assert.equal(nextVersion('1.4.9', ['release:minor', 'release:major']), '2.0.0');
});

test('nextVersion refuse une version courante invalide', () => {
  for (const bad of ['v1.0.32', '1.0', '1.0.x', '1.01.0', '', undefined]) {
    assert.throws(() => nextVersion(bad, []));
  }
});

test('readCurrentVersion : le tag l emporte, sinon la version de [package] dans Cargo.toml', () => {
  withRepo(() => customCopy({ toml: TOML, lock: LOCK }), (root) => {
    assert.equal(readCurrentVersion(root), '1.0.17');
    assert.equal(readCurrentVersion(root, 'v3.4.5'), '3.4.5');
    assert.throws(() => readCurrentVersion(root, '3.4.5'));
    assert.throws(() => readCurrentVersion(root, 'v3.4'));
  });
});

test('writeVersion ne change que la version de [package] et la ligne du paquet dans Cargo.lock', () => {
  withRepo(() => customCopy({ toml: TOML, lock: LOCK }), (root) => {
    writeVersion(root, '1.0.18');
    assert.equal(read(root, 'Cargo.toml'), TOML.replace('version = "1.0.17"', 'version = "1.0.18"'));
    assert.equal(read(root, 'Cargo.lock'), LOCK.replace('version = "1.0.17"', 'version = "1.0.18"'));
  });
});

test('writeVersion sur les fichiers réels de l app Tauri : une seule ligne change par fichier', () => {
  withRepo(realCopy, (root) => {
    const current = readCurrentVersion(root);
    const next = nextVersion(current, ['release:minor']);
    const before = Object.fromEntries(VERSION_FILES.map((f) => [f, read(root, f)]));
    writeVersion(root, next);
    for (const f of VERSION_FILES) {
      const a = before[f].split('\n');
      const b = read(root, f).split('\n');
      assert.equal(b.length, a.length, `${f} : le nombre de lignes ne doit pas changer`);
      const changed = a.map((_, i) => i).filter((i) => a[i] !== b[i]);
      assert.equal(changed.length, 1, `${f} : une seule ligne doit changer`);
      assert.equal(b[changed[0]], a[changed[0]].replace(`"${current}"`, `"${next}"`), `${f} : seule la version change`);
      assert.match(a[changed[0] - 1], /^name = "laststream-tauri"/, f);
    }
  });
});

test('writeVersion refuse une version invalide ou un paquet absent, sans rien écrire', () => {
  withRepo(realCopy, (root) => {
    const before = read(root, 'Cargo.toml');
    assert.throws(() => writeVersion(root, '1.0'));
    assert.equal(read(root, 'Cargo.toml'), before);
  });
  const lockSansPaquet = '[[package]]\nname = "autre"\nversion = "9.9.9"\n';
  withRepo(() => customCopy({ toml: TOML, lock: lockSansPaquet }), (root) => {
    assert.throws(() => writeVersion(root, '1.0.18'));
    assert.equal(read(root, 'Cargo.toml'), TOML);
  });
});

test('CLI : affiche la version suivante sans écrire de fichier', () => {
  const out = execFileSync(
    process.execPath,
    [join(HERE, 'version.mjs'), '--labels', 'release:minor', '--last-tag', 'v1.0.32'],
    { encoding: 'utf8' },
  );
  assert.equal(out, '1.1.0\n');
});

test('CLI --write : réécrit les deux fichiers du dépôt copié', () => {
  const make = () => {
    const root = realCopy();
    const dir = join(root, 'scripts', 'release');
    mkdirSync(dir, { recursive: true });
    cpSync(join(HERE, 'version.mjs'), join(dir, 'version.mjs'));
    return root;
  };
  withRepo(make, (root) => {
    const before = readCurrentVersion(root);
    const expected = nextVersion(before, ['release:major']);
    const out = execFileSync(
      process.execPath,
      [join(root, 'scripts', 'release', 'version.mjs'), '--labels', 'release:major', '--write'],
      { encoding: 'utf8' },
    );
    assert.equal(out, `${expected}\n`);
    assert.equal(readCurrentVersion(root), expected);
  });
});
