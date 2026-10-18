import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Installe la plateforme Node (variables d'environnement, client HTTP…) avant chaque fichier de test.
    setupFiles: ['tests/setup.ts'],
    // Copies de travail des agents (git worktree) : jamais testées depuis le dépôt principal.
    exclude: [...configDefaults.exclude, '.claude/**', 'tests-workers/**'],
  },
});
