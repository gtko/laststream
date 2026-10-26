import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Relais same-origin vers le serveur de streaming Stremio : il n'envoie les en-têtes CORS qu'à strem.io / stremio.com,
// le navigateur refuserait sinon sondage, playlists HLS (audio, sous-titres) et sous-titres depuis cette origine.
const streamingServer = {
  '/_ss': { target: 'http://127.0.0.1:11470', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/_ss/, '') },
};

// Mode démo en développement seulement (pas dans `preview`) : /config/encode refuse l'origine localhost, ce relais lui présente
// celle du serveur. Il ne transmet que POST /_edge/config/encode ; tout le reste répond 404.
const demoConfigRelay = {
  '/_edge': {
    target: 'https://laststream.gtux-prog.workers.dev', changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/_edge/, ''), headers: { origin: 'https://laststream.gtux-prog.workers.dev' },
    bypass: (req: { method?: string; url?: string }) => (req.method === 'POST' && req.url === '/_edge/config/encode' ? undefined : (false as const)),
  },
};

// Identité du build, calculée une fois : sha git court + horodatage (base 36). 'dev' hors build (serveur de dev, tests).
function gitShort(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'nogit'; } catch { return 'nogit'; }
}

// Écrit version.json ({"build":"<id>"}) à la racine du build : l'interface déployée le compare à son __BUILD_ID__ embarqué.
const versionFile = (build: string): Plugin => ({
  name: 'laststream-version-json',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build }) });
  },
});

export default defineConfig(({ command }) => {
  const build = command === 'build' ? `${gitShort()}-${Date.now().toString(36)}` : 'dev';
  return {
    server: { host: '0.0.0.0', port: 8080, strictPort: true, proxy: { ...streamingServer, ...demoConfigRelay } },
    preview: { host: '0.0.0.0', port: 8080, strictPort: true, proxy: streamingServer },
    // manifest : dist/.vite/manifest.json, lu par scripts/startup-budget.mjs (budget des chunks chargés au démarrage).
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700, manifest: true },
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(build) },
    plugins: [versionFile(build)],
    test: {
      environment: 'jsdom',
      testTimeout: 120000,
      hookTimeout: 120000,
      include: ['tests/**/*.test.ts', 'src/relay/*.test.ts', 'src/relay/mesh/*.test.ts', 'src/relay/player/**/*.test.ts'],
    },
  };
});
