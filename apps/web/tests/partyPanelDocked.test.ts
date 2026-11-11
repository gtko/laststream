// Lecteur natif Android réduit en vignette : le lecteur web est masqué, le panneau watch party passe sur la page (is-docked)
// et revient dans le lecteur ensuite. Ses écouteurs (portés par le panneau) restent actifs.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

let panel: typeof import('../src/ui/partypanel.js');
let root: HTMLElement;
const panelOf = () => document.querySelector('aside.lp-party') as HTMLElement;

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  panel = await import('../src/ui/partypanel.js');
  root = document.createElement('div');
  root.className = 'lp';
  document.body.appendChild(root);
  panel.mountPartyPanel(root, { adapter: () => null });
});

describe('setPartyPanelDocked', () => {
  it('sort le panneau sur la page puis le remet dans le lecteur', () => {
    expect(panelOf().parentElement).toBe(root);
    panel.setPartyPanelDocked(true);
    expect(panelOf().parentElement).toBe(document.body);
    expect(panelOf().classList.contains('is-docked')).toBe(true);
    panel.setPartyPanelDocked(false);
    expect(panelOf().parentElement).toBe(root);
    expect(panelOf().classList.contains('is-docked')).toBe(false);
  });

  it('le panneau sorti reste interactif (fermeture par son bouton)', () => {
    panel.setPartyPanelDocked(true);
    panel.togglePartyPanel(true);
    expect(panel.isPartyPanelOpen()).toBe(true);
    const close = panelOf().querySelector('[data-wp-close]') as HTMLElement | null;
    expect(close).not.toBeNull();
    close!.click();
    expect(panel.isPartyPanelOpen()).toBe(false);
    panel.setPartyPanelDocked(false);
  });

  it('sans panneau monté : sans effet', () => {
    panel.unmountPartyPanel();
    expect(() => panel.setPartyPanelDocked(true)).not.toThrow();
  });
});
