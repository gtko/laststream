import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La feuille du bas (mobile) est en position: fixed dans la carte des billets. Un ancêtre avec `container-type`
 * deviendrait son bloc de référence : elle se collerait au bas de la carte et non de l'écran. Seule la rangée
 * de billets est donc un conteneur de requête (jsdom ne calcule pas la mise en page : on vérifie la source).
 */
describe('billets : containment de la feuille du bas', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tickets.css'), 'utf8');
  const rule = (selector: string): string => {
    const m = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };

  it('le conteneur englobant de la région repliable n\'est pas un conteneur de requête', () => {
    expect(rule('.tk-fold-in')).not.toBe('');
    expect(rule('.tk-fold-in')).not.toMatch(/container/);
  });

  it('seule la rangée de billets (.tk-row-wrap) est un conteneur de requête', () => {
    expect(rule('.tk-row-wrap')).toMatch(/container:\s*tkfold\s*\/\s*inline-size/);
  });

  it('le panneau et la feuille ne sont pas dans le conteneur de requête', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/invites.js'), 'utf8');
    const row = src.indexOf('class="tk-row-wrap"');
    const close = src.indexOf("'</div></div>' + dots + legend", row);
    expect(row).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(row);
    expect(src.slice(row, close)).not.toContain('data-tk-pane');
  });
});
