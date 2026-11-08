// Tests de la bannière de release (LAST-1617) : PNG valide 1280x640, échappement XML, troncature, limite à 5 points, repli vide, CLI.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, escapeXml, FONT_FILE, renderPng, truncate } from './banner.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCRIPT = fileURLToPath(new URL('./banner.mjs', import.meta.url));
const highlightCount = (svg) => (svg.match(/class="highlight"/g) ?? []).length;

function readPngSize(png) {
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, 'signature PNG absente');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', 'chunk IHDR absent');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('renderPng', () => {
  test('produit un PNG de 1280 x 640 (signature et IHDR)', () => {
    const png = renderPng(buildSvg({ version: '1.0.33', date: '2026-11-07', highlights: ['Lecteur plus fluide'] }));
    assert.deepEqual(readPngSize(png), { width: 1280, height: 640 });
  });

  test('la police Plus Jakarta Sans du dépôt existe à l\'emplacement attendu', () => {
    assert.ok(existsSync(FONT_FILE), `police absente : ${FONT_FILE}`);
  });
});

describe('buildSvg', () => {
  test('dimensions 1280 x 640 et police Plus Jakarta Sans', () => {
    const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights: [] });
    assert.match(svg, /<svg[^>]*width="1280" height="640"/);
    assert.match(svg, /font-family="Plus Jakarta Sans/);
  });

  test('affiche le titre, la version, la date en français et le pied', () => {
    const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights: ['Nouveau lecteur'] });
    assert.ok(svg.includes('>Laststream<'));
    assert.ok(svg.includes('>v1.0.33<'));
    assert.ok(svg.includes('>7 novembre 2026<'));
    assert.ok(svg.includes('>Windows · Android<'));
  });

  test('une date non ISO est affichée telle quelle', () => {
    const svg = buildSvg({ version: '1.0.33', date: '7 nov.', highlights: [] });
    assert.ok(svg.includes('>7 nov.<'));
  });

  test('échappe < > & " et \' dans les points forts', () => {
    const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights: ['<script>&"\''] });
    assert.ok(!svg.includes('<script>'), 'balise <script> non échappée');
    assert.ok(svg.includes('&lt;script&gt;&amp;&quot;&apos;'), 'caractères spéciaux non échappés');
  });

  test('échappe aussi la version', () => {
    const svg = buildSvg({ version: '<b>&', date: '2026-11-07', highlights: [] });
    assert.ok(!svg.includes('<b>'), 'version non échappée');
    assert.ok(svg.includes('&lt;b&gt;&amp;'));
  });

  test('tronque chaque point à 60 caractères avec « … »', () => {
    const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights: ['a'.repeat(100)] });
    assert.ok(svg.includes(`${'a'.repeat(59)}…`), 'point non tronqué à 59 caractères suivis de « … »');
    assert.ok(!svg.includes('a'.repeat(60)), 'point trop long non tronqué');
  });

  test('garde au plus 5 points forts, les 5 premiers', () => {
    const highlights = ['Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Point 6', 'Point 7'];
    const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights });
    assert.equal(highlightCount(svg), 5);
    assert.ok(svg.includes('>Point 5<'));
    assert.ok(!svg.includes('Point 6'), 'le 6e point ne doit pas apparaître');
  });

  test('sans point fort, affiche « Corrections et améliorations »', () => {
    for (const highlights of [[], undefined, ['   ', '']]) {
      const svg = buildSvg({ version: '1.0.33', date: '2026-11-07', highlights });
      assert.ok(svg.includes('>Corrections et améliorations<'), `repli absent pour ${JSON.stringify(highlights)}`);
      assert.equal(highlightCount(svg), 1, 'le repli doit être le seul point affiché');
    }
  });
});

describe('truncate', () => {
  test('ne touche pas un texte de 60 caractères ou moins', () => {
    assert.equal(truncate('a'.repeat(60)), 'a'.repeat(60));
    assert.equal(truncate('court'), 'court');
  });

  test('un texte de 61 caractères devient 59 caractères suivis de « … » (60 au total)', () => {
    const result = truncate('b'.repeat(61));
    assert.equal([...result].length, 60);
    assert.equal(result, `${'b'.repeat(59)}…`);
  });

  test('compte les caractères et non les unités de code UTF-16', () => {
    const result = truncate('é'.repeat(70));
    assert.equal(result, `${'é'.repeat(59)}…`);
  });
});

describe('escapeXml', () => {
  test('remplace les cinq caractères spéciaux XML', () => {
    assert.equal(escapeXml(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
  });
});

describe('CLI', () => {
  test('écrit un PNG 1280 x 640 à partir d\'un fichier de points forts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'banner-test-'));
    try {
      const highlights = join(dir, 'highlights.json');
      const out = join(dir, 'banner.png');
      writeFileSync(highlights, JSON.stringify(['Lecture plus fluide', 'Sous-titres corrigés', 'Recherche rapide & sûre']));
      execFileSync(process.execPath, [SCRIPT, '--version', '1.0.33', '--date', '2026-11-07', '--highlights', highlights, '--out', out], { stdio: 'pipe' });
      assert.deepEqual(readPngSize(readFileSync(out)), { width: 1280, height: 640 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sans --version ni --out, échoue avec un message d\'usage', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--date', '2026-11-07'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage/);
  });
});
