import { createNodeUserBackend } from '../src/platform/node/user-backend.js';
import type { UserBackend } from '../src/user/repo.js';

/** Dépôts de test (Node : base en mémoire). La configuration Workers remplace ce module par un Durable Object neuf. */
export function newBackend(): UserBackend {
  return createNodeUserBackend({ path: ':memory:' });
}
