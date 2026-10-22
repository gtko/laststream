// Profil enfant : la route #/downloads n'existe pas et aucun bouton de téléchargement n'est dessiné (ODY-204).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/auth')>();
  return { ...real, isKidProfile: () => true };
});
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
});

describe('profil enfant', () => {
  it('#/downloads n’est pas une route', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    location.hash = '#/downloads';
    expect(parseRoute()).toBeNull();
    location.hash = '';
  });

  it('ni bouton de fiche, ni pastille d’épisode, ni entrée de navigation', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    const m = { key: 'movie:1', type: 'movie', id: 1, name: 'X' };
    expect(ui.ficheDownloadHTML(m, null, '')).toBe('');
    expect(ui.episodeDownloadHTML({ ...m, key: 'tv:1', type: 'tv' }, 1, 1, '')).toBe('');
    expect(ui.downloadsNavHTML()).toBe('');
    expect(ui.libraryDownloadsCardHTML()).toBe('');
  });
});
