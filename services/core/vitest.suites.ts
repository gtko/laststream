/**
 * Suites de tests/ exécutées aussi dans le runtime Workers (vitest.workers.config.ts), contre l'application câblée sur le
 * Durable Object. La config Node les exécute aussi : tests/setup.ts teste la plateforme Node, tests-workers/setup.ts le
 * Durable Object, donc deux passages distincts et volontaires.
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
