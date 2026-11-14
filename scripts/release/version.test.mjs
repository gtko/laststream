import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nextVersion, readCurrentVersion, writeVersion } from './version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DESKTOP = resolve(HERE, '..', '..', 'apps', 'desktop');
const VERSION_FILES = ['Cargo.toml', 'Cargo.lock', join('setup', 'Laststream.iss')];

/** Faux dépôt temporaire : apps/desktop avec des copies des trois fichiers réels. */
function realCopy() {
  const root = mkdtempSync(join(tmpdir(), 'laststream-version-'));
  for (const f of VERSION_FILES) {
    const dest = join(root, 'apps', 'desktop', f);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO_DESKTOP, f), dest);
  }
  return root;
}

/** Faux dépôt temporaire écrit à partir de textes donnés. */
function customCopy({ toml, lock, iss }) {
  const root = mkdtempSync(join(tmpdir(), 'laststream-version-'));
  const dir = join(root, 'apps', 'desktop');
  mkdirSync(join(dir, 'setup'), { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), toml);
  writeFileSync(join(dir, 'Cargo.lock'), lock);
  writeFileSync(join(dir, 'setup', 'Laststream.iss'), iss);
  return root;
}

const read = (root, f) => readFileSync(join(root, 'apps', 'desktop', f), 'latin1');

function withRepo(make, fn) {
  const root = make();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Cargo.toml avec une autre clé `version` avant ET après [package] : seule celle de [package] doit bouger.
const TOML = '[dependencies]\nversion = "9"\n\n[package]\nname = "laststream-shell-ng"\nversion = "1.0.17"\n'
  + 'edition = "2018"\n\n[features]\nversion = "7"\n';
const LOCK = '[[package]]\nname = "autre"\nversion = "9.9.9"\n\n[[package]]\nname = "laststream-shell-ng"\n'
  + 'version = "1.0.17"\n';
const ISS = '#define MyAppName "Laststream"\n#define MyAppVersion "1.0.17"\n';

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
  withRepo(() => customCopy({ toml: TOML, lock: LOCK, iss: ISS }), (root) => {
    assert.equal(readCurrentVersion(root), '1.0.17');
    assert.equal(readCurrentVersion(root, 'v3.4.5'), '3.4.5');
    assert.throws(() => readCurrentVersion(root, '3.4.5'));
    assert.throws(() => readCurrentVersion(root, 'v3.4'));
  });
});

test('writeVersion ne change que la version de [package] et la ligne du paquet dans Cargo.lock', () => {
  withRepo(() => customCopy({ toml: TOML, lock: LOCK, iss: ISS }), (root) => {
    writeVersion(root, '1.0.18');
    assert.equal(read(root, 'Cargo.toml'), TOML.replace('version = "1.0.17"', 'version = "1.0.18"'));
    assert.equal(read(root, 'Cargo.lock'), LOCK.replace('version = "1.0.17"', 'version = "1.0.18"'));
    assert.equal(read(root, join('setup', 'Laststream.iss')), ISS.replace('"1.0.17"', '"1.0.18"'));
  });
});

test('writeVersion sur les trois fichiers réels : une seule ligne change par fichier', () => {
  withRepo(realCopy, (root) => {
    const current = readCurrentVersion(root);
    const next = nextVersion(current, ['release:minor']);
    const before = Object.fromEntries(VERSION_FILES.map((f) => [f, read(root, f)]));
    writeVersion(root, next);

    const lines = (text) => text.split('\n');
    const changedIndex = (f) => {
      const a = lines(before[f]);
      const b = lines(read(root, f));
      assert.equal(b.length, a.length, `${f} : le nombre de lignes ne doit pas changer`);
      const changed = a.map((_, i) => i).filter((i) => a[i] !== b[i]);
      assert.equal(changed.length, 1, `${f} : une seule ligne doit changer`);
      const i = changed[0];
      assert.equal(lines(read(root, f))[i], a[i].replace(`"${current}"`, `"${next}"`), `${f} : seule la version change`);
      return i;
    };

    const tomlLine = changedIndex('Cargo.toml');
    assert.match(lines(before['Cargo.toml'])[tomlLine - 1], /^name = "laststream-shell-ng"/);
    const lockLine = changedIndex('Cargo.lock');
    assert.match(lines(before['Cargo.lock'])[lockLine - 1], /^name = "laststream-shell-ng"/);
    const issLine = changedIndex(join('setup', 'Laststream.iss'));
    assert.match(lines(before[join('setup', 'Laststream.iss')])[issLine], /^#define MyAppVersion "/);
  });
});

test('writeVersion refuse une version invalide ou hors plage, ou un paquet absent, sans rien écrire', () => {
  withRepo(realCopy, (root) => {
    const before = read(root, 'Cargo.toml');
    assert.throws(() => writeVersion(root, '1.0'));
    assert.throws(() => writeVersion(root, '1.1000.0'));
    assert.equal(read(root, 'Cargo.toml'), before);
  });
  const lockSansPaquet = '[[package]]\nname = "autre"\nversion = "9.9.9"\n';
  withRepo(() => customCopy({ toml: TOML, lock: lockSansPaquet, iss: ISS }), (root) => {
    assert.throws(() => writeVersion(root, '1.0.18'));
    assert.equal(read(root, 'Cargo.toml'), TOML);
    assert.equal(read(root, join('setup', 'Laststream.iss')), ISS);
  });
});

test('windows-manifest check reste vert après un bump de version', () => {
  withRepo(realCopy, (root) => {
    const before = readCurrentVersion(root);
    const next = nextVersion(before, []);
    assert.notEqual(next, before);
    writeVersion(root, next);
    const scriptDir = join(root, 'apps', 'desktop', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    cpSync(join(REPO_DESKTOP, 'scripts', 'windows-manifest.mjs'), join(scriptDir, 'windows-manifest.mjs'));
    const r = spawnSync(process.execPath, [join(scriptDir, 'windows-manifest.mjs'), 'check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Versions coherentes\./);
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

test('CLI --write : réécrit les trois fichiers du dépôt copié', () => {
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

test('writeVersion suit la coque Tauri : Cargo.toml et Cargo.lock réels, une seule ligne changée chacun', () => {
  withRepo(realCopy, (root) => {
    const tauri = join(root, 'apps', 'tauri', 'src-tauri');
    mkdirSync(tauri, { recursive: true });
    const realTauri = resolve(HERE, '..', '..', 'apps', 'tauri', 'src-tauri');
    for (const f of ['Cargo.toml', 'Cargo.lock']) cpSync(join(realTauri, f), join(tauri, f));
    const before = { toml: readFileSync(join(tauri, 'Cargo.toml'), 'latin1'), lock: readFileSync(join(tauri, 'Cargo.lock'), 'latin1') };
    writeVersion(root, '9.8.7');
    for (const [f, text] of [['Cargo.toml', before.toml], ['Cargo.lock', before.lock]]) {
      const a = text.split('\n');
      const b = readFileSync(join(tauri, f), 'latin1').split('\n');
      const changed = a.map((_, i) => i).filter((i) => a[i] !== b[i]);
      assert.equal(changed.length, 1, `${f} : une seule ligne doit changer`);
      assert.equal(b[changed[0]], 'version = "9.8.7"', f);
      assert.match(a[changed[0] - 1], /^name = "laststream-tauri"/, f);
    }
  });
});
