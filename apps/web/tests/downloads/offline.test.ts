import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MemoryDownloadIndex } from '../../src/downloads';
import { extensionOf, findDownloaded, findOfflineSource, type OfflineDeps, type OfflineProviders } from '../../src/downloads/offline';
import { downloadId, type DownloadItem } from '../../src/downloads/types';

const item = (over: Partial<DownloadItem> = {}): DownloadItem => ({
  id: 'movie:1',
  metaId: 'movie:1',
  title: 'Film',
  source: { copies: [], quality: '1080p' },
  state: 'done',
  bytesDone: 1000,
  bytesTotal: 1000,
  filename: 'Film.2024.1080p.MKV',
  attempts: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

async function deps(items: DownloadItem[], providers: OfflineProviders): Promise<OfflineDeps & { revoked: string[] }> {
  const index = new MemoryDownloadIndex();
  for (const i of items) await index.put(i);
  const revoked: string[] = [];
  return { index, providers, createObjectURL: () => 'blob:local/1', revokeObjectURL: (u) => revoked.push(u), revoked };
}

describe('lecture hors ligne : source locale', () => {
  it('extension du nom de fichier', () => {
    expect(extensionOf('A.B.MKV')).toBe('mkv');
    expect(extensionOf('film.mp4?x=1#t')).toBe('mp4');
    expect(extensionOf('film')).toBe('');
  });

  it('ne retient que le téléchargement terminé du bon titre ou épisode', async () => {
    const d = await deps([item(), item({ id: 'tv:2:1:3', metaId: 'tv:2', season: 1, episode: 3 }), item({ id: 'movie:9', state: 'running' })], {});
    expect((await findDownloaded(d.index, { key: 'movie:1' }))?.id).toBe('movie:1');
    expect(await findDownloaded(d.index, { key: 'movie:9' })).toBeNull();
    expect(downloadId('tv:2', 1, 3)).toBe('tv:2:1:3');
    expect((await findDownloaded(d.index, { key: 'tv:2', season: 1, episode: 3 }))?.id).toBe('tv:2:1:3');
    expect(await findDownloaded(d.index, { key: 'tv:2', season: 1, episode: 4 })).toBeNull();
    expect(await findDownloaded(d.index, { key: 'tv:2', season: null, episode: null })).toBeNull();
  });

  it('web : URL d’objet du fichier, libérée une seule fois', async () => {
    const blob = vi.fn(async () => new Blob(['x']));
    const d = await deps([item()], { blob });
    const src = await findOfflineSource(d, 'web', { key: 'movie:1' });
    expect(src).toMatchObject({ url: 'blob:local/1', container: 'mkv', quality: '1080p', size: 1000, platform: 'web' });
    expect(blob).toHaveBeenCalledWith('movie:1', 'video/x-matroska', 1000);
    src?.release();
    src?.release();
    expect(d.revoked).toEqual(['blob:local/1']);
  });

  it('web : fichier absent du magasin → null', async () => {
    const d = await deps([item()], { blob: async () => null });
    expect(await findOfflineSource(d, 'web', { key: 'movie:1' })).toBeNull();
  });

  it('Android : URI file:// du plugin natif', async () => {
    const d = await deps([item({ filename: 'a.mp4' })], { android: async () => ({ path: '/data/x.bin', uri: 'file:///data/x.bin' }) });
    const src = await findOfflineSource(d, 'android', { key: 'movie:1' });
    expect(src).toMatchObject({ url: 'file:///data/x.bin', container: 'mp4', platform: 'android' });
  });

  it('Windows : chemin fourni par la coque ; sans adaptateur → null', async () => {
    const d = await deps([item()], { shell: async () => 'C:\\Laststream\\movie.mkv' });
    expect((await findOfflineSource(d, 'shell', { key: 'movie:1' }))?.url).toBe('C:\\Laststream\\movie.mkv');
    const none = await deps([item()], {});
    expect(await findOfflineSource(none, 'shell', { key: 'movie:1' })).toBeNull();
  });

  it('une erreur du magasin ne lève pas : pas de copie locale', async () => {
    const d = await deps([item()], { blob: async () => { throw new Error('boom'); } });
    expect(await findOfflineSource(d, 'web', { key: 'movie:1' })).toBeNull();
  });

  it('un index en erreur ne lève pas', async () => {
    const index = { all: async () => { throw new Error('idb'); }, put: async () => undefined, delete: async () => undefined };
    expect(await findOfflineSource({ index, providers: {} }, 'web', { key: 'movie:1' })).toBeNull();
  });

  it('le conteneur déclaré prime sur l’extension', async () => {
    const d = await deps([item({ container: 'webm' })], { blob: async () => new Blob(['x']) });
    expect((await findOfflineSource(d, 'web', { key: 'movie:1' }))?.container).toBe('webm');
  });
});

describe('lecture hors ligne : aucune requête réseau', () => {
  it('les modules de lecture locale n’appellent ni fetch ni le serveur de streaming', () => {
    for (const file of ['src/downloads/offline.ts', 'src/player/offlinePlay.ts']) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/fetch\(|XMLHttpRequest|player\/server|sources\/debrid/);
    }
  });
});
