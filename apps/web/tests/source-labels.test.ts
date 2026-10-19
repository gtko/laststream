import { describe, expect, it } from 'vitest';
import type { Stream } from '../src/data/stream';
import { isDebridLink, toSourceView, toSourceViews } from '../src/sources/info';
import { NO_FILTERS, applyFilters, recommendationReason } from '../src/sources/rank';
import { deviceAddonName, fetchDeviceStreams, normalizeDeviceResponse, normalizeDeviceStream, rememberAddonName } from '../src/sources/deviceFetch';
import type { HttpFn } from '../src/sources/debrid/http';

const HASH = 'b'.repeat(40);
const ARCHIVE = 'https://archive.org/download/film-1950/film-1950.mp4';
const laststream = (over: Record<string, unknown> = {}) => ({
  resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], score: 50, estBitrateKbps: 8000, ...over,
});
const withCache = (cached: boolean) => ({ cached });

describe('libellé « Débridé » réservé aux liens de débrideur', () => {
  it('un lien HTTP direct n’est jamais « Débridé · En cache », même si l’info cache est vraie', () => {
    const v = toSourceView({ url: ARCHIVE, name: 'Archive\n1080p', laststream: laststream({ ...withCache(true) }) } as Stream, 0);
    expect(v.status).toBe('direct');
    expect(v.statusLabel).toBe('Lien direct');
    expect(v.provider).toBe('');
  });

  it('un nom qui cite un débrideur ne suffit pas : lien HTTP direct = « Lien direct »', () => {
    const v = toSourceView({ url: ARCHIVE, description: 'via AllDebrid', laststream: laststream(withCache(true)) } as Stream, 0);
    expect(v.statusLabel).toBe('Lien direct');
  });

  it('un lien d’un débrideur connu (hôte ou /play de lastAddon) est « Débridé », et « En cache » seulement si la cache est connue', () => {
    const host = { url: 'https://dl.alldebrid.com/f/xyz/film.mkv', laststream: laststream(withCache(true)) } as Stream;
    expect(toSourceView(host, 0).statusLabel).toBe('Débridé · En cache ⚡');
    const play = { url: 'https://lastaddon.example.test/play/c/tok123', laststream: laststream(withCache(false)) } as Stream;
    expect(toSourceView(play, 0).statusLabel).toBe('Débridé · À la demande');
    const unknown = { url: 'https://lastaddon.example.test/play/' + HASH, laststream: laststream() } as Stream;
    expect(toSourceView(unknown, 0).status).toBe('uncached');
  });

  it('un addon qui signale le débrideur (laststream.provider) reste « Débridé »', () => {
    const v = toSourceView({ url: 'https://addon.example.test/x.mp4', laststream: laststream({ provider: 'TorBox', ...withCache(true) }) } as Stream, 0);
    expect(v.statusLabel).toBe('Débridé · En cache ⚡');
    expect(v.provider).toBe('TorBox');
  });

  it('isDebridLink : hôte connu, /play, torrent client ou signalé ; pas un simple lien HTTP', () => {
    expect(isDebridLink({ url: 'https://x.real-debrid.com/d/1' } as Stream, null)).toBe(true);
    expect(isDebridLink({ url: 'https://api.torbox.app/v1/file' } as Stream, null)).toBe(true);
    expect(isDebridLink({ url: 'https://evil-debrid.com/x' } as Stream, null)).toBe(false);
    expect(isDebridLink({ url: ARCHIVE } as Stream, null)).toBe(false);
    expect(isDebridLink({ infoHash: HASH, behaviorHints: { lastDebrid: 'client' } } as Stream, null)).toBe(true);
  });

  it('filtre « Cache uniquement » et phrase recommandée suivent le statut réel', () => {
    const direct = toSourceView({ url: ARCHIVE, laststream: laststream(withCache(true)) } as Stream, 0);
    const cached = toSourceView({ url: 'https://lastaddon.example.test/play/c/tok', laststream: laststream(withCache(true)) } as Stream, 1);
    const shown = applyFilters([direct, cached], { ...NO_FILTERS, cachedOnly: true });
    expect(shown.map((v) => v.index)).toEqual([1]);
    expect(recommendationReason(direct, null, 'fr', false)).not.toContain('déjà en cache');
    expect(recommendationReason(cached, null, 'fr', false)).toContain('déjà en cache');
  });
});

describe('flux récupérés par l’appareil (deviceFetch)', () => {
  it('un lien HTTP direct récupéré par l’appareil s’affiche « Lien direct », même avec une marque ⚡ absente', () => {
    const [v] = toSourceViews(normalizeDeviceResponse({ streams: [{ name: 'Archive\n1080p', url: ARCHIVE, behaviorHints: { filename: 'film-1950.mp4' } }] }, 'Addon amont'));
    expect(v.viaDevice).toBe(true);
    expect(v.status).toBe('direct');
    expect(v.statusLabel).toBe('Lien direct');
    expect(v.info?.cached).toBe(false);
  });

  it('une marque ⚡ sur un lien débridé de l’appareil reste « En cache »', () => {
    const [v] = toSourceViews(normalizeDeviceResponse({ streams: [{ name: '⚡ AllDebrid\n1080p', url: 'https://lastaddon.example.test/play/c/tok' }] }, 'Mur'));
    expect(v.statusLabel).toBe('Débridé · En cache ⚡');
  });

  it('nom d’addon : un nom explicite est gardé ; un nom générique devient le nom du manifest connu, sinon l’hôte', () => {
    expect(deviceAddonName({ addonId: 'Lumio', url: 'https://lumio.example.test/stream/movie/tt1.json' })).toBe('Lumio');
    expect(deviceAddonName({ addonId: 'Addon amont', url: 'https://addon.example.test/cfg/stream/movie/tt1.json' })).toBe('addon.example.test');
    rememberAddonName('https://manifest.example.test/cfg/manifest.json', 'Mon Addon');
    expect(deviceAddonName({ addonId: 'Addon amont', url: 'https://manifest.example.test/cfg/stream/series/tt1:1:2.json' })).toBe('Mon Addon');
    rememberAddonName('https://manifest.example.test/cfg/manifest.json', 'Addon amont');
    expect(deviceAddonName({ addonId: 'Addon amont', url: 'https://manifest.example.test/cfg/stream/movie/tt1.json' })).toBe('Mon Addon');
  });

  it('les flux de l’appareil portent le vrai nom de leur addon (origine et file d’attente)', async () => {
    rememberAddonName('https://named.example.test/manifest.json', 'Archive Stremio');
    const http: HttpFn = async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ streams: [{ name: 'Archive\n1080p', url: ARCHIVE }] })) });
    const got: Array<{ name: string; origin: string | undefined }> = [];
    await fetchDeviceStreams([{ addonId: 'Addon amont', url: 'https://named.example.test/stream/movie/tt1.json' }], {
      http,
      onAddon: (t, streams) => {
        const origins = (streams[0]?.laststream as { origins?: Array<{ name: string }> } | undefined)?.origins;
        got.push({ name: t.addonId, origin: origins?.[0]?.name });
      },
    });
    expect(got).toEqual([{ name: 'Addon amont', origin: 'Archive Stremio' }]);
  });

  it('normalizeDeviceStream : l’origine reprend le nom fourni, pas un nom générique', () => {
    const s = normalizeDeviceStream({ name: 'Archive\n1080p', url: ARCHIVE }, 'archive.org');
    expect(s?.laststream).toMatchObject({ cached: false, origins: [{ kind: 'addon', name: 'archive.org' }] });
  });
});
