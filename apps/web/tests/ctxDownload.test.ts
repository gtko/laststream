// Menus contextuels : « Télécharger » n'est plus caché (ODY-238), astuce unique au premier usage.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ avail: { ok: true } as { ok: boolean }, kid: false }));

vi.mock('../src/downloads/service', () => ({
  platformAvailability: () => h.avail,
  downloadIdFor: (t: { key: string }) => t.key,
  getDownloads: vi.fn(() => Promise.resolve(null)),
  listSourceChoices: vi.fn(() => Promise.resolve([])),
  recommendedChoice: () => null,
  requestDownload: vi.fn(),
  subscribeDownloads: vi.fn(() => () => undefined),
  listDownloads: () => [],
  getSpace: vi.fn(() => Promise.resolve({ used: 0, limit: null, ratio: 0, warn: false, full: false })),
}));
vi.mock('../src/data/auth', async (orig) => ({ ...(await orig<typeof import('../src/data/auth')>()), isKidProfile: () => h.kid }));

let ctx: typeof import('../src/ui/ctxmenu.js');
let stateMod: typeof import('../src/ui/state.js');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  stateMod = await import('../src/ui/state.js');
  (stateMod.state as any).byKey.set('movie:5', { key: 'movie:5', id: 5, name: 'Alien', type: 'movie' });
  (stateMod.state as any).byKey.set('tv:9', { key: 'tv:9', id: 9, name: 'Nuits', type: 'tv' });
});

beforeEach(() => { h.avail = { ok: true }; h.kid = false; localStorage.clear(); });
afterEach(() => ctx.closeCtx(false));

const ids = (t: object) => ctx.ctxItems(t as never).map((i: { id: string }) => i.id);
const movieT = { kind: 'title', key: 'movie:5', el: document.body };
const epT = { kind: 'episode', model: { key: 'tv:9', id: 9, name: 'Nuits' }, season: 1, episode: 2, el: document.body };

describe('« Télécharger » dans les menus', () => {
  it('film et épisode : l’entrée est visible', () => {
    expect(ids(movieT)).toContain('download');
    expect(ids(epT)).toContain('download');
  });
  it('absente sur un profil enfant, sur un appareil incompatible et pour une série entière', () => {
    h.kid = true;
    expect(ids(movieT)).not.toContain('download');
    h.kid = false;
    h.avail = { ok: false };
    expect(ids(epT)).not.toContain('download');
    h.avail = { ok: true };
    expect(ids({ kind: 'title', key: 'tv:9', el: document.body })).not.toContain('download');
  });
});

describe('astuce du premier usage', () => {
  it('affichée une seule fois', () => {
    ctx.openCtx(movieT as never, 10, 10);
    expect(document.querySelector('.ctxmenu .ctx-hint')).not.toBeNull();
    ctx.closeCtx(false);
    ctx.openCtx(movieT as never, 10, 10);
    expect(document.querySelector('.ctxmenu .ctx-hint')).toBeNull();
  });
});
