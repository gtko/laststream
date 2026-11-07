// Build de lastaddon-core par Cloudflare (Workers Builds, dossier racine services/core) : construit l'interface (apps/web)
// et la copie dans worker-ui/, servi en Workers Assets (wrangler.jsonc). Cloudflare lance ensuite `npx wrangler deploy`.
// Usage : npm run build:cloudflare
// Sans worker-ui/index.html, le script échoue : Cloudflare ne déploie alors rien (jamais le Worker sans son interface).
// Déploiement à la main depuis un PC, avec la garde des tags (LAST-150) : npm run deploy:worker (voir docs/deploiement.md).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = resolve(root, '..', '..', 'apps', 'web');
const target = join(root, 'worker-ui');

const run = (command, cwd) => {
  console.log(`> ${command} (${cwd})`);
  execSync(command, { cwd, stdio: 'inherit' });
};

run('npm ci', web);
run('npm run build:ci', web);
const dist = join(web, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`Build de l'interface sans index.html : ${dist}`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });
console.log(`Interface copiée dans worker-ui/ (${readdirSync(target).length} entrées).`);
