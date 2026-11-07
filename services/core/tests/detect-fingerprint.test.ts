import { describe, expect, it } from 'vitest';
import { classifyChapterTitle, segmentsFromChapters } from '../src/lt/detect/chapters.js';
import { parseCreditsOutput } from '../src/lt/detect/credits.js';
import {
  chromaprintFingerprint,
  type Fingerprint,
  ITEM_SECONDS,
  longestRun,
  pointSeconds,
  RATE,
  snapToSilence,
  spectralFingerprint,
} from '../src/lt/detect/fingerprint.js';
import { validateMediaUrl } from '../src/lt/detect/media-url.js';
import { locateTools } from '../src/lt/detect/tools.js';
import { episodeAudio, toPcm16 } from './detect-fixtures.js';

const tools = await locateTools();

/** Deux épisodes de 150 s : thème de 45 s à 30 s dans A, à 55 s dans B ; gain et bruit différents. */
const THEME = 7;
const episodeA = toPcm16(episodeAudio([{ content: 1, seconds: 30 }, { theme: THEME, seconds: 45 }, { content: 2, seconds: 75 }], RATE, 1, 5));
const episodeB = toPcm16(episodeAudio([{ content: 3, seconds: 55 }, { theme: THEME, seconds: 45 }, { content: 4, seconds: 50 }], RATE, 0.6, 6));
const other = toPcm16(episodeAudio([{ content: 8, seconds: 150 }], RATE, 0.8, 7));

function check(a: Fingerprint, b: Fingerprint): void {
  const run = longestRun(a, b, Math.ceil(15 / ITEM_SECONDS));
  expect(run).toBeDefined();
  const aStart = pointSeconds(a.method, run?.aStart ?? 0);
  const bStart = pointSeconds(b.method, run?.bStart ?? 0);
  const seconds = pointSeconds(a.method, (run?.aStart ?? 0) + (run?.length ?? 0), 'end') - aStart;
  console.log(`[${a.method}] A=${aStart.toFixed(2)} B=${bStart.toFixed(2)} len=${seconds.toFixed(2)}`);
  expect(Math.abs(aStart - 30)).toBeLessThan(0.6);
  expect(Math.abs(bStart - 55)).toBeLessThan(0.6);
  expect(Math.abs(seconds - 45)).toBeLessThan(1);
}

describe('empreinte spectrale interne', () => {
  it('retrouve le thème partagé entre deux épisodes (positions et durée)', () => {
    check(spectralFingerprint(episodeA), spectralFingerprint(episodeB));
  });

  it('ne trouve rien entre deux épisodes sans thème commun', () => {
    const run = longestRun(spectralFingerprint(episodeA), spectralFingerprint(other), Math.ceil(15 / ITEM_SECONDS));
    expect(run).toBeUndefined();
  });

  it('ignore le silence numérique (empreintes identiques mais non audibles)', () => {
    const silent = spectralFingerprint(new Int16Array(RATE * 60));
    expect(longestRun(silent, silent, 20)).toBeUndefined();
  });
});

describe.skipIf(tools === undefined || !tools.chromaprint)('empreinte Chromaprint (ffmpeg)', () => {
  it('retrouve le thème partagé entre deux épisodes', async () => {
    const [a, b] = await Promise.all([chromaprintFingerprint(tools!, episodeA), chromaprintFingerprint(tools!, episodeB)]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    check(a!, b!);
  });

  it('ne trouve rien entre deux épisodes sans thème commun', async () => {
    const [a, b] = await Promise.all([chromaprintFingerprint(tools!, episodeA), chromaprintFingerprint(tools!, other)]);
    expect(longestRun(a!, b!, Math.ceil(15 / ITEM_SECONDS))).toBeUndefined();
  });
});

describe('affinage aux silences', () => {
  it('cale une borne sur le silence proche', () => {
    const audio = toPcm16(episodeAudio([{ content: 1, seconds: 10 }, { silence: 0.5 }, { content: 2, seconds: 10 }], RATE, 1, 5));
    audio.fill(0, 10 * RATE, Math.round(10.5 * RATE));
    expect(Math.abs(snapToSilence(audio, 9.2) - 10.25)).toBeLessThan(0.3);
    // Pas de silence franc à moins de 2 s : la borne ne bouge pas.
    expect(snapToSilence(audio, 3)).toBe(3);
  });
});

describe('chapitres', () => {
  it.each([
    ['Intro', 'intro'],
    ['Opening', 'intro'],
    ['OP', 'intro'],
    ['OP1', 'intro'],
    ['Générique d’ouverture', 'intro'],
    ['Ouverture', 'intro'],
    ['Opening Credits', 'intro'],
    ['オープニング', 'intro'],
    ['Recap', 'recap'],
    ['Résumé', 'recap'],
    ['Previously on', 'recap'],
    ['Précédemment', 'recap'],
    ['前回のあらすじ', 'recap'],
    ['Ending', 'credits'],
    ['ED', 'credits'],
    ['Credits', 'credits'],
    ['Générique de fin', 'credits'],
    ['エンディング', 'credits'],
    ['Preview', 'preview'],
    ['Avant-première', 'preview'],
    ['Next Episode', 'preview'],
    ['次回予告', 'preview'],
    ['Générique', 'bare'],
    ['Prologue', undefined],
    ['Cold Open', undefined],
    ['Chapter 3', undefined],
    ['Scene 1', undefined],
  ])('%s -> %s', (title, kind) => {
    expect(classifyChapterTitle(title)).toBe(kind);
  });

  it('place un « Générique » seul selon sa position', () => {
    const chapters = [
      { start: 0, end: 60, title: 'Générique' },
      { start: 60, end: 1300, title: 'Episode' },
      { start: 1300, end: 1400, title: 'Générique' },
    ];
    expect(segmentsFromChapters(chapters, 1400)).toEqual([
      { kind: 'intro', start: 0, end: 60 },
      { kind: 'credits', start: 1300, end: 1400 },
    ]);
  });
});

describe('noir et silence de fin', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 80.5',
    '[silencedetect @ 0x1] silence_end: 82.0 | silence_duration: 1.5',
    '[blackdetect @ 0x2] black_start:40.04 black_end:75 black_duration:34.96',
  ].join('\n');

  it('retient une longue zone noire qui va jusqu’à la fin, avec de la musique', () => {
    expect(parseCreditsOutput(stderr, 75)).toEqual({ start: 40.04, confidence: 0.7 });
  });

  it('refuse une zone noire courte ou qui n’atteint pas la fin', () => {
    expect(parseCreditsOutput('black_start:10 black_end:20', 75)).toBeUndefined();
    expect(parseCreditsOutput('black_start:10 black_end:50', 75)).toBeUndefined();
    expect(parseCreditsOutput('', 75)).toBeUndefined();
  });
});

describe('URL de média', () => {
  it.each([
    ['https://cdn.example.com/f.mkv?t=abc', true],
    ['http://203.0.113.5/x', false], // documentation : non publique
    ['http://8.8.8.8/x.mkv', true],
    ['http://127.0.0.1:11470/hls/abc/video', true],
    ['http://127.0.0.1:8080/x', false],
    ['http://localhost:11470/x', false],
    ['http://192.168.1.5/x', false],
    ['http://10.0.0.2/x', false],
    ['http://[::1]/x', false],
    ['file:///etc/passwd', false],
    ['ftp://example.com/x', false],
    ['https://user:pass@example.com/x', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => {
    expect(validateMediaUrl(url) !== null).toBe(ok);
  });
});
