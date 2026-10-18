import type { RuntimeEnv } from '../types.js';

/** Variables d'exécution Node : `process.env`, lu à chaque appel (compatible avec vi.stubEnv). */
export const nodeRuntimeEnv: RuntimeEnv = {
  get: (name) => process.env[name],
  all: () => process.env,
  set: (name, value) => {
    process.env[name] = value;
  },
};
