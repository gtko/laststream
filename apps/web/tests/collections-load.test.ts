// Catalogue de collections : le JSON Focale est servi comme asset (fetch de l'URL émise par Vite), hors des chunks JS.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import focaleUrl from '../src/data/collections/focale.json?url';

const FILE = path.join(__dirname, '..', 'src', 'data', 'collections', 'focale.json');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('loadCatalog', () => {
  it('télécharge le JSON servi comme asset et bâtit le catalogue', async () => {
    const body = fs.readFileSync(FILE, 'utf8');
    const fetchMock = vi.fn(async (_url: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadCatalog, buildCatalog } = await import('../src/data/collections/catalog');
    const cat = await loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(focaleUrl);
    expect(cat.categories.length).toBeGreaterThan(0);
    expect(cat.categories).toEqual(buildCatalog(JSON.parse(body)).categories);
  });

  it('un échec HTTP rejette la promesse, et l’appel suivant réessaie', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('erreur', { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response('erreur', { status: 500 }));
    fetchMock.mockResolvedValueOnce(new Response(fs.readFileSync(FILE, 'utf8'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadCatalog } = await import('../src/data/collections/catalog');
    await expect(loadCatalog()).rejects.toThrow();
    const cat = await loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cat.categories.length).toBeGreaterThan(0);
  });
});
