#!/usr/bin/env node
/* Installation des dépendances pour la CI. Le runner est persistant : node_modules survit d'un run à l'autre.
 *
 *   node scripts/ci-install.mjs
 *
 * Empreinte = sha256(package-lock.json) + version de Node + plateforme. Si node_modules/.ci-install-hash contient cette
 * empreinte, npm ci est ignoré. Sinon : suppression du marqueur, npm ci, puis écriture du marqueur seulement si npm ci
 * réussit. Sans dépendance externe. Les caches d'outils (node_modules/.cache) vivent dans node_modules : ils survivent
 * tant que le lockfile ne change pas. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = join(root, 'node_modules');
const marker = join(nodeModules, '.ci-install-hash');

const hash = createHash('sha256')
  .update(readFileSync(join(root, 'package-lock.json')))
  .update(`\n${process.version}\n${process.platform}`)
  .digest('hex');

if (existsSync(nodeModules) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === hash) {
  console.log('node_modules à jour, npm ci ignoré');
  process.exit(0);
}

rmSync(marker, { force: true });
const result = spawnSync('npm ci --prefer-offline --no-audit --no-fund', {
  cwd: root,
  shell: true,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`npm ci n'a pas pu démarrer : ${result.error.message}`);
}
const code = result.status ?? 1;
if (code === 0) {
  writeFileSync(marker, `${hash}\n`);
}
process.exit(code);
