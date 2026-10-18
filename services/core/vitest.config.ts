import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Installe la plateforme Node (variables d'environnement, client HTTP…) avant chaque fichier de test.
    setupFiles: ['tests/setup.ts'],
  },
});
