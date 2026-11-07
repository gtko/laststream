// LAST-507 : la reconnexion redemande un lien neuf au débrideur de l'appareil (mémo et lien partagé ignorés) ;
// sans l'option `fresh`, la résolution reste celle d'avant.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ResolveArgs = [copies: unknown, episode: unknown, signal: unknown, options?: { skipShared?: boolean }];
const { resolve, recoverShared } = vi.hoisted(() => ({
  resolve: vi.fn(async (..._args: ResolveArgs) => ({ url: 'https://debrid.test/f.mkv', filename: 'f.mkv', size: 1, provider: 'alldebrid' })),
  recoverShared: vi.fn(async (..._args: ResolveArgs) => ({ url: 'https://debrid.test/g.mkv', filename: 'g.mkv', size: 1, provider: 'alldebrid' })),
}));

vi.mock('../src/sources/debridClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/debridClient')>()),
  debrid: () => ({ resolve, recoverShared }),
}));
vi.mock('../src/player/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/player/server')>()),
  serverAlive: async () => true,
  serverBase: () => 'http://localhost:7000',
}));

// Le module de lecture lit le DOM de l'interface au chargement : on monte le même squelette que les autres tests.
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { resolveMedia } = await import('../src/player/sessionPlay.js');

const H1 = 'a1'.repeat(20);
const view = {
  filename: 'f.mkv',
  stream: {
    behaviorHints: { lastDebrid: 'client' },
    infoHash: H1,
    laststream: { client: { copies: [{ infoHash: H1, fileIdx: 0 }], season: 1, episode: 2 } },
  },
};

describe('reconnexion : option fresh de resolveMedia', () => {
  beforeEach(() => {
    resolve.mockClear();
    recoverShared.mockClear();
  });

  it('sans option, la résolution passe par le mémo et le lien partagé (appel inchangé)', async () => {
    const signal = new AbortController().signal;
    const media = await resolveMedia(view, signal);
    expect(media.url).toBe('https://debrid.test/f.mkv');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[3]?.skipShared).toBeFalsy();
  });

  it('fresh : transmet skipShared à resolve, qui contourne le mémo de 1 h', async () => {
    const signal = new AbortController().signal;
    await resolveMedia(view, signal, false, { fresh: true });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[3]).toEqual({ skipShared: true });
  });

  it('le lien partagé en échec (local) reste géré par recoverShared, sans changement', async () => {
    const signal = new AbortController().signal;
    await resolveMedia(view, signal, true);
    expect(recoverShared).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
