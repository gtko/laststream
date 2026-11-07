import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde de dépôt : le code serveur (src/) ne référence aucun hôte AllDebrid ni de débridage. Le débridage se fait sur
 * l'appareil (laststream-app) ; un appel parti d'une IP Cloudflare a déjà fait suspendre le compte (ODY-227).
 * Seule la garde de sortie nomme ces hôtes, pour les refuser.
 */
const SRC = join(__dirname, '..', 'src');
const ALLOWED = new Set([join('egress', 'debrid-guard.ts')]);
/** Nom d'hôte ou URL de débridage : alldebrid.<tld>, debrid.it, api.alldebrid. Les mentions en prose (« AllDebrid. ») passent. */
const DEBRID_HOST_REFERENCE = /alldebrid\.[a-z]|debrid\.it\b|api\.alldebrid|\/\/[^\s"'`]*alldebrid/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js|mjs|cjs|json)$/.test(name) ? [path] : [];
  });
}

describe('code serveur : aucune référence à un hôte de débridage', () => {
  it('src/ ne nomme ni api.alldebrid.com, ni *.alldebrid.*, ni *.debrid.it (hors garde de sortie)', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !ALLOWED.has(relative(SRC, path)))
      .filter((path) => DEBRID_HOST_REFERENCE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'));
    expect(offenders).toEqual([]);
  }, 30000);

  it('la garde de sortie est bien posée sur les points d\'entrée serveur', () => {
    // worker.ts : la garde est posée par son tout premier import (aucun autre module ne peut capturer le fetch d'origine).
    expect(readFileSync(join(SRC, 'worker.ts'), 'utf8').trimStart().startsWith("import './egress/install.js';")).toBe(true);
    expect(readFileSync(join(SRC, 'egress', 'install.ts'), 'utf8')).toContain('installEgressGuard()');
    expect(readFileSync(join(SRC, 'server.ts'), 'utf8')).toContain('installEgressGuard()');
    expect(readFileSync(join(SRC, 'sources', 'http.ts'), 'utf8')).toContain("assertNotDebrid(target, 'fetch-bytes')");
  });
});
