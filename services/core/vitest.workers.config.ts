import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';
import { SUITES_WORKERS } from './vitest.suites.ts';

const harness = fileURLToPath(new URL('./tests-workers/harness.ts', import.meta.url));
const adminBackend = fileURLToPath(new URL('./tests-workers/admin-backend.ts', import.meta.url));

/**
 * Tests exécutés dans le runtime Workers (workerd, via Miniflare) : les stores contre le Durable Object SQLite, et la
 * suite de tests des routes /user du dépôt (mêmes fichiers que sous Node) contre l'application câblée sur ce DO.
 * Usage : npm run test:workers
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  resolve: {
    // Les tests /user du dépôt importent le harnais Node (serveur HTTP local) : remplacé par un harnais Workers.
    alias: [
      { find: /^\.\/lt-harness\.js$/, replacement: harness },
      { find: /^\.\/admin-backend\.js$/, replacement: adminBackend },
    ],
  },
  test: {
    include: [
      'tests-workers/**/*.test.ts',
      // Suites de tests/ (user, social, admin) : mêmes fichiers que sous Node, liste partagée dans vitest.suites.ts.
      ...SUITES_WORKERS,
    ],
    setupFiles: ['tests-workers/setup.ts'],
    // Code Molotov mis de côté (archive/molotov/) : jamais testé.
    exclude: [...configDefaults.exclude, 'archive/**'],
    // Runner CI auto-hébergé partagé et souvent chargé : workerd démarre lentement, les délais par défaut (5 s) ne suffisent pas.
    // Les tests créent des comptes (hachage scrypt) : à 11 fichiers en parallèle sur ce runner, des tests de ~1 s
    // dépassent 30 s. Parallélisme borné, délais larges.
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
