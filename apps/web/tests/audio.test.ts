import { describe, expect, it } from 'vitest';
import { canPlayProbe } from '../src/player/engine';
import { getMemory, remember } from '../src/player/memory';
import { corsFriendlyOrigin, serverCandidates } from '../src/player/server';
import { langFromTitle, parseProbe, pickDefaultAudio, pickRememberedSubtitle, trackLang, type SubtitleTrack } from '../src/player/tracks';
import { webPlayback } from '../src/sources/direct';
import { toSourceViews, withWebPlayback } from '../src/sources/info';
import { recommend } from '../src/sources/rank';
import { getLaststream, type Stream } from '../src/data/stream';

const mk = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Stream => ({
  url: 'https://x/play/abc',
  laststream: {
    resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50,
    estBitrateKbps: 8000, ...over,
  },
  ...top,
});

describe('langue des pistes audio (VF, VFF, VFQ, French…)', () => {
  it('langue par balise, sinon par titre de piste', () => {
    expect(['fre', 'fra', 'fr-FR', 'French'].map((l) => trackLang(l))).toEqual(['fr', 'fr', 'fr', 'fr']);
    expect(trackLang('', 'Français VFF')).toBe('fr');
    expect(trackLang(undefined, 'VFQ 5.1')).toBe('fr');
    expect(trackLang('und', 'TrueFrench')).toBe('fr');
    expect(trackLang('', 'English Commentary')).toBe('en');
    expect(trackLang('jpn', 'Whatever')).toBe('ja');
    expect(langFromTitle('Piste 1')).toBe('');
  });

  const probeJp = parseProbe({
    format: { name: 'matroska,webm', duration: 20 },
    streams: [
      { id: 0, track: 'video', codec: 'h264' },
      { id: 0, track: 'audio', codec: 'aac', channels: 2, language: 'jpn', title: 'Japanese' },
      { id: 1, track: 'audio', codec: 'ac3', channels: 6, language: 'fre', title: 'Français VFF' },
      { id: 2, track: 'audio', codec: 'aac', channels: 2, language: 'eng', title: 'English' },
    ],
  });

  it('choisit le français quand la piste par défaut est le japonais', () => {
    expect(probeJp.audio.map((t) => t.lang)).toEqual(['ja', 'fr', 'en']);
    expect(probeJp.audio[1].label).toBe('Français VFF · Dolby Digital 5.1');
    expect(pickDefaultAudio(probeJp.audio, ['fr'])).toBe(1);
    expect(pickDefaultAudio(probeJp.audio, ['en', 'fr'])).toBe(2);
    expect(pickDefaultAudio(probeJp.audio, ['ja'])).toBe(0);
  });

  it('titre seul quand la balise de langue manque', () => {
    const p = parseProbe({ streams: [{ id: 0, track: 'audio', codec: 'aac', title: 'English' }, { id: 1, track: 'audio', codec: 'aac', title: 'VFQ' }] });
    expect(pickDefaultAudio(p.audio, ['fr'])).toBe(1);
  });

  it('lecture directe refusée quand la langue souhaitée n’est pas la piste par défaut', () => {
    const probe2 = {
      format: { name: 'mov,mp4,m4a' },
      streams: [
        { id: 0, track: 'video', codec: 'h264' },
        { id: 0, track: 'audio', codec: 'aac', channels: 2, language: 'jpn' },
        { id: 1, track: 'audio', codec: 'ac3', channels: 6, language: 'fre' },
      ],
    };
    const c = { formats: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac', 'ac3'], maxAudioChannels: 6 };
    expect(canPlayProbe(probe2, c, { preferredLang: 'fr' })).toBe(false);
    expect(canPlayProbe(probe2, c, { preferredLang: 'fr', audioTracksSupported: true })).toBe(true);
    expect(canPlayProbe(probe2, { ...c, maxAudioChannels: 2 }, { preferredLang: 'fr', audioTracksSupported: true })).toBe(false);
    expect(canPlayProbe(probe2, c, { preferredLang: 'ja', audioTracksSupported: true })).toBe(true);
    const single = { format: { name: 'mp4' }, streams: [{ id: 0, track: 'video', codec: 'h264' }, { id: 0, track: 'audio', codec: 'aac', channels: 2, language: 'jpn' }] };
    expect(canPlayProbe(single, c, { preferredLang: 'fr' })).toBe(true);
  });

  it('sous-titres et mémoire par titre', () => {
    const base = { codec: 'subrip', origin: 'embedded' as const, renderable: true, selected: false };
    const subs: SubtitleTrack[] = [
      { ...base, id: 's0', lang: 'fr', label: 'Français', forced: true },
      { ...base, id: 's1', lang: 'fr', label: 'Français', forced: false },
      { ...base, id: 's2', lang: 'en', label: 'Anglais', forced: false },
    ];
    expect(pickRememberedSubtitle(subs, 'off')).toBe(-1);
    expect(pickRememberedSubtitle(subs, 'en')).toBe(2);
    expect(pickRememberedSubtitle(subs, 'fr')).toBe(1);
    expect(pickRememberedSubtitle(subs, 'de')).toBe(-1);
    localStorage.clear();
    expect(getMemory('tv:1')).toEqual({});
    remember('tv:1', { audio: 'fr' });
    remember('tv:1', { sub: 'off' });
    expect(getMemory('tv:1')).toEqual({ audio: 'fr', sub: 'off' });
  });
});

describe('serveur de streaming et CORS', () => {
  it('seules strem.io, stremio.com et l’origine du serveur sont admises', () => {
    expect(corsFriendlyOrigin('https://web.stremio.com')).toBe(true);
    expect(corsFriendlyOrigin('http://127.0.0.1:11470')).toBe(true);
    expect(corsFriendlyOrigin('http://localhost:8080')).toBe(false);
    expect(corsFriendlyOrigin('http://192.168.1.143:8080')).toBe(false);
  });

  it('hors origine admise, le relais same-origin passe avant l’adresse directe', () => {
    localStorage.clear();
    expect(serverCandidates('http://localhost:8080')).toEqual(['http://localhost:8080/_ss', 'http://127.0.0.1:11470']);
    expect(serverCandidates('https://web.stremio.com')).toEqual(['http://127.0.0.1:11470', 'https://web.stremio.com/_ss']);
    localStorage.setItem('laststream.streamingServer', 'http://nas:11470');
    expect(serverCandidates('http://localhost:8080')[0]).toBe('http://nas:11470');
    localStorage.clear();
  });
});

describe('lecture directe ou conversion dans le navigateur', () => {
  const caps = { formats: ['mp4', 'matroska,webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'opus', 'mp3'], maxAudioChannels: 2 };
  const web = (over: Record<string, unknown>, hints: Record<string, unknown> = {}) => {
    const s = mk(over, { behaviorHints: hints });
    return webPlayback(s, getLaststream(s), caps);
  };

  it('H.264 + AAC : direct', () => {
    expect(web({ codec: 'AVC', audio: ['AAC'], channels: '2.0' }, { filename: 'Film.1080p.WEB-DL.x264.AAC.mp4' })).toBe('direct');
    expect(web({ codec: 'AVC', audio: ['AAC'] }, { filename: 'Film.mkv' })).toBe('direct');
  });

  it('HEVC, REMUX, DTS, TrueHD, E-AC3 non pris en charge, 5.1, AVI : conversion', () => {
    expect(web({ codec: 'HEVC', audio: ['AAC'] })).toBe('convert');
    expect(web({ codec: 'AVC', source: 'REMUX' }, { filename: 'Film.REMUX.mkv' })).toBe('convert');
    expect(web({ codec: 'AVC', audio: ['DTS-HD MA'] })).toBe('convert');
    expect(web({ codec: 'AVC', audio: ['TrueHD'] })).toBe('convert');
    expect(web({ codec: 'AVC', audio: ['EAC3'] })).toBe('convert');
    expect(web({ codec: 'AVC', audio: ['AAC'], channels: '5.1' })).toBe('convert');
    expect(web({ codec: 'AVC', audio: ['AAC'] }, { filename: 'a.avi' })).toBe('convert');
  });

  it('E-AC3 devient direct quand le navigateur le décode', () => {
    const s = mk({ codec: 'AVC', audio: ['EAC3'], channels: '5.1' });
    expect(webPlayback(s, getLaststream(s), { ...caps, audioCodecs: [...caps.audioCodecs, 'eac3'], maxAudioChannels: 6 })).toBe('direct');
  });

  it('métadonnées insuffisantes : inconnu', () => {
    expect(webPlayback({ url: 'https://x/play/abc' }, null, caps)).toBe('unknown');
  });

  it('recommandation dans le navigateur : la lecture directe passe avant un 4K à convertir', () => {
    const list = [
      mk({ resolution: '2160p', score: 95, codec: 'HEVC', source: 'REMUX', audio: ['TrueHD'], languages: ['fr'], estBitrateKbps: 50000 }),
      mk({ resolution: '1080p', score: 70, codec: 'AVC', audio: ['AAC'], languages: ['fr'], frVariant: 'VFF', estBitrateKbps: 8000 }, { behaviorHints: { filename: 'Film.1080p.x264.AAC.mp4' } }),
      mk({ resolution: '1080p', score: 80, codec: 'HEVC', audio: ['AAC'], languages: ['fr'], estBitrateKbps: 6000 }),
    ];
    const views = withWebPlayback(toSourceViews(list), caps);
    expect(views.map((v) => v.web)).toEqual(['convert', 'direct', 'convert']);
    expect(recommend(views, 100_000, 'fr', { preferDirect: true })!.view.index).toBe(1);
    expect(recommend(toSourceViews(list), 100_000, 'fr')!.view.index).toBe(0);
    const vo = withWebPlayback(toSourceViews([
      mk({ resolution: '1080p', score: 90, codec: 'AVC', audio: ['AAC'], languages: ['en'] }, { behaviorHints: { filename: 'a.mp4' } }),
      mk({ resolution: '1080p', score: 60, codec: 'HEVC', audio: ['AAC'], languages: ['fr'] }),
    ]), caps);
    expect(recommend(vo, null, 'fr', { preferDirect: true })!.view.index).toBe(1);
  });
});
