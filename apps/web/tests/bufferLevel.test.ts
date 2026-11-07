// Mémoire tampon de lecture : réglage par appareil (standard | large | max) et son câblage dans les moteurs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBufferLevel, setBufferLevel, hlsBuffer, mpvBufferProps, vlcNetworkCachingMs, type BufferLevel,
} from '../src/player/bufferLevel';
import { HtmlEngine, MpvEngine } from '../src/player/engines.js';

const hoisted = vi.hoisted(() => ({ hlsConfigs: [] as Array<Record<string, unknown>> }));

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = {};
    static ErrorTypes = {};
    static isSupported() { return true; }
    audioTracks: unknown[] = [];
    subtitleTracks: unknown[] = [];
    constructor(cfg: Record<string, unknown>) { hoisted.hlsConfigs.push(cfg); }
    on() { return this; }
    loadSource() { /* sans réseau */ }
    attachMedia() { /* sans média */ }
    startLoad() { /* sans chargement */ }
    recoverMediaError() { /* sans erreur */ }
    destroy() { /* rien à libérer */ }
  }
  return { default: FakeHls };
});

const KEY = 'laststream.bufferlevel';
const LEVELS: readonly BufferLevel[] = ['standard', 'large', 'max'];

describe('réglage stocké', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('défaut : grand', () => {
    expect(getBufferLevel()).toBe('large');
  });

  it('valeur inconnue stockée : grand', () => {
    localStorage.setItem(KEY, 'énorme');
    expect(getBufferLevel()).toBe('large');
  });

  it('aller-retour set/get, sous la clé laststream.bufferlevel', () => {
    setBufferLevel('standard');
    expect(localStorage.getItem(KEY)).toBe('standard');
    expect(getBufferLevel()).toBe('standard');
    setBufferLevel('max');
    expect(getBufferLevel()).toBe('max');
  });

  it('une valeur hors contrat n’est pas écrite', () => {
    setBufferLevel('standard');
    setBufferLevel('énorme' as unknown as BufferLevel);
    expect(getBufferLevel()).toBe('standard');
  });

  it('stockage en lecture refusé : grand, sans erreur', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => getBufferLevel()).not.toThrow();
    expect(getBufferLevel()).toBe('large');
  });

  it('stockage en écriture refusé : sans erreur', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => setBufferLevel('max')).not.toThrow();
  });
});

describe('contrat des niveaux', () => {
  it('hls.js : valeurs du contrat', () => {
    expect(hlsBuffer('standard')).toEqual({ maxBufferLength: 40, maxMaxBufferLength: 600, maxBufferSize: 60e6, backBufferLength: 30 });
    expect(hlsBuffer('large')).toEqual({ maxBufferLength: 120, maxMaxBufferLength: 600, maxBufferSize: 200e6, backBufferLength: 30 });
    expect(hlsBuffer('max')).toEqual({ maxBufferLength: 300, maxMaxBufferLength: 600, maxBufferSize: 400e6, backBufferLength: 60 });
  });

  it('mpv : propriétés du contrat, en chaînes', () => {
    expect(mpvBufferProps('standard')).toEqual([
      ['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '150MiB'], ['demuxer-max-back-bytes', '50MiB'], ['cache-pause-wait', '2'],
    ]);
    expect(mpvBufferProps('large')).toEqual([
      ['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '512MiB'], ['demuxer-max-back-bytes', '64MiB'], ['cache-pause-wait', '5'],
    ]);
    expect(mpvBufferProps('max')).toEqual([
      ['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '1GiB'], ['demuxer-max-back-bytes', '128MiB'], ['cache-pause-wait', '10'],
    ]);
  });

  it('libVLC : networkCachingMs du contrat', () => {
    expect(vlcNetworkCachingMs('standard')).toBe(3000);
    expect(vlcNetworkCachingMs('large')).toBe(8000);
    expect(vlcNetworkCachingMs('max')).toBe(30000);
  });

  it('chaque niveau est strictement plus grand que le précédent sur les grandeurs qui grossissent', () => {
    const bytes = (v: string) => {
      const m = /^(\d+)(MiB|GiB)$/.exec(v);
      return m ? Number(m[1]) * (m[2] === 'GiB' ? 1024 ** 3 : 1024 ** 2) : Number(v);
    };
    const [s, l, m] = LEVELS.map((lvl) => Object.fromEntries(mpvBufferProps(lvl)));
    for (const key of ['demuxer-max-bytes', 'demuxer-max-back-bytes', 'cache-pause-wait']) {
      expect(bytes(s[key]), key).toBeLessThan(bytes(l[key]));
      expect(bytes(l[key]), key).toBeLessThan(bytes(m[key]));
    }
    const [hs, hl, hm] = LEVELS.map((lvl) => hlsBuffer(lvl));
    expect(hs.maxBufferLength).toBeLessThan(hl.maxBufferLength);
    expect(hl.maxBufferLength).toBeLessThan(hm.maxBufferLength);
    expect(hs.maxBufferSize).toBeLessThan(hl.maxBufferSize);
    expect(hl.maxBufferSize).toBeLessThan(hm.maxBufferSize);
    // Hors monotonie stricte dans le contrat (valeurs gardées telles quelles) : backBufferLength 30 / 30 / 60.
    expect(hs.backBufferLength).toBeLessThanOrEqual(hl.backBufferLength);
    expect(hl.backBufferLength).toBeLessThan(hm.backBufferLength);
    const [vs, vl, vm] = LEVELS.map((lvl) => vlcNetworkCachingMs(lvl));
    expect(vs).toBeLessThan(vl);
    expect(vl).toBeLessThan(vm);
  });
});

describe('câblage dans les moteurs', () => {
  beforeEach(() => { localStorage.clear(); hoisted.hlsConfigs.length = 0; });
  afterEach(() => { localStorage.clear(); });

  it('hls.js reçoit la mémoire tampon du réglage', async () => {
    setBufferLevel('max');
    const engine = new HtmlEngine(document.createElement('video'));
    await engine.load({ url: 'http://serveur/master.m3u8', hls: true, startAt: 0 });
    expect(hoisted.hlsConfigs.at(-1)).toMatchObject(hlsBuffer('max'));
  });

  it('lecteur direct : préchargement automatique', async () => {
    const video = document.createElement('video');
    const engine = new HtmlEngine(video);
    await engine.load({ url: 'http://serveur/film.mp4', hls: false, startAt: 0 });
    expect(video.preload).toBe('auto');
  });

  it('mpv : les propriétés de mémoire tampon partent avant le loadfile', async () => {
    setBufferLevel('max');
    const sent: Array<[string, unknown]> = [];
    const ipc = { send: (name: string, args?: unknown) => { sent.push([name, args]); }, on: () => ipc };
    const engine = new MpvEngine(ipc, document.createElement('div'));
    engine.onProp({ name: 'mpv-version', data: '0.40.0' });
    await engine.load({ url: 'http://serveur/film.mkv', startAt: 0 });
    const loadIdx = sent.findIndex(([n, a]) => n === 'mpv-command' && Array.isArray(a) && a[0] === 'loadfile');
    expect(loadIdx).toBeGreaterThan(-1);
    const names = new Set(mpvBufferProps('max').map(([k]) => k));
    const before = sent.slice(0, loadIdx).filter(([n, a]) => n === 'mpv-set-prop' && Array.isArray(a) && names.has(String(a[0])));
    expect(before).toEqual(mpvBufferProps('max').map(([k, v]) => ['mpv-set-prop', [k, v]]));
  });
});
