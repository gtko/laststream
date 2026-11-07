import { describe, expect, it } from 'vitest';
import { toSourceViews, withWebPlayback, type SourceView } from '../src/sources/info';
import { recommend } from '../src/sources/rank';
import { failoverCandidates, webCompatOf, type WebCompatContext } from '../src/sources/webCompat';
import { appOffer, detectOs, APP_DOWNLOAD_URL } from '../src/player/appDownload';
import type { Stream } from '../src/data/stream';

/* ODY-189 : dans le navigateur, une source dont la vidéo ou le son ne passe pas n'est jamais choisie d'office, elle reste visible
 * (grisée) dans le panneau ; l'app est proposée selon l'OS. */

const ALL_AUDIO = ['aac', 'mp3', 'opus', 'flac', 'vorbis'];
const plain = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ALL_AUDIO, maxAudioChannels: 6 };

const mk = (filename: string, over: Record<string, unknown> = {}): Stream => ({
  url: 'https://host-' + filename.length + '.example/play/' + filename,
  behaviorHints: { filename },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, ...over },
});

const views = (list: Stream[], appAudio = true): SourceView[] => withWebPlayback(toSourceViews(list), plain, { appAudio });
const ctx = (over: Partial<WebCompatContext> = {}): WebCompatContext => ({ web: true, serverUp: false, rangeDenied: () => false, ...over });

describe('webCompatOf : vidéo et son dans le navigateur', () => {
  const direct = mk('Film.1080p.WEB.AAC.mp4');
  const hevc = mk('Film.2160p.WEB.HEVC.AAC.mkv', { resolution: '2160p', height: 2160, codec: 'HEVC' });
  const dts = mk('Film.1080p.BluRay.DTS.mkv');
  const dolby = mk('Film.1080p.WEB.DDP5.1.mkv');

  it('lecture directe : compatible', () => {
    expect(webCompatOf(views([direct])[0], ctx()).level).toBe('ok');
  });

  it('codec vidéo absent du navigateur (HEVC) sans serveur : bloquée, avec le codec en motif', () => {
    const c = webCompatOf(views([hevc])[0], ctx());
    expect(c.level).toBe('blocked');
    expect(c.reason).toContain('HEVC');
  });

  it('le même HEVC avec un serveur de streaming (réencodage) : compatible', () => {
    expect(webCompatOf(views([hevc])[0], ctx({ serverUp: true })).level).toBe('ok');
  });

  it('DTS : bloquée', () => {
    const c = webCompatOf(views([dts])[0], ctx());
    expect(c.level).toBe('blocked');
    expect(c.reason).toMatch(/DTS/);
  });

  it('Dolby décodé par l’app : à vérifier, jamais choisie d’office ; hôte refusé : bloquée', () => {
    const v = views([dolby])[0];
    expect(webCompatOf(v, ctx()).level).toBe('check');
    expect(webCompatOf(v, ctx({ rangeDenied: () => true })).level).toBe('blocked');
  });

  it('lecteurs Windows / Android : tout est compatible', () => {
    for (const s of [hevc, dts, dolby]) expect(webCompatOf(views([s])[0], ctx({ web: false })).level).toBe('ok');
  });
});

describe('sélection automatique : seulement les sources compatibles', () => {
  const eligible = (list: SourceView[], c: WebCompatContext) => list.filter((v) => webCompatOf(v, c).level === 'ok');
  const best = mk('Film.2160p.WEB.HEVC.AAC.mkv', { resolution: '2160p', height: 2160, codec: 'HEVC', score: 99 });
  const dts = mk('Film.1080p.BluRay.DTS.mkv', { score: 90 });
  const dolby = mk('Film.1080p.WEB.DDP5.1.mkv', { score: 80 });
  const ok = mk('Film.720p.WEB.AAC.mp4', { resolution: '720p', height: 720, score: 10 });

  it('une source compatible plus faible passe devant le 4K HEVC, le DTS et le Dolby', () => {
    const list = views([best, dts, dolby, ok]);
    const rec = recommend(eligible(list, ctx()), null, 'fr', { preferDirect: true });
    expect(rec?.view.filename).toContain('720p');
  });

  it('aucune compatible : aucune source recommandée (le panneau explique et propose l’app)', () => {
    const list = views([best, dts, dolby]);
    expect(recommend(eligible(list, ctx()), null, 'fr', { preferDirect: true })).toBeNull();
  });

  it('avec un serveur de streaming, le HEVC redevient éligible', () => {
    const list = views([best, ok], false);
    const rec = recommend(eligible(list, ctx({ serverUp: true })), null, 'fr', { preferDirect: true });
    expect(rec).not.toBeNull();
  });
});

describe('détection d’OS et offre de téléchargement', () => {
  it('reconnaît Windows, Android, iOS (dont iPad « Macintosh »), macOS, Linux', () => {
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' })).toBe('windows');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile' })).toBe('android');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari' })).toBe('ios');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', platform: 'MacIntel', maxTouchPoints: 0 })).toBe('macos');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120' })).toBe('linux');
    expect(detectOs({})).toBe('other');
  });

  it('lien de téléchargement sur Windows et Android, message sans lien ailleurs', () => {
    expect(appOffer('windows').link?.href).toBe(APP_DOWNLOAD_URL);
    expect(appOffer('windows').link?.label).toMatch(/Windows/);
    expect(appOffer('android').link?.label).toMatch(/Android/);
    for (const os of ['ios', 'macos', 'linux', 'other'] as const) {
      const o = appOffer(os);
      expect(o.link).toBeNull();
      expect(o.text).toMatch(/Edge|Android/);
    }
  });
});

describe('conteneur non lu par le navigateur (Safari / Firefox : pas de Matroska)', () => {
  const noMkv = { ...plain, formats: ['mp4', 'webm'] };
  const vs = (list: Stream[], c = noMkv) => withWebPlayback(toSourceViews(list), c, { appAudio: true });

  it('MKV en AAC ou en DTS sans serveur : bloquée, avec le format en motif ; avec Matroska ou un serveur : plus de blocage du conteneur', () => {
    for (const name of ['Film.1080p.WEB.AAC.mkv', 'Film.1080p.BluRay.DTS.mkv']) {
      const c = webCompatOf(vs([mk(name)])[0], ctx());
      expect(c.level, name).toBe('blocked');
    }
    expect(webCompatOf(vs([mk('Film.1080p.WEB.AAC.mkv')])[0], ctx()).reason).toContain('MKV');
    expect(webCompatOf(vs([mk('Film.1080p.WEB.AAC.mkv')], plain)[0], ctx()).level).toBe('ok');
    expect(webCompatOf(vs([mk('Film.1080p.WEB.AAC.mkv')])[0], ctx({ serverUp: true })).level).toBe('ok');
  });
});

describe('reprise automatique : failoverCandidates', () => {
  const list = views([mk('Film.1080p.WEB.AAC.mp4'), mk('Film.1080p.BluRay.DTS.mkv'), mk('Film.1080p.WEB.DDP5.1.mkv'), mk('Film.720p.WEB.DDP5.1.mkv')]);
  const [good, dts, dolbyA, dolbyB] = list;

  it('jamais une source bloquée ni « à vérifier » quand la source en cours passe', () => {
    expect(failoverCandidates(list, good, ctx())).toEqual([good]);
  });

  it('source « à vérifier » lancée à la main : ses semblables restent, la bloquée jamais', () => {
    expect(failoverCandidates(list, dolbyA, ctx())).toEqual([good, dolbyA, dolbyB]);
    expect(failoverCandidates(list, dolbyA, ctx())).not.toContain(dts);
  });
});
