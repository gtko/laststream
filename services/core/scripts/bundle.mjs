// Bundle mono-fichier de lastAddon : dist-bundle/lastaddon.cjs (CommonJS, Node 22, dépendances incluses).
// Les modules node: (dont node:sqlite) restent des imports natifs. Usage : npm run bundle
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'dist-bundle');
mkdirSync(outDir, { recursive: true });

// Dans un CJS, import.meta.url n'existe pas. Le bundle se comporte comme un module situé à
// <dossier du bundle>/bundle/entry/node/ : les défauts (data/, .env) se trouvent donc à côté du bundle.
const IMPORT_META_URL_BANNER =
  "const __lastaddonImportMetaUrl = require('node:url').pathToFileURL(require('node:path').join(__dirname, 'bundle', 'entry', 'node', 'lastaddon.js')).href;";

await build({
  entryPoints: [join(root, 'src', 'bundle.ts')],
  outfile: join(outDir, 'lastaddon.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['node:*'],
  banner: { js: IMPORT_META_URL_BANNER },
  define: { 'import.meta.url': '__lastaddonImportMetaUrl' },
  logLevel: 'info',
});
