// Déploiement du Worker « lastaddon-core » : copie le build de l'interface (laststream-app) dans worker-ui/, puis wrangler deploy.
// Usage : npm run deploy:worker [-- --ui <dossier du build>] [-- --dry-run]
// Dossier du build : --ui, sinon LASTADDON_UI_SOURCE, sinon ..\laststream-app\dist (dépôts voisins) puis le chemin local de gtko.
// Les secrets ne passent jamais par ce script : wrangler secret put (voir README, « Cloudflare Workers »).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'worker-ui');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const candidates = [
  option('--ui'),
  process.env.LASTADDON_UI_SOURCE,
  resolve(root, '..', 'laststream-app', 'dist'),
  'C:\\Users\\grego\\Projets\\laststream\\laststream-app\\dist',
].filter((path) => path !== undefined && path !== '');
const source = candidates.find((path) => existsSync(join(path, 'index.html')));
if (source === undefined) {
  console.error('Build de l\'interface introuvable (index.html) : passez --ui <dossier> ou définissez LASTADDON_UI_SOURCE.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [name]));
console.log(`Interface copiée : ${files(target).length} fichiers depuis ${source}`);

const wrangler = ['wrangler', 'deploy', ...(flag('--dry-run') ? ['--dry-run'] : [])];
const result = spawnSync('npx', wrangler, { cwd: root, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
