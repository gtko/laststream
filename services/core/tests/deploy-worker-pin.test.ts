import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LAST-150 : npx doit lancer wrangler dans la version exacte de la devDependency (package-lock.json),
// jamais une autre version téléchargée au hasard. deploy-worker.mjs a des effets de bord à l'import : on lit son source.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const lockedWrangler = (JSON.parse(read('../package-lock.json')) as { packages: Record<string, { version?: string }> }).packages['node_modules/wrangler']?.version;

describe('deploy-worker : wrangler épinglé sur la version du lockfile', () => {
  it('WRANGLER vaut wrangler@<version exacte de package-lock.json>', () => {
    const pinned = /^const WRANGLER = 'wrangler@([^']+)';$/m.exec(read('../scripts/deploy-worker.mjs'))?.[1];
    expect(lockedWrangler).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned).toBe(lockedWrangler);
  });

  it('wrangler kv utilise la même spécification épinglée que wrangler deploy', () => {
    expect(read('../scripts/deploy-worker.mjs')).toContain("realKv({ binding: 'CACHE', wranglerSpec: WRANGLER, cwd: root })");
  });
});
