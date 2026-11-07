// Installation des dépendances pour la CI (runner auto-hébergé persistant : node_modules est conservé entre les runs).
// `npm ci` supprime node_modules : il ne tourne que si package-lock.json, package.json (et .npmrc s'il existe) ou la
// version de Node / la plateforme ont changé. L'empreinte est écrite dans node_modules/.ci-install-hash après un npm ci réussi.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = join(racine, 'node_modules');
const marqueur = join(nodeModules, '.ci-install-hash');

// Fichiers qui déterminent les dépendances installées ; .npmrc seulement s'il existe.
const fichiers = ['package-lock.json', 'package.json', '.npmrc'].filter((nom) => existsSync(join(racine, nom)));

const hash = createHash('sha256');
for (const nom of fichiers) {
  hash.update(`${nom}\0`).update(readFileSync(join(racine, nom))).update('\0');
}
const empreinte = hash.update(`${process.version}\n${process.platform}`).digest('hex');

function empreinteInstallee() {
  try {
    return readFileSync(marqueur, 'utf8').trim();
  } catch {
    return null;
  }
}

if (existsSync(nodeModules) && empreinteInstallee() === empreinte) {
  console.log('node_modules à jour, npm ci ignoré');
  process.exit(0);
}

rmSync(marqueur, { force: true });
const resultat = spawnSync('npm ci --prefer-offline --no-audit --no-fund', {
  cwd: racine,
  stdio: 'inherit',
  shell: true,
});
const code = resultat.status ?? 1;
if (code === 0) {
  writeFileSync(marqueur, `${empreinte}\n`);
}
process.exit(code);
