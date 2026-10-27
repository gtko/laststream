/**
 * Suites de tests/ exécutées dans le runtime Workers (vitest.workers.config.ts) : mêmes fichiers que sous Node, contre
 * l'application câblée sur le Durable Object. Liste unique : la config Node (vitest.config.ts) les exclut pour qu'elles ne
 * tournent pas deux fois (npm test), la config Workers les inclut.
 */
export const SUITES_WORKERS = [
  // Routes /user.
  'tests/user-profiles.test.ts',
  'tests/user-library.test.ts',
  'tests/user-pin.test.ts',
  'tests/user-settings.test.ts',
  'tests/user-watched.test.ts',
  'tests/user-cors.test.ts',
  // Fonctions sociales.
  'tests/social-*.test.ts',
  // Administration.
  'tests/admin-*.test.ts',
];
