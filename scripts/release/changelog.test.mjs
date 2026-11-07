import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prependToChangelog, renderSection } from './changelog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRS = [
  { number: 12, title: 'Ajout du changelog', author: 'gtko' },
  { number: 13, title: 'LAST-1617 : scripts de version', author: 'octocat' },
];

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'laststream-changelog-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('renderSection : titre, date et une puce par PR avec numéro et auteur', () => {
  assert.equal(
    renderSection('1.0.33', '2026-11-07', PRS),
    '## v1.0.33 – 2026-11-07\n\n- Ajout du changelog (#12) — @gtko\n- LAST-1617 : scripts de version (#13) — @octocat\n',
  );
});

test('renderSection sans PR écrit une seule puce Maintenance', () => {
  assert.equal(renderSection('1.0.33', '2026-11-07', []), '## v1.0.33 – 2026-11-07\n\n- Maintenance\n');
});

test('renderSection accepte un v devant la version et refuse version ou date invalides', () => {
  assert.equal(renderSection('v1.0.33', '2026-11-07', []), renderSection('1.0.33', '2026-11-07', []));
  assert.throws(() => renderSection('1.0', '2026-11-07', []));
  assert.throws(() => renderSection('1.0.33', '07/11/2026', []));
  assert.throws(() => renderSection('1.0.33', '2026-02-30', []));
});

test('prependToChangelog crée CHANGELOG.md avec son en-tête si le fichier manque', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    const section = renderSection('1.0.33', '2026-11-07', PRS);
    assert.equal(prependToChangelog(file, section), true);
    assert.equal(readFileSync(file, 'utf8'), `# Changelog\n\n${section}`);
  });
});

test('prependToChangelog place la version la plus récente juste après l en-tête', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    const s32 = renderSection('1.0.32', '2026-10-23', [{ number: 1, title: 'Premier', author: 'a' }]);
    const s33 = renderSection('1.0.33', '2026-11-07', PRS);
    prependToChangelog(file, s32);
    assert.equal(prependToChangelog(file, s33), true);
    assert.equal(readFileSync(file, 'utf8'), `# Changelog\n\n${s33}\n${s32}`);
  });
});

test('prependToChangelog garde le contenu existant intact', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    const old = '# Changelog\n\n## v1.0.31 – 2026-10-01\n\n- Vieux (#3) — @a\n';
    writeFileSync(file, old);
    const s33 = renderSection('1.0.33', '2026-11-07', PRS);
    prependToChangelog(file, s33);
    assert.equal(readFileSync(file, 'utf8'), `# Changelog\n\n${s33}\n${old.slice('# Changelog\n\n'.length)}`);
  });
});

test('prependToChangelog est idempotent : une version déjà présente n est pas réinsérée', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    const section = renderSection('1.0.33', '2026-11-07', PRS);
    prependToChangelog(file, section);
    const first = readFileSync(file, 'utf8');
    assert.equal(prependToChangelog(file, section), false);
    assert.equal(readFileSync(file, 'utf8'), first);
    assert.equal(first.split('## v1.0.33').length - 1, 1);
  });
});

test('prependToChangelog compare la version entière : v1.0.330 ne bloque pas v1.0.33', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, '# Changelog\n\n## v1.0.330 – 2026-11-01\n\n- Autre\n');
    assert.equal(prependToChangelog(file, renderSection('1.0.33', '2026-11-07', [])), true);
    assert.match(readFileSync(file, 'utf8'), /^# Changelog\n\n## v1\.0\.33 – 2026-11-07\n/);
  });
});

test('prependToChangelog refuse une section sans titre de version, sans rien créer', () => {
  withDir((dir) => {
    const file = join(dir, 'CHANGELOG.md');
    assert.throws(() => prependToChangelog(file, 'pas une section\n'));
    assert.equal(existsSync(file), false);
  });
});

test('CLI : écrit la section (--section-out) et l entrée (--out), idempotente au second passage', () => {
  withDir((dir) => {
    const prsFile = join(dir, 'prs.json');
    const out = join(dir, 'CHANGELOG.md');
    const sectionOut = join(dir, 'section.md');
    writeFileSync(prsFile, JSON.stringify(PRS));
    const args = [
      join(HERE, 'changelog.mjs'),
      '--version', '1.0.33', '--date', '2026-11-07', '--prs', prsFile, '--out', out, '--section-out', sectionOut,
    ];
    const expected = renderSection('1.0.33', '2026-11-07', PRS);
    execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(readFileSync(sectionOut, 'utf8'), expected);
    assert.equal(readFileSync(out, 'utf8'), `# Changelog\n\n${expected}`);
    execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(readFileSync(out, 'utf8'), `# Changelog\n\n${expected}`);
  });
});
