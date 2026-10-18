// Profil enfant : la page #/hidden n'est ni routée ni dessinée (comme les réglages).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/auth')>();
  return { ...real, isKidProfile: () => true };
});

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
});

describe('profil enfant', () => {
  it('#/hidden n’est pas une route', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    location.hash = '#/hidden';
    expect(parseRoute()).toBeNull();
  });

  it('la page ne dessine rien', async () => {
    const { showHidden } = await import('../src/ui/hidden.js');
    const detail = document.getElementById('detail')!;
    detail.innerHTML = '';
    showHidden();
    expect(detail.innerHTML).toBe('');
  });
});
