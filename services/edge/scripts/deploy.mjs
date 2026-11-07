// Déploiement du Worker « laststream » (edge) depuis un tag vX.Y.Z de master uniquement (LAST-150).
// Usage : npm run deploy [-- --dry-run] [--force-unlock]
// Garde : refuse si l'arbre suivi est sale, hors master, HEAD ≠ origin/master, ou HEAD n'est pas exactement un tag vX.Y.Z publié.
// Verrou : clé KV « deploy-lock:laststream-edge » (TTL 15 min) dans le namespace LASTSTREAM_ROUTE déjà lié au Worker (wrangler.jsonc),
// libérée en fin de script, succès ou échec. --dry-run : toutes les vérifications (verrou lu, jamais écrit), sans déployer.
// Ordre : déployer lastaddon-core d'abord (le Worker appelé), puis ce Worker (l'appelant, Service Binding CORE).
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realGit, realKv, realWrangler, runDeploy } from './lib/deploy-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
// Version épinglée, comme la CI (.github/workflows/ci.yml) : wrangler n'est pas dans package.json.
const WRANGLER = 'wrangler@4.151.1';

const kv = realKv({ binding: 'LASTSTREAM_ROUTE', wranglerSpec: WRANGLER, cwd: root });
let code;
try {
  code = await runDeploy(
    { name: 'laststream-edge', branch: 'master', lockKey: 'deploy-lock:laststream-edge' },
    { dryRun: args.includes('--dry-run'), forceUnlock: args.includes('--force-unlock') },
    {
      git: realGit,
      cwd: root,
      kv,
      owner: { host: hostname(), pid: process.pid },
      proc: process,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      // --tag / --message : la version Cloudflare porte le tag et le SHA (tableau de bord, wrangler versions list).
      deploy: ({ tag, sha }) => realWrangler(WRANGLER, ['deploy', '--tag', tag, '--message', `${tag} ${sha}`], root, { inherit: true }).status ?? 1,
    },
  );
} finally {
  kv.cleanup();
}
process.exit(code);
