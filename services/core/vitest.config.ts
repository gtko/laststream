import { configDefaults, defineConfig } from 'vitest/config';
import { SUITES_WORKERS } from './vitest.suites.ts';

export default defineConfig({
  test: {
    // Installe la plateforme Node (variables d'environnement, client HTTP…) avant chaque fichier de test.
    setupFiles: ['tests/setup.ts'],
    // Copies de travail des agents (git worktree) : jamais testées depuis le dépôt principal.
    // Suites de tests/ aussi exécutées par la config Workers : exclues ici pour ne pas tourner deux fois.
    exclude: [...configDefaults.exclude, '.claude/**', 'tests-workers/**', 'archive/**', ...SUITES_WORKERS],
  },
});
