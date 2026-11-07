import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_INDEX, clearLaunchCache, forgetLaunch, LAUNCH_TTL_MS, launchUsable, recallLaunch, reconcileLaunch, rememberLaunch, type LaunchCheck } from '../src/player/launchCache';
import { sourceKey } from '../src/player/memory';
import { CONFIG_OWNER_KEY, claimLocalConfig, clearLocalAccountData } from '../src/data/configSync';
import { toSourceViews, withWebPlayback, type SourceView } from '../src/sources/info';
import type { Stream } from '../src/data/stream';

/* ODY-206 : relancer un épisode déjà lancé reprend la source mémorisée (6 h, même appareil) ; toute raison de ne plus s'y fier la fait oublier. */

const EP = 'tv:1399:2:6';
const stream = (name: string, over: Record<string, unknown> = {}): Stream => ({
  url: 'https://host.example/play/' + name + '?token=abc',
  behaviorHints: { filename: name },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, ...over },
});
const entry = (s: Stream, over: Record<string, unknown> = {}) => ({ source: sourceKey({ stream: s }), stream: s, imdb: 'tt1', lang: 'fr', ...over });

beforeEach(() => { localStorage.clear(); });

describe('mémorisation de la source lancée', () => {
  it('une source mémorisée est rendue à la relance, avec son flux et son imdb', () => {
    const s = stream('Silo.S02E06.mkv');
    rememberLaunch(EP, entry(s), 1000);
    const e = recallLaunch(EP, 'fr', 2000);
    expect(e?.stream).toEqual(s);
    expect(e?.imdb).toBe('tt1');
  });

  it('un autre épisode n’a rien de mémorisé', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    expect(recallLaunch('tv:1399:2:7', 'fr', 2000)).toBeNull();
  });

  it('expire au bout de 6 h : l’entrée est retirée', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    expect(recallLaunch(EP, 'fr', 1000 + LAUNCH_TTL_MS - 1)).not.toBeNull();
    expect(recallLaunch(EP, 'fr', 1000 + LAUNCH_TTL_MS)).toBeNull();
    expect(recallLaunch(EP, 'fr', 1001)).toBeNull();
  });

  it('une horloge qui a reculé n’ouvre pas une entrée « du futur »', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 10 * 60_000);
    expect(recallLaunch(EP, 'fr', 0)).toBeNull();
  });

  it('la langue de source préférée a changé : la source mémorisée n’est plus la bonne', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    expect(recallLaunch(EP, 'en', 2000)).toBeNull();
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
  });

  it('la dernière source lancée remplace la précédente (changement de source)', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    const b = stream('b.mkv');
    rememberLaunch(EP, entry(b), 2000);
    expect(recallLaunch(EP, 'fr', 3000)?.stream).toEqual(b);
  });

  it('forgetLaunch avec une source : ne retire que cette source', () => {
    const a = stream('a.mkv');
    const b = stream('b.mkv');
    rememberLaunch(EP, entry(b), 1000);
    forgetLaunch(EP, sourceKey({ stream: a }));
    expect(recallLaunch(EP, 'fr', 2000)).not.toBeNull();
    forgetLaunch(EP, sourceKey({ stream: b }));
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
  });

  it('forgetLaunch sans source retire l’entrée', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    forgetLaunch(EP);
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
  });

  it('ne garde que les 30 plus récentes', () => {
    for (let i = 0; i < 35; i += 1) rememberLaunch('movie:' + i, entry(stream('f' + i + '.mkv')), 1000 + i);
    expect(recallLaunch('movie:0', 'fr', 2000)).toBeNull();
    expect(recallLaunch('movie:34', 'fr', 2000)).not.toBeNull();
  });

  it('stockage corrompu, plein ou absent : aucune erreur, simple absence de cache', () => {
    localStorage.setItem('laststream.player.launch.v1', '{pas du json');
    expect(recallLaunch(EP, 'fr', 1)).toBeNull();
    localStorage.setItem('laststream.player.launch.v1', JSON.stringify({ [EP]: { at: 'x' } }));
    expect(recallLaunch(EP, 'fr', 1)).toBeNull();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => rememberLaunch(EP, entry(stream('a.mkv')), 1)).not.toThrow();
    spy.mockRestore();
  });

  it('clearLaunchCache et la déconnexion vident le cache', () => {
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    clearLaunchCache();
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    localStorage.setItem('laststream.theme', 'dark');
    clearLocalAccountData();
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
    expect(localStorage.getItem('laststream.theme')).toBe('dark');
  });
});

describe('launchUsable : la source mémorisée est-elle encore valable ?', () => {
  const plain = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3', 'opus'], maxAudioChannels: 6 };
  const view = (s: Stream): SourceView => withWebPlayback(toSourceViews([s]), plain, { appAudio: true })[0];
  const check = (over: Partial<LaunchCheck> = {}): LaunchCheck => ({
    compat: { web: true, serverUp: false, rangeDenied: () => false }, hasDebrid: true, bad: new Set<string>(), keyOf: sourceKey, ...over,
  });

  it('source lisible dans le navigateur : relancée telle quelle', () => {
    expect(launchUsable(view(stream('Film.1080p.WEB.AAC.mp4')), check())).toBe(true);
  });

  it('source marquée lente ou en échec depuis : recherche complète', () => {
    const v = view(stream('Film.1080p.WEB.AAC.mp4'));
    expect(launchUsable(v, check({ bad: new Set([sourceKey(v)]) }))).toBe(false);
  });

  it('source qui ne passerait plus dans le navigateur (HEVC sans serveur) : recherche complète', () => {
    const hevc = stream('Film.2160p.WEB.HEVC.AAC.mkv', { resolution: '2160p', height: 2160, codec: 'HEVC' });
    expect(launchUsable(view(hevc), check())).toBe(false);
    expect(launchUsable(view(hevc), check({ compat: { web: true, serverUp: true, rangeDenied: () => false } }))).toBe(true);
  });

  it('torrent sans lien (débridé sur l’appareil) : exige un débrideur configuré', () => {
    const client: Stream = { infoHash: 'a'.repeat(40), behaviorHints: { lastDebrid: 'client', filename: 'Film.mkv' }, laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000 } };
    expect(launchUsable(view(client), check())).toBe(true);
    expect(launchUsable(view(client), check({ hasDebrid: false }))).toBe(false);
  });

  it('flux sans lien lisible : non', () => {
    expect(launchUsable(view({ name: 'rien' }), check())).toBe(false);
  });
});

describe('reconcileLaunch : la liste complète arrive pendant la lecture de la source mémorisée', () => {
  const v = (key: string, index: number) => ({ key, index });
  const keyOf = (x: { key: string }) => x.key;

  it('la source mémorisée est remplacée par sa fiche de la liste, les indices essayés suivent', () => {
    const r = reconcileLaunch(v('b', MEMORY_INDEX), [v('a', 0), v('b', 1), v('c', 2)], keyOf, new Set([MEMORY_INDEX]));
    expect(r.view).toEqual(v('b', 1));
    expect([...r.tried]).toEqual([1]);
  });

  it('absente de la liste : elle reste hors liste (index réservé), sans prendre l’indice d’une autre source', () => {
    const mine = v('z', MEMORY_INDEX);
    const r = reconcileLaunch(mine, [v('a', 0), v('b', 1)], keyOf, new Set([MEMORY_INDEX]));
    expect(r.view).toBe(mine);
    expect([...r.tried]).toEqual([MEMORY_INDEX]);
    expect(MEMORY_INDEX).toBeLessThan(0);
  });
});

describe('changement de compte sans déconnexion', () => {
  it('claimLocalConfig d’un autre compte vide aussi la source mémorisée', () => {
    localStorage.setItem(CONFIG_OWNER_KEY, 'alice');
    rememberLaunch(EP, entry(stream('a.mkv')), 1000);
    claimLocalConfig('alice');
    expect(recallLaunch(EP, 'fr', 2000)).not.toBeNull();
    claimLocalConfig('bob');
    expect(recallLaunch(EP, 'fr', 2000)).toBeNull();
  });
});
