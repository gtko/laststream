// Accueil après enregistrement des réglages : la carte « lastAddon n’est pas configuré » ne reste pas jusqu'au rechargement.
// Jsdom, aucun réseau réel : le catalogue répond 404, on vérifie seulement que l'accueil se recharge et se redessine.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const NOT_CONFIGURED = 'n’est pas configuré';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let config: typeof import('../src/data/config');
let state: typeof import('../src/ui/state.js').state;
let home: typeof import('../src/ui/home.js');
const calls: string[] = [];
const app = () => document.getElementById('app')!;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return json({ error: 'not_found' }, 404);
  }));
  config = await import('../src/data/config');
  ({ state } = await import('../src/ui/state.js'));
  home = await import('../src/ui/home.js');
});

beforeEach(() => {
  localStorage.clear();
  config.reloadSettings();
  calls.length = 0;
  state.inDetail = false;
  state.status = 'error';
  app().hidden = false;
  app().innerHTML = '';
});

describe('accueil après enregistrement des réglages', () => {
  it('sans configuration la carte reste ; dès qu’une configuration complète est enregistrée, l’accueil recharge le catalogue', async () => {
    home.renderHome();
    expect(app().textContent).toContain(NOT_CONFIGURED);

    // Adresse seule : toujours non configuré (il manque la configuration chiffrée), rien ne se recharge.
    config.saveSettings({ base: 'http://localhost:7000' });
    expect(calls).toHaveLength(0);
    expect(app().textContent).toContain(NOT_CONFIGURED);

    // Configuration enregistrée (comme « Enregistrer » dans les réglages) : l'accueil repart du catalogue, sans rechargement.
    config.saveSettings({ config: 'CFG' });
    expect(app().textContent).not.toContain(NOT_CONFIGURED);
    await vi.waitFor(() => expect(calls.some((u) => u.includes('/CFG/lt/'))).toBe(true));
    await vi.waitFor(() => expect(state.status).toBe('error'));
    expect(app().textContent).not.toContain(NOT_CONFIGURED);
  });

  it('un accueil déjà chargé n’est pas rechargé par un enregistrement', async () => {
    config.saveSettings({ base: 'http://localhost:7000', config: 'CFG' });
    state.status = 'ready';
    config.saveSettings({ config: 'CFG2' });
    expect(calls).toHaveLength(0);
    expect(state.status).toBe('ready');
  });
});
