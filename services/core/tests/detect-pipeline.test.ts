import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAutoDetector } from '../src/lt/detect/index.js';
import { runProcess } from '../src/lt/detect/proc.js';
import { locateTools, type MediaTools } from '../src/lt/detect/tools.js';
import { openUserDb } from '../src/user/db.js';
import { SkipSegmentStore } from '../src/user/skip-segments.js';
import { episodeAudio, ffmpegSync, type FileServer, serveDir, writeChapters, writeWav } from './detect-fixtures.js';
import { fakeLookup, json, mockUpstream, postJson, startApp, tokenFor, type RunningApp } from './lt-harness.js';

const tools = await locateTools();
const RATE = 11025;
const THEME = 7;
const TOKEN = 'SECRETTOKEN123';

let dir: string;
let server: FileServer;

/** Fichiers : trois épisodes de 400 s partageant un thème de 40 s (à 20, 35 et 10 s), chapitres, noir de fin. */
beforeAll(() => {
  if (tools === undefined) return;
  dir = mkdtempSync(join(tmpdir(), 'lastaddon-detect-'));
  const episode = (name: string, themeAt: number, seed: number, gain: number): void => {
    const wav = join(dir, `${name}.wav`);
    writeWav(wav, episodeAudio([{ content: seed, seconds: themeAt }, { theme: THEME, seconds: 40 }, { content: seed + 100, seconds: 400 - themeAt - 40 }], RATE, gain, seed), RATE);
    ffmpegSync(tools.ffmpeg, ['-i', wav, '-c:a', 'aac', '-b:a', '48k', join(dir, `${name}.mka`)]);
  };
  episode('ep1', 20, 1, 1);
  episode('ep2', 35, 2, 0.7);
  episode('ep3', 10, 3, 0.85);
  // Chapitres : prologue, ouverture, épisode, générique de fin.
  const chapterWav = join(dir, 'chapters.wav');
  writeWav(chapterWav, episodeAudio([{ content: 40, seconds: 130 }], RATE), RATE);
  writeChapters(join(dir, 'chapters.txt'), [
    { title: 'Prologue', start: 0, end: 20 },
    { title: 'Opening', start: 20, end: 50 },
    { title: 'Episode', start: 50, end: 100 },
    { title: 'Générique de fin', start: 100, end: 130 },
  ]);
  ffmpegSync(tools.ffmpeg, ['-i', chapterWav, '-i', join(dir, 'chapters.txt'), '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', join(dir, 'chapters.mkv')]);
  // Fichier unique : 100 s d'image puis 50 s de noir, avec musique.
  const creditsWav = join(dir, 'credits.wav');
  writeWav(creditsWav, episodeAudio([{ content: 41, seconds: 150 }], RATE), RATE);
  ffmpegSync(tools.ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=s=96x72:r=5:d=100', '-f', 'lavfi', '-i', 'color=c=black:s=96x72:r=5:d=50', '-i', creditsWav,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
    join(dir, 'credits.mkv'),
  ]);
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const local = (url: URL): boolean => url.hostname === '127.0.0.1';
const mediaUrl = (name: string): URL => new URL(`${server.base}/${name}?token=${TOKEN}`);

function detectorFor(store: SkipSegmentStore, media: MediaTools, extra: { byteBudget?: number } = {}) {
  let clock = Date.UTC(2026, 0, 1);
  const detector = createAutoDetector(() => store, { tools: media, allowLocal: local, now: () => new Date(clock), ...extra });
  return {
    detector,
    /** Fait avancer l'horloge (débit : 2 jobs par minute). */
    tick: () => {
      clock += 61_000;
    },
  };
}

const target = (imdbId: string, episode: number) => ({ type: 'series' as const, imdbId, season: 1, episode });

describe.skipIf(tools === undefined)('détection locale (ffmpeg réel, serveur HTTP local)', () => {
  beforeAll(async () => {
    server = await serveDir(dir);
  });

  it('1. chapitres : intro et générique exacts, confiance 0,95, aucune URL dans les journaux', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((name) => vi.spyOn(console, name));
    const store = new SkipSegmentStore(openUserDb(':memory:'));
    const { detector } = detectorFor(store, tools!);
    const result = await detector.report({ target: target('tt1000001', 1), url: mediaUrl('chapters.mkv'), duration: 130 });
    expect(result).toEqual({ queued: true });
    expect(detector.analyzing(target('tt1000001', 1))).toBe(true);
    await detector.idle();
    expect(detector.analyzing(target('tt1000001', 1))).toBe(false);
    const segments = store.autoSegmentsFor('tt1000001', 1, 1);
    expect(segments.map(({ kind, start, end, confidence, method }) => ({ kind, start, end, confidence, method }))).toEqual([
      { kind: 'intro', start: 20, end: 50, confidence: 0.95, method: 'chapters' },
      { kind: 'credits', start: 100, end: 130, confidence: 0.95, method: 'chapters' },
    ]);
    // Déjà connu : pas de nouveau job.
    expect(await detector.report({ target: target('tt1000001', 1), url: mediaUrl('chapters.mkv'), duration: 130 })).toEqual({ queued: false, reason: 'known' });
    const written = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
    expect(written).not.toContain(TOKEN);
    spies.forEach((spy) => spy.mockRestore());
    await detector.close();
  }, 60_000);

  describe.each([
    ['Chromaprint (ffmpeg)', tools?.chromaprint === true ? tools : undefined, 'tt1000010'],
    ['empreinte spectrale interne', tools === undefined ? undefined : { ...tools, chromaprint: false }, 'tt1000011'],
  ])('2. empreinte audio entre épisodes : %s', (_label, media, imdb) => {
    it.skipIf(media === undefined)('appariement de deux épisodes puis propagation à un troisième', async () => {
      const store = new SkipSegmentStore(openUserDb(':memory:'));
      const { detector, tick } = detectorFor(store, media!);
      // Un seul épisode connu : rien à comparer, on attend.
      await detector.report({ target: target(imdb, 1), url: mediaUrl('ep1.mka'), duration: 400 });
      await detector.idle();
      expect(store.autoSegmentsFor(imdb, 1, 1)).toEqual([]);
      // Un deuxième épisode : appariement, résultats pour les deux.
      tick();
      expect(await detector.report({ target: target(imdb, 2), url: mediaUrl('ep2.mka'), duration: 400 })).toEqual({ queued: true });
      await detector.idle();
      const intro = (episode: number) => store.autoSegmentsFor(imdb, 1, episode).find((segment) => segment.kind === 'intro');
      console.log(`[${media!.chromaprint ? 'chromaprint' : 'spectral'}] ep1 intro`, intro(1), 'ep2 intro', intro(2));
      expect(Math.abs((intro(1)?.start ?? -9) - 20)).toBeLessThan(1.5);
      expect(Math.abs((intro(1)?.end ?? -9) - 60)).toBeLessThan(1.5);
      expect(Math.abs((intro(2)?.start ?? -9) - 35)).toBeLessThan(1.5);
      expect(Math.abs((intro(2)?.end ?? -9) - 75)).toBeLessThan(1.5);
      expect(intro(1)?.confidence).toBe(0.8);
      expect(intro(1)?.method).toBe('fingerprint');
      expect(store.fingerprintsFor(imdb, 1, media!.chromaprint ? 'chromaprint' : 'spectral').map((fp) => fp.kind)).toEqual(['intro']);
      // Troisième épisode : reconnu avec la seule empreinte de la saison.
      tick();
      await detector.report({ target: target(imdb, 3), url: mediaUrl('ep3.mka'), duration: 400 });
      await detector.idle();
      expect(Math.abs((intro(3)?.start ?? -9) - 10)).toBeLessThan(1.5);
      expect(Math.abs((intro(3)?.end ?? -9) - 50)).toBeLessThan(1.5);
      await detector.close();
    }, 120_000);
  });

  it('3. fichier unique : générique de fin par noir et silence (confiance ≥ 0,6)', async () => {
    const store = new SkipSegmentStore(openUserDb(':memory:'));
    const { detector } = detectorFor(store, tools!);
    await detector.report({ target: { type: 'movie', imdbId: 'tt1000020', season: 0, episode: 0 }, url: mediaUrl('credits.mkv'), duration: 150 });
    await detector.idle();
    const [credits] = store.autoSegmentsFor('tt1000020', 0, 0);
    expect(credits?.kind).toBe('credits');
    expect(credits?.method).toBe('blackdetect');
    expect(credits?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(Math.abs((credits?.start ?? 0) - 100)).toBeLessThan(2);
    expect(credits?.end).toBe(150);
    await detector.close();
  }, 60_000);

  it('4. budget d’octets : la lecture est coupée, rien n’est enregistré', async () => {
    const before = server.served();
    const store = new SkipSegmentStore(openUserDb(':memory:'));
    const { detector } = detectorFor(store, tools!, { byteBudget: 150_000 });
    await detector.report({ target: target('tt1000030', 1), url: mediaUrl('ep1.mka'), duration: 400 });
    await detector.idle();
    expect(store.autoSegmentsFor('tt1000030', 1, 1)).toEqual([]);
    expect(server.served() - before).toBeLessThan(150_000 + 600_000);
    await detector.close();
  }, 60_000);

  it('5. débit : au plus 2 jobs par minute', async () => {
    const store = new SkipSegmentStore(openUserDb(':memory:'));
    const { detector, tick } = detectorFor(store, tools!);
    const send = (episode: number) => detector.report({ target: target('tt1000040', episode), url: mediaUrl('ep1.mka'), duration: 400 });
    expect((await send(1)).queued).toBe(true);
    expect((await send(2)).queued).toBe(true);
    expect(await send(3)).toEqual({ queued: false, reason: 'rate_limited' });
    tick();
    expect((await send(3)).queued).toBe(true);
    await detector.close();
  }, 120_000);

  describe('6. route POST /skip/analyze et drapeau analyzing', () => {
    let app: RunningApp;
    let strict: RunningApp;
    const config = tokenFor({});
    const imdb = 'tt1000050';
    beforeAll(async () => {
      const upstream = mockUpstream({
        'https://api.introdb.app/segments': (call) =>
          json({
            intro: call.url.searchParams.get('imdb_id') === 'tt1000051' ? { start_sec: 5, end_sec: 70, confidence: 1, submission_count: 3 } : null,
            recap: null,
            outro: null,
            post_credits: null,
          }),
        'https://api.skipdb.tv/api/segments': () => json({ error: 'not found' }, 404),
        'https://arm.haglund.dev/api/v2/imdb': () => json({ error: 'not found' }, 404),
      });
      app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), skipDetect: { tools: tools!, allowLocal: local } });
      strict = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), skipDetect: { tools: tools!, byteBudget: 1000 } });
    });
    afterAll(async () => {
      await app.close();
      await strict.close();
    });
    const analyze = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/${config}/lt/skip/analyze`, postJson(body));
    const body = (overrides: Record<string, unknown> = {}) => ({
      type: 'series', imdbId: imdb, season: 1, episode: 1, mediaUrl: `${server.base}/chapters.mkv?token=${TOKEN}`, duration: 130, ...overrides,
    });

    it.each([
      ['URL privée', { mediaUrl: 'http://192.168.1.10/film.mkv' }],
      ['schéma file', { mediaUrl: 'file:///etc/passwd' }],
      ['boucle locale hors 11470', { mediaUrl: 'http://127.0.0.1:8080/x' }],
      ['localhost', { mediaUrl: 'http://localhost:11470/x' }],
      ['identifiants dans l’URL', { mediaUrl: 'https://user:pass@example.com/x.mkv' }],
      ['URL absente', { mediaUrl: undefined }],
      ['durée absente', { duration: undefined }],
      ['durée trop courte', { duration: 10 }],
      ['épisode 0 pour une série', { episode: 0 }],
    ])('refuse (400) : %s', async (_label, overrides) => {
      const res = await fetch(`${strict.baseUrl}/${config}/lt/skip/analyze`, postJson(body(overrides)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_analyze' });
    });

    it('accepte le serveur de streaming local 127.0.0.1:11470 (politique par défaut)', async () => {
      const res = await fetch(`${strict.baseUrl}/${config}/lt/skip/analyze`, postJson(body({ mediaUrl: 'http://127.0.0.1:11470/hlsv2/x/video.mkv' })));
      expect(res.status).toBe(202);
    });

    it('accepte un média, signale analyzing puis renvoie les chapitres', async () => {
      const res = await analyze(body());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ queued: true });
      const get = () => fetch(`${app.baseUrl}/${config}/lt/skip/series/${imdb}/1/1`);
      const first = await get();
      const firstBody = (await first.json()) as { analyzing?: boolean };
      expect(firstBody.analyzing === true || first.status === 200).toBe(true);
      let result: { segments: { kind: string; source: string; confidence: number; method: string }[]; analyzing?: boolean } = { segments: [] };
      for (let attempt = 0; attempt < 60 && result.segments.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = (await (await get()).json()) as typeof result;
      }
      expect(result.segments.map((s) => [s.kind, s.source, s.confidence, s.method])).toEqual([
        ['intro', 'auto', 0.95, 'chapters'],
        ['credits', 'auto', 0.95, 'chapters'],
      ]);
      expect(result.analyzing).toBeUndefined();
    }, 60_000);

    it('priorité : la base externe garde l’intro, la détection locale complète le générique', async () => {
      const other = 'tt1000051';
      const res = await analyze(body({ imdbId: other }));
      expect(res.status).toBe(202);
      let result: { segments: { kind: string; source: string; start: number }[] } = { segments: [] };
      for (let attempt = 0; attempt < 60 && result.segments.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = (await (await fetch(`${app.baseUrl}/${config}/lt/skip/series/${other}/1/1`)).json()) as typeof result;
      }
      expect(result.segments.map((segment) => [segment.kind, segment.source, segment.start])).toEqual([
        ['intro', 'introdb', 5],
        ['credits', 'auto', 100],
      ]);
    }, 60_000);
  });
});

describe('processus', () => {
  it('tue le processus au délai', async () => {
    const started = Date.now();
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 400 });
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('tue le processus quand la sortie dépasse le plafond', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => process.stdout.write("x".repeat(100000)), 10)'], {
      timeoutMs: 10_000,
      maxStdout: 50_000,
    });
    expect(result.killed).toBe(true);
  });
});
