import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { chooseEngine } from '../src/player/engine';
import { failoverOrder, pickRaceCandidate } from '../src/player/failover';
import * as server from '../src/player/server';
import { isDebridUrl, playableStreams, toSourceView, toSourceViews } from '../src/sources/info';
import { clearSourceCache, loadSources, type SourceRequest } from '../src/sources/load';
import { recommend } from '../src/sources/rank';
import type { Stream } from '../src/data/stream';

/* Politique « tout passe par un débrideur » : aucune lecture ne passe par le moteur torrent (P2P). Une source n'est lisible
 * que par un lien HTTP(S) (débridé par lastAddon via AllDebrid, ou lien direct d'un addon). */

const HASH = 'ab'.repeat(20);
const info = (extra: Record<string, unknown> = {}) => ({
  resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: false, score: 50, estBitrateKbps: 5000, ...extra,
});
const debrided = (n: number, cached = false) => ({ url: 'https://addon.test/CFG/play/c/tok' + n, laststream: info({ cached, score: 40 + n }) });
const direct = (n: number) => ({ url: 'https://cdn.test/film' + n + '.mp4', laststream: info({ score: 10 + n }) });
const torrentOnly = (n: number) => ({ infoHash: HASH.slice(0, 38) + String(10 + n), fileIdx: 1, sources: ['tracker:udp://t.example:80'], laststream: info({ score: 90 + n }) });

const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };

function fakeAddon(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings();
  clearCache();
  clearSourceCache();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('politique débrideur : filtrage des sources', () => {
  it('un infoHash sans lien HTTP(S) est masqué ; les liens débridés et directs sont gardés', () => {
    const kept = playableStreams<Stream>([torrentOnly(1), debrided(1), direct(1), { url: 'magnet:?xt=urn:btih:' + HASH }, { url: '//cdn.test/x.mp4' }, {}]);
    expect(kept).toHaveLength(2);
    expect(kept.every((s) => /^https:\/\//.test(String(s.url)))).toBe(true);
  });

  it('un torrent seul n est jamais lisible, même avec un infoHash valide', () => {
    const v = toSourceView(torrentOnly(1), 0);
    expect(v.playable).toBe(false);
    expect(toSourceView(debrided(1), 0).playable).toBe(true);
    expect(toSourceView(direct(1), 0).playable).toBe(true);
  });

  it('loadSources ne renvoie jamais de source à infoHash seul', async () => {
    fakeAddon({ streams: [torrentOnly(1), torrentOnly(2), debrided(1, true), direct(1)] });
    const r = await loadSources(REQ);
    expect(r.views).toHaveLength(2);
    expect(r.views.some((v) => typeof v.stream.infoHash === 'string')).toBe(false);
    expect(r.views.every((v) => v.playable)).toBe(true);
  });

  it('sans débrideur côté serveur : torrents absents, lien HTTP direct conservé, message du serveur remonté', async () => {
    fakeAddon({ streams: [direct(1)], notice: 'Configure AllDebrid : les sources torrent ne sont lues que via un débrideur.' });
    const r = await loadSources(REQ);
    expect(r.views).toHaveLength(1);
    expect(r.views[0].status).toBe('direct');
    expect(r.notice).toContain('Configure AllDebrid');
  });

  it('uniquement des torrents (aucune clé AllDebrid) : liste vide, jamais de lecture P2P', async () => {
    fakeAddon({ streams: [torrentOnly(1), torrentOnly(2)], notice: 'Configure AllDebrid' });
    const r = await loadSources(REQ);
    expect(r.views).toEqual([]);
    expect(recommend(r.views, null)).toBeNull();
  });
});

describe('politique débrideur : libellés FR', () => {
  it('« Débridé · En cache ⚡ », « Débridé · À la demande » et « Lien direct »', () => {
    const cached = toSourceView(debrided(1, true), 0);
    const uncached = toSourceView(debrided(2, false), 0);
    expect(cached.status).toBe('cached');
    expect(cached.statusLabel).toBe('Débridé · En cache ⚡');
    expect(uncached.status).toBe('uncached');
    expect(uncached.statusLabel).toBe('Débridé · À la demande');
    expect(uncached.provider).toBe('AllDebrid');
    expect(toSourceView({ url: 'https://cdn.test/x.mp4' }, 0).statusLabel).toBe('Lien direct');
  });

  it('reconnaît les liens /play de lastAddon (jeton signé ou infoHash legacy)', () => {
    expect(isDebridUrl('https://a.test/CFG/play/c/abc123')).toBe(true);
    expect(isDebridUrl('https://a.test/CFG/play/' + HASH + '/2?s=1&e=2')).toBe(true);
    expect(isDebridUrl('https://cdn.test/film.mp4')).toBe(false);
  });
});

describe('politique débrideur : failover', () => {
  it('ne retombe jamais sur une source torrent (ni en reprise, ni dans la course)', () => {
    const streams = [debrided(1), torrentOnly(1), debrided(2), torrentOnly(2), direct(1)];
    const views = toSourceViews(streams);
    const order = failoverOrder(views, views[0], new Set([0]));
    expect(order.map((v) => v.index)).toEqual([2, 4]);
    expect(order.some((v) => typeof v.stream.infoHash === 'string')).toBe(false);
    const cand = pickRaceCandidate(views, views[0], new Set([0, 2, 4]), new Set(), (v) => String(v.index));
    expect(cand).toBeNull();
  });
});

describe('politique débrideur : moteurs', () => {
  const caps = { formats: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };
  const base = { shell: false, serverUp: true, probe: null, caps, notWebReady: false, name: 'film.mkv' };

  it('mpv et libVLC lisent le lien HTTPS directement, sans serveur de streaming', () => {
    expect(chooseEngine({ ...base, shell: true })).toMatchObject({ engine: 'mpv', viaServer: false });
    expect(chooseEngine({ ...base, native: true })).toMatchObject({ engine: 'native', viaServer: false });
  });

  it('web : le serveur local ne sert qu au transcodage HLS d un lien HTTPS, étiquette sans « torrent »', () => {
    const hls = chooseEngine(base);
    expect(hls.engine).toBe('hls');
    expect(hls.label.toLowerCase()).not.toContain('torrent');
  });

  it('le client du serveur de streaming n expose plus de création de torrent', () => {
    expect((server as Record<string, unknown>).createTorrent).toBeUndefined();
    expect((server as Record<string, unknown>).torrentUrl).toBeUndefined();
  });
});
