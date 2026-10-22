// Pages du menu principal : Séries, Films, Documentaires (routes, rangées, profil enfant, rendu).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { HUBS, rowById } from '../src/data/rows';
import { state } from '../src/ui/state.js';

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
});

afterEach(() => {
  auth.status = 'local';
  auth.profile = null as unknown as typeof auth.profile;
  vi.restoreAllMocks();
});

describe('rangées des pages du menu principal', () => {
  it('chaque rangée citée existe, sans doublon dans une page', () => {
    for (const hub of Object.values(HUBS)) {
      expect(new Set(hub.rows).size).toBe(hub.rows.length);
      hub.rows.forEach((id) => expect(rowById(id), id).toBeDefined());
    }
  });

  it('Films : rangées de films ; Séries : rangées de séries ; Documentaires : genre documentaire (99)', () => {
    const ctx = { region: 'FR', today: '2026-10-22', month: 10, kidMaxAge: null };
    const typeOf = (id: string) => {
      const f = rowById(id)!.fetch;
      return f.k === 'discover' || f.k === 'top10' ? f.type : f.k === 'list' ? f.path.split('/')[0] : '';
    };
    HUBS.films.rows.forEach((id) => expect(typeOf(id), id).toBe('movie'));
    HUBS.series.rows.forEach((id) => expect(typeOf(id), id).toBe('tv'));
    HUBS.documentaires.rows.forEach((id) => {
      const f = rowById(id)!.fetch;
      expect(f.k, id).toBe('discover');
      if (f.k === 'discover') expect(f.params(ctx).with_genres, id).toMatch(/^99\b/);
    });
  });
});

describe('routes', () => {
  it('#/films, #/series et #/documentaires sont des pages ; Services reste une route (ancien lien)', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    for (const id of ['films', 'series', 'documentaires']) {
      location.hash = '#/' + id;
      expect(parseRoute()).toEqual({ kind: 'hub', id });
    }
    location.hash = '#/services';
    expect(parseRoute()).toEqual({ kind: 'services' });
  });

  it('un profil enfant n’a pas ces pages', async () => {
    auth.status = 'ready';
    auth.profile = { id: 'k1', name: 'Léo', avatarColor: '', isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' } as unknown as typeof auth.profile;
    const { parseRoute } = await import('../src/ui/router.js');
    for (const id of ['films', 'series', 'documentaires']) {
      location.hash = '#/' + id;
      expect(parseRoute()).toBeNull();
    }
  });
});

describe('page', () => {
  it('affiche le titre, la barre avec l’entrée soulignée et les rangées chargées', async () => {
    const registry = await import('../src/ui/registry.js');
    vi.spyOn(registry, 'loadHubRows').mockImplementation(async (_ids: string[], slot: HTMLElement) => {
      slot.innerHTML = '<section class="row-section" id="docs"><h2>Documentaires</h2></section>';
      return 1;
    });
    const { showHub } = await import('../src/ui/hubs.js');
    document.getElementById('detail')!.hidden = false; // page ouverte : le routeur affiche le détail
    await showHub('documentaires');
    const detail = document.getElementById('detail')!;
    expect(detail.querySelector('h1')!.textContent).toBe('Documentaires');
    expect(document.title).toContain('Documentaires');
    expect(detail.querySelector('.topbar .nav > a.is-current')!.textContent).toBe('Documentaires');
    expect(detail.querySelector('#hub-rows #docs')).not.toBeNull();
    expect(detail.querySelector('.hub-sk')).toBeNull(); // le squelette disparaît une fois chargé
  });

  it('le logo ramène à l’accueil depuis une page, même après plusieurs navigations', async () => {
    await import('../src/ui/events.js');
    const { showHub } = await import('../src/ui/hubs.js');
    document.getElementById('detail')!.hidden = false;
    await showHub('series');
    state.inDetail = true;
    state.depth = 1;
    location.hash = '#/films';
    document.querySelector<HTMLElement>('#detail .brand')!.click();
    expect(location.hash).toBe('#/');
  });
});
