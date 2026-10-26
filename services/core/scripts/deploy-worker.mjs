// Déploiement du Worker « lastaddon-core » : copie le build de l'interface (laststream-app) dans worker-ui/, puis wrangler deploy.
// Usage : npm run deploy:worker [-- --ui <dossier du build>] [--dry-run] [--force-unlock]
// Garde (LAST-150) : refuse si l'arbre suivi est sale, hors main, HEAD ≠ origin/main, ou HEAD n'est pas exactement un tag vX.Y.Z ;
// avec l'interface, laststream-app doit aussi être propre et à jour sur main. Verrou KV contre deux déploiements simultanés.
// --dry-run : toutes les vérifications (garde, verrou en lecture), sans copie ni déploiement. Voir docs/deploiement.md.
// Dossier du build : --ui, sinon LASTADDON_UI_SOURCE, sinon ..\laststream-app\dist (dépôts voisins) puis le chemin local de gtko.
// Les secrets ne passent jamais par ce script : wrangler secret put (voir README, « Cloudflare Workers »).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realGit, realKv, realWrangler, runDeploy } from './lib/deploy-guard.mjs';

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

// wrangler est une devDependency du dépôt, épinglée sur sa version exacte de package-lock.json (test : tests/deploy-worker-pin.test.ts) :
// npx ne doit jamais en télécharger une autre.
const WRANGLER = 'wrangler@4.151.1';
const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [name]));

// Dépôt de l'interface : le dossier parent du build (dist/ → laststream-app). Les commandes git y sont lancées avec -C.
const uiRepo = realGit(['rev-parse', '--show-toplevel'], resolve(source, '..')).stdout.trim() || resolve(source, '..');

const kv = realKv({ binding: 'CACHE', wranglerSpec: WRANGLER, cwd: root });
let code;
try {
  code = await runDeploy(
    { name: 'lastaddon', branch: 'main', lockKey: 'deploy-lock:lastaddon-core' },
    { dryRun: flag('--dry-run'), forceUnlock: flag('--force-unlock') },
    {
      git: realGit,
      cwd: root,
      kv,
      uiRepo,
      owner: { host: hostname(), pid: process.pid },
      proc: process,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      deploy: ({ tag, sha, uiSha }) => {
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        cpSync(source, target, { recursive: true });
        console.log(`Interface copiée : ${files(target).length} fichiers depuis ${source}`);
        const message = `${tag} ${sha}${uiSha === undefined ? '' : ` ui:${uiSha}`}`;
        // --var LASTADDON_RELEASE : le Worker publie ce tag dans /health et comme release Sentry (serverRelease, src/app.ts).
        return realWrangler(WRANGLER, ['deploy', '--tag', tag, '--message', message, '--var', `LASTADDON_RELEASE:${tag}`], root, { inherit: true }).status ?? 1;
      },
    },
  );
} finally {
  kv.cleanup();
}
process.exit(code);
