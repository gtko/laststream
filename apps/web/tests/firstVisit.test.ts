// Première visite : une adresse de serveur suffit pour afficher l'écran de connexion (la config est générée après).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth, initAuth } from '../src/data/auth';

describe('première visite', () => {
  beforeEach(() => { localStorage.clear(); reloadSettings(); });

  it('serveur connu mais config vide, sans session : écran de connexion', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
    reloadSettings();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })));
    expect(await initAuth()).toBe('needs-login');
    expect(auth.status).toBe('needs-login');
    vi.unstubAllGlobals();
  });
});
