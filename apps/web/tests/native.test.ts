import { describe, expect, it, vi } from 'vitest';
import { chooseEngine } from '../src/player/engine';
import { NativeEngine } from '../src/player/engines.js';
import { nativeAudioTracks, nativeSubtitleTracks, toNativeSegments, toNativeSubtitles } from '../src/player/native';
import { cleartextAllowed, isLanHost, streamingServerFor } from '../src/data/lan';
import { normalizeBase } from '../src/data/config';
import type { SubtitleTrack } from '../src/player/tracks';

describe('réseau local (http Android)', () => {
  it.each(['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.254', '169.254.1.1', 'monpc.local', '[::1]', 'fd12:3456::1'])('%s est local', (h) => {
    expect(isLanHost(h)).toBe(true);
  });
  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', 'example.com', '300.1.1.1', 'monpc', 'nas.internal', ''])('%s n’est pas local', (h) => {
    expect(isLanHost(h)).toBe(false);
  });
  it('autorise https partout, http seulement en local', () => {
    expect(cleartextAllowed('https://example.com')).toBe(true);
    expect(cleartextAllowed('http://192.168.1.20:7000')).toBe(true);
    expect(cleartextAllowed('http://example.com')).toBe(false);
    expect(cleartextAllowed('ftp://192.168.1.1')).toBe(false);
  });
  it('déduit le serveur de streaming du PC', () => {
    expect(streamingServerFor('http://192.168.1.20:7000')).toBe('http://192.168.1.20:11470');
    expect(streamingServerFor('https://nas.local/addon')).toBe('https://nas.local:11470');
    expect(streamingServerFor('pas une adresse')).toBe('');
  });
  it('hors Android, normalizeBase garde l’ancien comportement', () => {
    expect(normalizeBase('http://example.com/')).toBe('http://example.com');
  });
});

describe('moteur natif', () => {
  const base = { shell: false, serverUp: false, probe: null, caps: { formats: [], videoCodecs: [], audioCodecs: [], maxAudioChannels: 2 }, notWebReady: true, name: 'x.mkv' };
  it('le lecteur natif prime sur tout, même pour du HEVC sans serveur', () => {
    const c = chooseEngine({ ...base, native: true });
    expect(c.engine).toBe('native');
    expect(chooseEngine({ ...base, native: true }).viaServer).toBe(false);
  });
  it('sans natif, le choix existant est inchangé', () => {
    expect(chooseEngine({ ...base, shell: true }).engine).toBe('mpv');
    expect(chooseEngine(base).engine).toBe('direct');
  });
});

describe('conversions vers le plugin', () => {
  it('segments : champs utiles seulement', () => {
    expect(toNativeSegments([{ kind: 'intro', start: 1, end: 9 }, { kind: 'credits', start: 100, end: 120, inferred: true, confidence: 0.4 }])).toEqual([
      { kind: 'intro', start: 1, end: 9 }, { kind: 'credits', start: 100, end: 120, inferred: true, confidence: 0.4 },
    ]);
  });
  const sub = (lang: string, n: number): SubtitleTrack => ({ id: lang + n, lang, label: lang + n, codec: '', forced: false, origin: 'external', renderable: true, selected: false, url: 'http://s/' + lang + n });
  it('sous-titres : langue préférée (4 max) puis anglais (2 max)', () => {
    const list = [...[1, 2, 3, 4, 5].map((n) => sub('fr', n)), ...[1, 2, 3].map((n) => sub('en', n)), sub('de', 1)];
    const out = toNativeSubtitles(list, 'fr');
    expect(out.map((s) => s.label)).toEqual(['fr1', 'fr2', 'fr3', 'fr4', 'en1', 'en2']);
  });
  it('pistes natives vers pistes du lecteur', () => {
    const a = nativeAudioTracks([{ id: 1, label: 'Français · EAC3 5.1', lang: 'fr', selected: true }]);
    expect(a[0]).toMatchObject({ id: '1', lang: 'fr', selected: true });
    const s = nativeSubtitleTracks([{ id: 4, label: 'Français (forcés)', lang: 'fr', selected: false }]);
    expect(s[0]).toMatchObject({ id: '4', forced: true, origin: 'embedded', engineId: 4 });
  });
});

describe('NativeEngine', () => {
  function fakePlugin() {
    const handlers = new Map<string, (d: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
      open: vi.fn(async () => {}), close: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
      seek: vi.fn(async () => {}), setRate: vi.fn(async () => {}), setAudioTrack: vi.fn(async () => {}), setSubtitleTrack: vi.fn(async () => {}),
      addSubtitles: vi.fn(async () => {}), update: vi.fn(async () => {}),
      minimize: vi.fn(async () => ({ mini: true })), expand: vi.fn(async () => ({ mini: false })),
    };
    return { plugin, fire: (ev: string, d: unknown) => handlers.get(ev)?.(d) };
  }

  it('ouvre le lecteur, relaie l’état et signale « ready »', async () => {
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin, () => 0); // horloge figée : la position n'est pas interpolée entre les évènements
    const ready = vi.fn();
    e.on('ready', ready);
    await e.load({ url: 'http://x/a.mkv', startAt: 42, open: { title: 'T' } });
    expect(plugin.open).toHaveBeenCalledWith({ title: 'T', url: 'http://x/a.mkv', startPosition: 42 });
    fire('state', { position: 43, duration: 3000, paused: false, buffering: false, rate: 1 });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(e.state()).toMatchObject({ time: 43, duration: 3000, paused: false, rate: 1 });
  });

  it('la durée de repli de la sonde part à l’ouverture du plugin', async () => {
    const { plugin } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'http://x/a.mkv', startAt: 0, open: { durationSec: 5400 } });
    expect(plugin.open).toHaveBeenCalledWith({ durationSec: 5400, url: 'http://x/a.mkv', startPosition: 0 });
  });

  it('vignette flottante : relaie miniChanged, minimize() et expand()', async () => {
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'http://x/a.mkv', startAt: 0, open: {} });
    const mini = vi.fn();
    e.on('mini', mini);
    fire('miniChanged', { mini: true });
    fire('miniChanged', { mini: false });
    expect(mini.mock.calls).toEqual([[true], [false]]);
    await expect(e.minimize()).resolves.toBe(true);
    await expect(e.expand()).resolves.toBe(false);
    plugin.minimize.mockRejectedValueOnce(new Error('absent'));
    await expect(e.minimize()).resolves.toBe(false);
  });

  it('relaie fin, erreur, fermeture et épisode suivant ; ignore les évènements après destroy', async () => {
    vi.useFakeTimers();
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    const got: string[] = [];
    (['ended', 'error', 'closed', 'next', 'trackChanged'] as const).forEach((ev) => e.on(ev, () => got.push(ev)));
    await e.load({ url: 'u', startAt: 0, open: {} });
    fire('ended', {}); fire('error', { code: 'decode' }); fire('closed', { position: 1 }); fire('nextEpisode', {}); fire('trackChanged', { kind: 'audio' });
    expect(got).toEqual(['ended', 'error', 'closed', 'next', 'trackChanged']);
    e.destroy();
    fire('ended', {});
    expect(got).toHaveLength(5);
    vi.advanceTimersByTime(800);
    expect(plugin.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('un load juste après destroy réutilise l’activité (pas de fermeture)', async () => {
    vi.useFakeTimers();
    const { plugin } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'a', startAt: 0, open: {} });
    e.destroy();
    await e.load({ url: 'b', startAt: 0, open: {} });
    vi.advanceTimersByTime(2000);
    expect(plugin.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('commandes et pistes', async () => {
    const { plugin, fire } = fakePlugin();
    const e = new NativeEngine(plugin);
    await e.load({ url: 'u', startAt: 0, open: {} });
    fire('tracks', { audio: [{ id: 1, label: 'Anglais', lang: 'en', selected: true }], subs: [{ id: 3, label: 'Français', lang: 'fr', selected: false }] });
    expect(e.audioTracks()).toHaveLength(1);
    e.setAudioTrack('2'); e.setSubtitleTrack(null); e.setSubtitleTrack('3'); e.seek(12); e.setRate(1.5); e.pause(); e.play();
    expect(plugin.setAudioTrack).toHaveBeenCalledWith({ id: 2 });
    expect(plugin.setSubtitleTrack).toHaveBeenNthCalledWith(1, { id: -1 });
    expect(plugin.setSubtitleTrack).toHaveBeenNthCalledWith(2, { id: 3 });
    expect(plugin.seek).toHaveBeenCalledWith({ position: 12 });
    expect(plugin.setRate).toHaveBeenCalledWith({ rate: 1.5 });
  });
});

describe('panneaux Sources et Épisodes du lecteur natif', () => {
  it('sources : groupes, libellé, détail, courante', async () => {
    const { toNativeSources } = await import('../src/player/native');
    const views = [
      { index: 0, group: '2160p', sizeLabel: '40 Go', bitrateLabel: '60 Mb/s', playable: true },
      { index: 1, group: '1080p', sizeLabel: '', bitrateLabel: '', playable: true },
      { index: 2, group: 'other', playable: false },
    ];
    const out = toNativeSources(views, 1, (v) => 'src' + v.index, () => 'AllDebrid');
    expect(out).toHaveLength(2);
    // Contrat historique (libellé, détail, courant, groupe) ; les champs structurés s'y ajoutent.
    expect(out[0]).toMatchObject({ id: '0', label: 'src0', detail: '40 Go · 60 Mb/s · AllDebrid', current: false, group: '4K' });
    expect(out[1]).toMatchObject({ id: '1', detail: 'AllDebrid', current: true, group: '1080p' });
  });

  it('sources : champs structurés de la carte web, libellé, détail et groupe gardés', async () => {
    const { toNativeSources } = await import('../src/player/native');
    const view = {
      index: 4, group: '2160p', quality: '4K', sourceType: 'REMUX', codec: 'HEVC', audio: 'TrueHD Atmos 7.1', hdr: ['HDR10'],
      langs: [{ label: 'VF', verified: true }, { label: 'VO', verified: false }], sizeLabel: '40 Go', bitrateLabel: '60 Mb/s',
      filename: 'Film.2160p.REMUX.mkv', releaseGroup: 'GRP', status: 'cached' as const, statusLabel: 'En cache', provider: 'AllDebrid',
      origins: [{ name: 'Torrentio' }, { name: 'Comet' }], copies: 2, playable: true,
    };
    const [s] = toNativeSources([view], 4, () => 'label', () => 'Torrentio');
    expect(s).toMatchObject({ id: '4', label: 'label', detail: '40 Go · 60 Mb/s · Torrentio', current: true, group: '4K' });
    expect(s).toMatchObject({
      quality: '4K', sourceType: 'REMUX', codec: 'HEVC', audio: 'TrueHD Atmos 7.1', hdr: ['HDR10'], size: '40 Go', bitrate: '60 Mb/s',
      release: 'Film.2160p.REMUX.mkv', releaseGroup: 'GRP', status: 'cached', statusLabel: 'En cache', provider: 'AllDebrid',
      origins: ['Torrentio', 'Comet'], copies: 2,
    });
    expect(s.langs).toEqual([{ label: 'VF', verified: true }, { label: 'VO', verified: false }]);
    // Sans détail, la source part dans la forme historique : aucun champ vide ni `undefined` sur le fil (JSON).
    const [plain] = toNativeSources([{ index: 1, group: 'other', playable: true, sizeLabel: '', bitrateLabel: '' }], null, () => 'x', () => '');
    expect(JSON.parse(JSON.stringify(plain))).toStrictEqual({ id: '1', label: 'x', detail: '', current: false, group: 'Autres' });
  });

  it('épisodes : saisons, courant, progression ; null pour un film', async () => {
    const { toNativeEpisodes } = await import('../src/player/native');
    expect(toNativeEpisodes([], new Map(), { season: null, episode: null }, () => ({ watched: false, progress: 0 }))).toBeNull();
    const loaded = new Map([[2, [{ episode: 1, name: 'A', runtime: 40, still: 'http://i/1.jpg', aired: true }, { episode: 2, name: 'B', aired: false }]]]);
    const out = toNativeEpisodes([{ season: 1, count: 8 }, { season: 2, count: 8 }], loaded, { season: 2, episode: 1 }, (_s, e) => ({ watched: e === 2, progress: 0.25 }))!;
    expect(out.seasons.map((s) => s.name)).toEqual(['Saison 1', 'Saison 2']);
    expect(out.currentSeason).toBe(2);
    expect(out.items[0]).toMatchObject({ season: 2, episode: 1, title: 'A', durationMin: 40, current: true, aired: true, progress: 0.25 });
    expect(out.items[1]).toMatchObject({ current: false, aired: false, watched: true });
  });

  it('NativeEngine : selectSource, selectEpisode, loadSeason ; closed passe même détaché', async () => {
    const handlers = new Map<string, (d: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
      open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    const e = new NativeEngine(plugin);
    const got: unknown[] = [];
    (['selectSource', 'selectEpisode', 'loadSeason', 'closed'] as const).forEach((ev) => e.on(ev, (d: unknown) => got.push([ev, d])));
    await e.load({ url: 'u', startAt: 0, open: {} });
    handlers.get('selectSource')?.({ id: '3', position: 12 });
    handlers.get('selectEpisode')?.({ season: 1, episode: 4 });
    handlers.get('loadSeason')?.({ season: 2 });
    e.detach();
    handlers.get('selectSource')?.({ id: '9', position: 1 });
    handlers.get('closed')?.({ position: 77 });
    expect(got).toEqual([
      ['selectSource', { id: '3', position: 12 }], ['selectEpisode', { season: 1, episode: 4 }], ['loadSeason', { season: 2 }], ['closed', { position: 77 }],
    ]);
    expect(e.state().time).toBe(77);
    expect(plugin.close).not.toHaveBeenCalled();
  });
});
