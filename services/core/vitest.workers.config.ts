import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const harness = fileURLToPath(new URL('./tests-workers/harness.ts', import.meta.url));

/**
 * Tests exécutés dans le runtime Workers (workerd, via Miniflare) : les stores contre le Durable Object SQLite, et la
 * suite de tests des routes /user du dépôt (mêmes fichiers que sous Node) contre l'application câblée sur ce DO.
 * Usage : npm run test:workers
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
  resolve: {
    // Les tests /user du dépôt importent le harnais Node (serveur HTTP local) : remplacé par un harnais Workers.
    alias: [{ find: /^\.\/lt-harness\.js$/, replacement: harness }],
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
    ],
    setupFiles: ['tests-workers/setup.ts'],
  },
});
