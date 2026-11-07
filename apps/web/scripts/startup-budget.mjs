#!/usr/bin/env node
/* Budget du premier chargement : chunks JS/CSS que le navigateur charge au démarrage, calculés depuis le manifeste
 * de Vite (dist/.vite/manifest.json, build.manifest) = fermeture des imports statiques de l'entrée (src/main.js),
 * CSS compris. Les imports dynamiques ne comptent pas : ils ne sont chargés qu'à la demande.
 *
 *   node scripts/startup-budget.mjs [--dist dist] [--max-kb 500] [--max-total-gzip-kb 350] [--strict-gzip]
 *
 * Échoue (code 1) si un chunk du démarrage dépasse --max-kb (défaut 500) en octets bruts. Ko = 1000 octets, comme la
 * sortie de `vite build`. --max-total-gzip-kb borne le total gzip (niveau 9) du démarrage : simple avertissement, sauf avec
 * --strict-gzip (échec). Sans l'option, le gzip reste indicatif.
 * Lance `npm run build` avant. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const distDir = resolve(opt('--dist', 'dist'));
const maxKb = Number(opt('--max-kb', '500'));
if (!Number.isFinite(maxKb) || maxKb <= 0) {
  console.error(`--max-kb invalide : ${opt('--max-kb', '500')}`);
  process.exit(2);
}

const maxGzArg = opt('--max-total-gzip-kb', undefined);
const maxGzKb = maxGzArg === undefined ? null : Number(maxGzArg);
if (maxGzKb !== null && (!Number.isFinite(maxGzKb) || maxGzKb <= 0)) {
  console.error(`--max-total-gzip-kb invalide : ${maxGzArg}`);
  process.exit(2);
}
const strictGzip = args.includes('--strict-gzip');

const manifestPath = join(distDir, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`Manifeste introuvable : ${manifestPath}\nLance « npm run build » d'abord.`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Fermeture des imports statiques depuis les entrées ; `imports` pointe vers des clés du manifeste.
const startup = new Map(); // fichier -> { file, css }
const visit = (key) => {
  const chunk = manifest[key];
  if (!chunk || startup.has(chunk.file)) return;
  startup.set(chunk.file, { kind: 'js', file: chunk.file });
  for (const css of chunk.css ?? []) startup.set(css, { kind: 'css', file: css });
  for (const next of chunk.imports ?? []) visit(next);
};
const entries = Object.entries(manifest).filter(([, c]) => c.isEntry);
if (entries.length === 0) {
  console.error('Aucune entrée (isEntry) dans le manifeste.');
  process.exit(2);
}
for (const [key] of entries) visit(key);

const rows = [];
let totalRaw = 0;
let totalGz = 0;
for (const { kind, file } of startup.values()) {
  const path = join(distDir, file);
  if (!existsSync(path)) {
    console.error(`Fichier du manifeste absent : ${path}`);
    process.exit(2);
  }
  const buf = readFileSync(path);
  const raw = statSync(path).size;
  const gz = gzipSync(buf, { level: 9 }).length;
  totalRaw += raw;
  totalGz += gz;
  rows.push({ kind, file, raw, gz });
}
rows.sort((a, b) => b.raw - a.raw);

const kb = (n) => (n / 1000).toFixed(2).padStart(10);
console.log('Premier chargement (entrée + imports statiques, CSS compris)');
console.log(`${'brut (Ko)'.padStart(10)} ${'gzip (Ko)'.padStart(10)}  type  fichier`);
for (const r of rows) console.log(`${kb(r.raw)} ${kb(r.gz)}  ${r.kind.padEnd(4)}  ${r.file}`);
console.log(`${kb(totalRaw)} ${kb(totalGz)}  total ${rows.length} fichiers`);

const over = rows.filter((r) => r.raw > maxKb * 1000);
if (over.length) {
  console.error(`\nBudget dépassé (> ${maxKb} Ko brut par chunk du démarrage) :`);
  for (const r of over) console.error(`  ${r.file} : ${(r.raw / 1000).toFixed(2)} Ko`);
  process.exit(1);
}
if (maxGzKb !== null && totalGz > maxGzKb * 1000) {
  const msg = `Total gzip du démarrage : ${(totalGz / 1000).toFixed(2)} Ko > objectif ${maxGzKb} Ko`;
  if (strictGzip) {
    console.error(`\n${msg}`);
    process.exit(1);
  }
  console.warn(`\nAVERTISSEMENT : ${msg}`);
}
console.log(`\nBudget OK : aucun chunk du démarrage au-dessus de ${maxKb} Ko brut.`);
