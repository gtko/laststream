import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Installe la plateforme Node (variables d'environnement, client HTTP…) avant chaque fichier de test.
    setupFiles: ['tests/setup.ts'],
    // Copies de travail des agents (git worktree) : jamais testées depuis le dépôt principal.
    exclude: [...configDefaults.exclude, '.claude/**', 'tests-workers/**', 'archive/**'],
    // --changed (CI sur PR) relance toute la suite si une config, package.json ou la liste des suites change.
    forceRerunTriggers: ['**/package.json/**', '**/vite.config.*/**', '**/vitest.config.*/**', '**/vitest.workers.config.*/**', '**/vitest.suites.*/**'],
  },
});
