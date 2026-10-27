import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

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
      'tests/user-profiles.test.ts',
      'tests/user-library.test.ts',
      'tests/user-pin.test.ts',
      'tests/user-settings.test.ts',
      'tests/user-watched.test.ts',
      'tests/user-cors.test.ts',
      // Fonctions sociales : mêmes fichiers que sous Node, contre l'application câblée sur le Durable Object.
      'tests/social-*.test.ts',
      // Administration : mêmes fichiers que sous Node, contre l'application câblée sur le Durable Object.
      'tests/admin-*.test.ts',
    ],
    setupFiles: ['tests-workers/setup.ts'],
    // Code Molotov mis de côté (archive/molotov/) : jamais testé.
    exclude: [
      ...configDefaults.exclude,
      'archive/**',
      // Soirées planifiées : le store ouvre node:sqlite (Node seulement) et les routes, trop lentes sous workerd (scrypt par compte)
      // et sans salons simulés, sont couvertes par la suite Node. Sous Workers : tests-workers/evenings-alarm.test.ts et la migration.
      'tests/social-evenings-*.test.ts',
    ],
    // Runner CI auto-hébergé partagé et souvent chargé : workerd démarre lentement, les délais par défaut (5 s) ne suffisent pas.
    // Les tests créent des comptes (hachage scrypt) : à 11 fichiers en parallèle sur ce runner, des tests de ~1 s
    // dépassent 30 s. Parallélisme borné, délais larges.
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
