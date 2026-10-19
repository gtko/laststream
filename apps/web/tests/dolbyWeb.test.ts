import { describe, expect, it } from 'vitest';
import { detectCaps } from '../src/player/engine';
import { browserPlaysAudio, chooseAudioPlan, type AudioPlanInput } from '../src/player/webaudio/policy';
import { appAudioOf } from '../src/sources/direct';
import { toSourceViews, withWebPlayback } from '../src/sources/info';
import { recommend } from '../src/sources/rank';
import { getLaststream, type Stream } from '../src/data/stream';

/* Dolby (AC-3 / E-AC-3) dans le navigateur : détection native (Edge sous Windows, Safari), pas de repli ni de badge « sans son »
 * quand le navigateur le décode lui-même, et préférence AAC / Opus à résolution proche quand il ne le décode pas. */

const ALL_AUDIO = ['aac', 'mp3', 'opus', 'flac', 'vorbis'];
/** Navigateur sans Dolby natif (Chrome / Firefox tels que le repli les suppose). */
const plain = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ALL_AUDIO, maxAudioChannels: 6 };
/** Edge sous Windows / Safari : le Dolby est annoncé et lu. */
const edge = { ...plain, audioCodecs: [...ALL_AUDIO, 'eac3', 'ac3'], dolbyNative: true };

describe('détection du Dolby natif', () => {
  const canPlay = (yes: RegExp) => (mime: string): string => (yes.test(mime) ? 'probably' : '');

  it('annoncé pour E-AC-3 ou pour AC-3 : navigateur Dolby natif', () => {
    expect(detectCaps(canPlay(/ec-3/), { chromium: true, maxChannels: 2 }).dolbyNative).toBe(true);
    expect(detectCaps(canPlay(/ac-3/), { chromium: false, maxChannels: 2 }).dolbyNative).toBe(true);
  });

  it('rien d’annoncé : pas de Dolby natif, et les autres codecs ne bougent pas', () => {
    const c = detectCaps(canPlay(/avc1|mp4a/), { chromium: true, maxChannels: 2 });
    expect(c.dolbyNative).toBe(false);
    expect(c.audioCodecs).toEqual(['aac']);
  });
});

describe('Dolby natif : pas de repli audio tant que le navigateur le lit', () => {
  const base: AudioPlanInput = {
    web: true, hls: false, url: 'https://h.example/f.mkv', codec: 'eac3', container: 'Matroska', caps: edge, appCanDecode: true, range: 'ok',
  };

  it('E-AC-3 en Matroska : lu par le navigateur quand il annonce Dolby', () => {
    expect(browserPlaysAudio('eac3', 'Matroska', edge)).toBe(true);
    expect(chooseAudioPlan(base).mode).toBe('native');
  });

  it('sans Dolby natif, Matroska reste confié à l’app (règle inchangée)', () => {
    const withEac3 = { audioCodecs: [...ALL_AUDIO, 'eac3'] };
    expect(browserPlaysAudio('eac3', 'Matroska', withEac3)).toBe(false);
    expect(chooseAudioPlan({ ...base, caps: withEac3 }).mode).toBe('app');
  });

  it('le navigateur ment (aucun octet décodé) : la décision bascule sur l’app', () => {
    expect(chooseAudioPlan({ ...base, nativeSilent: true }).mode).toBe('app');
  });

  it('5.1 sur sortie stéréo (conversion audio seule) : le badge « décodé par l’app » n’apparaît que sans Dolby natif', () => {
    const name = 'Film.1080p.WEB.DDP5.1.mkv';
    const stream: Stream = {
      url: 'https://x/play/' + name, behaviorHints: { filename: name },
      laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, channels: '5.1' },
    };
    const info = getLaststream(stream);
    const stereo = { ...plain, maxAudioChannels: 2 };
    expect(appAudioOf(stream, info, stereo)).toBe('app');
    expect(appAudioOf(stream, info, { ...stereo, audioCodecs: [...ALL_AUDIO, 'eac3'], dolbyNative: true })).toBeNull();
  });
});

describe('web sans Dolby natif : source AAC / Opus de résolution proche avant une source Dolby', () => {
  const mk = (over: Record<string, unknown>, filename: string): Stream => ({
    url: 'https://x/play/' + filename,
    behaviorHints: { filename },
    laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, ...over },
  });
  const rank = (list: Stream[], caps: typeof plain, preferAac: boolean, preferred: 'fr' | 'en' = 'fr') =>
    recommend(withWebPlayback(toSourceViews(list), caps, { appAudio: true }), null, preferred, { preferDirect: true, preferAac })!;

  // Dolby 1080p (mkv, décodé par l’app), AAC 1080p (avi, conversion audio : même rang web), AAC 480p (lecture directe).
  const dolby = mk({ resolution: '1080p', height: 1080, score: 90 }, 'Film.1080p.WEB.DDP5.1.mkv');
  const aac1080 = mk({ resolution: '1080p', height: 1080, score: 60 }, 'Film.1080p.WEB.AAC.avi');

  it('à qualité égale, l’AAC passe devant le Dolby ; sans préférence, le mieux noté reste en tête', () => {
    expect(rank([dolby, aac1080], plain, false).view.index).toBe(0);
    const pref = rank([dolby, aac1080], plain, true);
    expect(pref.view.index).toBe(1);
    expect(pref.reason).toContain('son AAC plutôt que Dolby');
  });

  it('un cran plus bas au plus : 720p AAC devant 1080p Dolby, jamais en dessous de 720p', () => {
    const aac720 = mk({ resolution: '720p', height: 720, score: 40 }, 'Film.720p.WEB.AAC.avi');
    expect(rank([dolby, aac720], plain, true).view.index).toBe(1);
    const sd = mk({ resolution: '480p', height: 480, score: 99 }, 'Film.480p.WEB.AAC.mp4');
    expect(rank([dolby, sd], plain, true).view.index).toBe(0);
  });

  it('la langue prime : une AAC en VO ne remplace pas la VF en Dolby', () => {
    const vo = mk({ resolution: '1080p', height: 1080, score: 60, languages: ['en'] }, 'Film.1080p.WEB.AAC.avi');
    expect(rank([dolby, vo], plain, true, 'fr').view.index).toBe(0);
  });

  it('navigateur avec Dolby natif : pas de préférence, le classement web reste celui d’avant', () => {
    expect(rank([dolby, aac1080], edge, false).view.index).toBe(0);
  });
});
