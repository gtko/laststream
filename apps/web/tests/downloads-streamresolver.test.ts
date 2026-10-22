// Résolution du lien d'un téléchargement (ODY-204) : référence du flux, appariement, HLS, erreurs sans URL.
// Les sources du titre et le débrideur sont injectés : aucun réseau.
import { describe, expect, it, vi } from 'vitest';
import type { DebridManager } from '../src/sources/debridClient';
import type { SourceView } from '../src/sources/info';
import type { SourceRequest } from '../src/sources/load';
import { createStreamResolver, findMatch, isDirectHttpLink, isDownloadable, isHlsUrl, streamToSource } from '../src/downloads/streamResolver';
import { DownloadError, type DownloadSource } from '../src/downloads/types';
import { HLS_URL, HTTP_URL, clientStream, httpStream, viewOf } from './downloads-fixtures';

const MOVIE = { key: 'movie:693134', type: 'movie' as const, id: '693134', name: 'Dune' };
const EPISODE = { key: 'tv:1399', type: 'tv' as const, id: '1399', name: 'Série', season: 1, episode: 3 };

// Débrideur de l'appareil : aucun configuré par défaut (`wipeDeviceDebrid`), un test peut le déclarer configuré.
const device = vi.hoisted(() => ({ hasAny: false }));

vi.mock('../src/sources/debridClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/debridClient')>();
  return { ...actual, debrid: () => ({ hasAny: () => device.hasAny }) as unknown as ReturnType<typeof actual.debrid> };
});

const signal = (): AbortSignal => new AbortController().signal;

describe('streamToSource : une référence, jamais une URL', () => {
  it('ne contient ni le lien ni la clé du débrideur', () => {
    const src = streamToSource(viewOf(httpStream({ origin: 'Lumio', filename: 'Dune.2021.1080p.mkv', size: 2_400_000_000 })), MOVIE);
    const json = JSON.stringify(src);
    expect(json).not.toContain('http');
    expect(json).not.toContain('apikey');
    expect(json).not.toContain('cle-secrete');
    expect(src.copies).toEqual([]);
    expect(src.ref).toEqual({
      type: 'movie',
      id: '693134',
      name: 'Dune',
      key: 'movie:693134',
      match: { filename: 'Dune.2021.1080p.mkv', size: 2_400_000_000, addon: 'Lumio' },
    });
  });

  it('une série porte la saison et l’épisode', () => {
    const src = streamToSource(viewOf(httpStream({ filename: 'x.mkv' })), EPISODE);
    expect(src.episode).toEqual({ season: 1, episode: 3 });
    expect(src.ref).toMatchObject({ type: 'tv', key: 'tv:1399', season: 1, episode: 3 });
  });

  it('un torrent sans lien garde ses copies (hash, pas d’URL)', () => {
    const src = streamToSource(viewOf(clientStream('a'.repeat(40))), MOVIE);
    expect(src.copies).toEqual([{ infoHash: 'a'.repeat(40) }]);
    expect(JSON.stringify(src)).not.toContain('http');
  });

  it('l’infoHash de la référence est en minuscules', () => {
    const src = streamToSource(viewOf(httpStream({ infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', fileIdx: 2 })), MOVIE);
    expect(src.ref?.match).toMatchObject({ infoHash: 'abcdef0123456789abcdef0123456789abcdef01', fileIdx: 2 });
  });
});

describe('flux téléchargeable', () => {
  it('une playlist HLS n’est pas téléchargeable ; un lien HTTPS vers un nom public l’est', () => {
    expect(isHlsUrl(HLS_URL)).toBe(true);
    expect(isHlsUrl(HTTP_URL)).toBe(false);
    expect(isHlsUrl('https://media.example.test/m3u8-video.mkv')).toBe(false);
    expect(isDownloadable(viewOf(httpStream({ url: HLS_URL })))).toBe(false);
    expect(isDownloadable(viewOf(httpStream()))).toBe(true);
  });

  it('torrent sans lien : téléchargeable seulement quand un débrideur est configuré sur l’appareil', () => {
    device.hasAny = false;
    expect(isDownloadable(viewOf(clientStream('b'.repeat(40))))).toBe(false);
    device.hasAny = true;
    try {
      expect(isDownloadable(viewOf(clientStream('b'.repeat(40))))).toBe(true);
    } finally {
      device.hasAny = false;
    }
  });

  it('web : http://, adresse IP, localhost, nom sans point et IPv6 locale sont exclus', () => {
    for (const url of [
      'http://media.example.test/films/dune.mkv',
      'https://192.168.1.20/films/dune.mkv',
      'https://localhost:8080/films/dune.mkv',
      'https://nas/films/dune.mkv',
      'https://[::1]/films/dune.mkv',
    ]) {
      expect(isDownloadable(viewOf(httpStream({ url })))).toBe(false);
    }
  });

  it('transfert natif : la politique de la plateforme (http(s) direct) est celle qui s’applique', () => {
    const lan = viewOf(httpStream({ url: 'http://192.168.1.20/films/dune.mkv' }));
    expect(isDownloadable(lan, isDirectHttpLink)).toBe(true);
  });
});

describe('findMatch : ordre de confiance et tolérance', () => {
  it('l’infoHash (et le fichier) passe avant le nom de fichier', () => {
    const a = viewOf(httpStream({ infoHash: 'c'.repeat(40), fileIdx: 1, filename: 'a.mkv' }), 0);
    const b = viewOf(httpStream({ filename: 'b.mkv' }), 1);
    expect(findMatch([b, a], { infoHash: 'c'.repeat(40), fileIdx: 1, filename: 'b.mkv' })).toBe(a);
  });

  it('le nom de fichier ignore la casse ; la taille tolère 1 % mais pas 10 %', () => {
    const v = viewOf(httpStream({ filename: 'Dune.mkv', size: 1_000_000 }));
    expect(findMatch([v], { filename: 'DUNE.MKV', size: 1_005_000 })).toBe(v);
    expect(findMatch([v], { filename: 'Dune.mkv', size: 1_100_000 })).toBeUndefined();
  });

  it('l’addon et la taille apparient aussi (dernier repli)', () => {
    const v = viewOf(httpStream({ origin: 'Lumio', size: 500 }));
    expect(findMatch([v], { addon: 'lumio', size: 500 })).toBe(v);
    expect(findMatch([v], { addon: 'Torrentio', size: 500 })).toBeUndefined();
  });

  it('une référence sans aucun indice ne retrouve rien', () => {
    expect(findMatch([viewOf(httpStream({ filename: 'a.mkv' }))], {})).toBeUndefined();
  });
});

describe('createStreamResolver : lien retrouvé par la référence', () => {
  it('recharge les sources du titre et rend le lien du flux correspondant', async () => {
    const hls = viewOf(httpStream({ url: HLS_URL, filename: 'Dune.mkv', size: 2_400_000_000 }), 0);
    const hit = viewOf(httpStream({ filename: 'Dune.mkv', size: 2_400_000_000 }), 1);
    const refresh = vi.fn(async (_req: SourceRequest) => ({ views: [hls, hit] as SourceView[] }));
    const resolver = createStreamResolver({ refresh });
    const got = await resolver.resolve(streamToSource(hit, MOVIE), signal());
    expect(got).toEqual({ url: HTTP_URL, size: 2_400_000_000, filename: 'Dune.mkv' });
    expect(refresh).toHaveBeenCalledWith({ type: 'movie', id: '693134', name: 'Dune', key: 'movie:693134', season: null, episode: null });
  });

  it('un titre de série demande le bon épisode', async () => {
    const hit = viewOf(httpStream({ filename: 'S01E03.mkv' }));
    const refresh = vi.fn(async (_req: SourceRequest) => ({ views: [hit] as SourceView[] }));
    const resolver = createStreamResolver({ refresh });
    await resolver.resolve(streamToSource(hit, EPISODE), signal());
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ key: 'tv:1399', season: 1, episode: 3 }));
  });

  it('aucun flux ne correspond : erreur « content », définitive, sans URL', async () => {
    const other = viewOf(httpStream({ filename: 'autre.mkv' }));
    const resolver = createStreamResolver({ refresh: async () => ({ views: [other] }) });
    const err = await resolver.resolve(streamToSource(viewOf(httpStream({ filename: 'Dune.mkv' })), MOVIE), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe('content');
    expect((err as DownloadError).retryable).toBe(false);
    expect((err as Error).message).not.toContain('http');
  });

  it('une playlist HLS portant le même nom est ignorée : erreur « content », jamais de lien HLS', async () => {
    const hls = viewOf(httpStream({ url: HLS_URL, filename: 'Dune.mkv' }));
    const resolver = createStreamResolver({ refresh: async () => ({ views: [hls] }) });
    const src = streamToSource(viewOf(httpStream({ filename: 'Dune.mkv' })), MOVIE);
    await expect(resolver.resolve(src, signal())).rejects.toMatchObject({ code: 'content', retryable: false });
  });

  it('un échec de rechargement est une erreur réseau réessayable, sans le message d’origine', async () => {
    const resolver = createStreamResolver({ refresh: async () => { throw new Error(`échec sur ${HTTP_URL}`); } });
    const err = await resolver.resolve(streamToSource(viewOf(httpStream({ filename: 'Dune.mkv' })), MOVIE), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe('network');
    expect((err as DownloadError).retryable).toBe(true);
    expect((err as Error).message).toBe('network');
  });

  it('annulé pendant le rechargement : aucun lien rendu', async () => {
    const ctl = new AbortController();
    const hit = viewOf(httpStream({ filename: 'Dune.mkv' }));
    const resolver = createStreamResolver({ refresh: async () => { ctl.abort(); return { views: [hit] }; } });
    await expect(resolver.resolve(streamToSource(hit, MOVIE), ctl.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('un lien hors de la politique web (http, IP) n’est jamais rendu, même retrouvé par la référence', async () => {
    const hit = viewOf(httpStream({ url: 'http://192.168.1.20/films/Dune.mkv', filename: 'Dune.mkv' }));
    const resolver = createStreamResolver({ refresh: async () => ({ views: [hit] }) });
    const err = await resolver.resolve(streamToSource(hit, MOVIE), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe('content');
    expect((err as Error).message).not.toContain('192.168');
  });

  it('avec la politique native, le même lien http est accepté', async () => {
    const hit = viewOf(httpStream({ url: 'http://192.168.1.20/films/Dune.mkv', filename: 'Dune.mkv' }));
    const resolver = createStreamResolver({ refresh: async () => ({ views: [hit] }), linkPolicy: isDirectHttpLink });
    await expect(resolver.resolve(streamToSource(hit, MOVIE), signal())).resolves.toMatchObject({ url: 'http://192.168.1.20/films/Dune.mkv' });
  });

  it('sans copies ni référence : erreur « content »', async () => {
    const resolver = createStreamResolver({ refresh: async () => ({ views: [] }) });
    const none: DownloadSource = { copies: [] };
    await expect(resolver.resolve(none, signal())).rejects.toMatchObject({ code: 'content', retryable: false });
  });
});

describe('createStreamResolver : copies débridées sur l’appareil', () => {
  it('les copies passent au débrideur (inchangé) et la référence n’est pas rechargée', async () => {
    const resolve = vi.fn(async (..._args: unknown[]) => ({ url: 'https://dl.example.test/file.mkv', size: 10, filename: 'file.mkv' }));
    const refresh = vi.fn(async (_req: SourceRequest) => ({ views: [] as SourceView[] }));
    const resolver = createStreamResolver({ debrid: () => ({ resolve }) as unknown as Pick<DebridManager, 'resolve'>, refresh });
    const src: DownloadSource = { ...streamToSource(viewOf(httpStream({ filename: 'x.mkv' })), EPISODE), copies: [{ infoHash: 'd'.repeat(40) }] };
    const s = signal();
    const got = await resolver.resolve(src, s);
    expect(got).toEqual({ url: 'https://dl.example.test/file.mkv', size: 10, filename: 'file.mkv' });
    expect(resolve).toHaveBeenCalledWith([{ infoHash: 'd'.repeat(40) }], { season: 1, episode: 3 }, s, { skipShared: true, skipPublish: true });
    expect(refresh).not.toHaveBeenCalled();
  });
});
