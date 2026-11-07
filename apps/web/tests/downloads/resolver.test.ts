// @vitest-environment node
// Résolveur de lien : pont vers le gestionnaire de débrideurs (simulé ici) ; seuls les appels et la forme du résultat sont vérifiés.
import { describe, expect, it, vi } from 'vitest';
import { debridLinkResolver } from '../../src/downloads/resolver';
import type { DownloadSource } from '../../src/downloads/types';
import { DebridError } from '../../src/sources/debrid/types';
import type { DebridManager } from '../../src/sources/debridClient';

const copies = [{ infoHash: 'a'.repeat(40), fileIdx: 2, filename: 'film.mkv', size: 42 }];
const SRC: DownloadSource = { copies, episode: { season: 1, episode: 3 } };

/** Gestionnaire de débrideurs simulé : seule la méthode `resolve` est utilisée. */
function fakeDm(impl: () => Promise<unknown>) {
  const resolve = vi.fn(impl);
  return { resolve } as unknown as Pick<DebridManager, 'resolve'> & { resolve: typeof resolve };
}

describe('debridLinkResolver', () => {
  it('appelle resolve avec les copies, l’épisode, le signal, et sans lien partagé ni publication', async () => {
    const dm = fakeDm(async () => ({ url: 'https://h.example.test/f.mkv', size: 42, filename: 'film.mkv', provider: 'alldebrid' }));
    const ctl = new AbortController();
    await debridLinkResolver(dm).resolve(SRC, ctl.signal);
    expect(dm.resolve).toHaveBeenCalledTimes(1);
    expect(dm.resolve).toHaveBeenCalledWith(copies, { season: 1, episode: 3 }, ctl.signal, { skipShared: true, skipPublish: true });
  });

  it('renvoie url, taille et nom de fichier, sans le fournisseur', async () => {
    const dm = fakeDm(async () => ({ url: 'https://h.example.test/f.mkv?apikey=SECRET', size: 42, filename: 'film.mkv', provider: 'torbox' }));
    const out = await debridLinkResolver(dm).resolve(SRC, new AbortController().signal);
    expect(out).toEqual({ url: 'https://h.example.test/f.mkv?apikey=SECRET', size: 42, filename: 'film.mkv' });
  });

  it('sans épisode, transmet un objet vide', async () => {
    const dm = fakeDm(async () => ({ url: 'https://h.example.test/f.mkv', size: 1, filename: 'f.mkv' }));
    await debridLinkResolver(dm).resolve({ copies }, new AbortController().signal);
    expect((dm.resolve.mock.calls[0] as unknown[])[1]).toEqual({});
  });

  it('remonte telle quelle une DebridError du gestionnaire', async () => {
    const err = new DebridError('all_unavailable', 'account');
    const dm = fakeDm(async () => {
      throw err;
    });
    await expect(debridLinkResolver(dm).resolve(SRC, new AbortController().signal)).rejects.toBe(err);
  });
});
