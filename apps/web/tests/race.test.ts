import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSION_LABEL, detectCaps, directVideoOk, probeConversion } from '../src/player/engine';
import { pickRaceCandidate } from '../src/player/failover';
import { badSources, BAD_TTL_MS, markBad, sourceKey } from '../src/player/memory';
import { RaceFailure, raceCandidates } from '../src/player/race';
import { hlsQuery } from '../src/player/server';
import { conversionOf } from '../src/sources/direct';
import { toSourceViews, withWebPlayback } from '../src/sources/info';
import { recommend, webRank } from '../src/sources/rank';
import { getLaststream } from '../src/data/stream';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Une préparation que le test termine à la main (ou qui échoue / s'interrompt). */
function job() {
  const j = {
    resolve: (_v: string) => undefined as void,
    reject: (_e: Error) => undefined as void,
    aborted: false,
    started: 0,
    run: (_c: string, signal: AbortSignal) => {
      j.started += 1;
      signal.addEventListener('abort', () => { j.aborted = true; });
      return new Promise<string>((res, rej) => { j.resolve = res; j.reject = rej; });
    },
  };
  return j;
}

describe('course entre candidats : préparation du lien', () => {
  it('la source choisie, prête à temps, gagne sans lancer d’autre candidat', async () => {
    const next = vi.fn(() => 'B');
    const runs: string[] = [];
    const race = raceCandidates<string, string>({ first: 'A', next, run: async (c) => { runs.push(c); return 'plan-' + c; } });
    const win = await race.promise;
    expect(win.candidate).toBe('A');
    expect(win.value).toBe('plan-A');
    expect(runs).toEqual(['A']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(next).not.toHaveBeenCalled();
  });

  it('passé 6 s, le candidat suivant part en parallèle ; le premier prêt gagne, l’autre est interrompu', async () => {
    const jobs: Record<string, ReturnType<typeof job>> = { A: job(), B: job() };
    const progress: Array<[number, boolean]> = [];
    const race = raceCandidates<string, string>({
      first: 'A', next: (tried) => (tried.length === 1 ? 'B' : null), run: (c, s) => jobs[c].run(c, s),
      onProgress: (p) => progress.push([p.attempt, p.slow]),
    });
    await vi.advanceTimersByTimeAsync(5_900);
    expect(jobs.B.started).toBe(0);
    await vi.advanceTimersByTimeAsync(200); // 6,1 s
    expect(jobs.B.started).toBe(1);
    expect(jobs.A.aborted).toBe(false); // la première continue de tourner
    jobs.B.resolve('plan-B');
    const win = await race.promise;
    expect(win.candidate).toBe('B');
    expect(jobs.A.aborted).toBe(true);
    expect(win.lost.map((f) => [f.candidate, f.reason])).toEqual([['A', 'lost']]);
    expect(progress).toEqual([[1, false], [2, true]]);
  });

  it('la première peut encore gagner après le délai doux', async () => {
    const a = job();
    const b = job();
    const race = raceCandidates<string, string>({ first: 'A', next: () => 'B', run: (c, s) => (c === 'A' ? a : b).run(c, s) });
    await vi.advanceTimersByTimeAsync(7_000);
    a.resolve('plan-A');
    expect((await race.promise).candidate).toBe('A');
    expect(b.aborted).toBe(true);
  });

  it('un candidat qui dépasse 12 s est abandonné (échec « trop long ») et le suivant prend le relais', async () => {
    const a = job();
    const b = job();
    const race = raceCandidates<string, string>({ first: 'A', next: (t) => (t.length === 1 ? 'B' : null), run: (c, s) => (c === 'A' ? a : b).run(c, s), maxParallel: 1 });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(a.aborted).toBe(true);
    expect(b.started).toBe(1);
    b.resolve('plan-B');
    const win = await race.promise;
    expect(win.candidate).toBe('B');
    expect(win.failures).toEqual([{ candidate: 'A', reason: 'timeout', message: 'trop long (12 s)' }]);
  });

  it('une erreur lance aussitôt le candidat suivant', async () => {
    const run = vi.fn(async (c: string) => { if (c !== 'C') throw new Error('lien expiré ' + c); return 'plan-' + c; });
    const order = ['B', 'C'];
    const race = raceCandidates<string, string>({ first: 'A', next: () => order.shift() ?? null, run });
    const win = await race.promise;
    expect(win.candidate).toBe('C');
    expect(win.failures.map((f) => f.message)).toEqual(['lien expiré A', 'lien expiré B']);
  });

  it('trois échecs : on s’arrête, avec la raison de chaque source', async () => {
    const order = ['B', 'C', 'D'];
    const race = raceCandidates<string, string>({ first: 'A', next: () => order.shift() ?? null, run: async (c) => { throw new Error('refusée ' + c); } });
    const err = (await race.promise.catch((e: unknown) => e)) as RaceFailure<string>;
    expect(err).toBeInstanceOf(RaceFailure);
    expect(err.kind).toBe('exhausted');
    expect(err.failures.map((f) => f.candidate)).toEqual(['A', 'B', 'C']);
    expect(err.failures.every((f) => f.reason === 'error')).toBe(true);
  });

  it('plus aucun candidat : échec dès que le dernier tombe', async () => {
    const race = raceCandidates<string, string>({ first: 'A', next: () => null, run: async () => { throw new Error('non'); } });
    const err = (await race.promise.catch((e: unknown) => e)) as RaceFailure<string>;
    expect(err.kind).toBe('exhausted');
    expect(err.failures).toHaveLength(1);
  });

  it('25 s au total : abandon de tout ce qui tourne encore', async () => {
    const a = job();
    const b = job();
    const race = raceCandidates<string, string>({ first: 'A', next: (t) => (t.length === 1 ? 'B' : null), run: (c, s) => (c === 'A' ? a : b).run(c, s), hardMs: 60_000 });
    const caught = race.promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(25_100);
    const err = (await caught) as RaceFailure<string>;
    expect(err.kind).toBe('total-timeout');
    expect(a.aborted && b.aborted).toBe(true);
    expect(err.failures.map((f) => f.candidate).sort()).toEqual(['A', 'B']);
  });

  it('au plus deux préparations en parallèle', async () => {
    const jobs = [job(), job(), job()];
    let n = 0;
    const race = raceCandidates<string, string>({ first: 'A', next: () => ['B', 'C'][n++] ?? null, run: (c, s) => jobs['ABC'.indexOf(c)].run(c, s), hardMs: 60_000, totalMs: 60_000 });
    race.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(jobs.map((j) => j.started)).toEqual([1, 1, 0]);
    race.cancel();
  });

  it('« Choisir moi-même » : annulation, tout est interrompu', async () => {
    const a = job();
    const race = raceCandidates<string, string>({ first: 'A', next: () => null, run: (c, s) => a.run(c, s) });
    const caught = race.promise.catch((e: unknown) => e);
    race.cancel();
    expect(((await caught) as RaceFailure<string>).kind).toBe('cancelled');
    expect(a.aborted).toBe(true);
  });
});

describe('sources lentes mémorisées 24 h', () => {
  it('clé : torrent ou lien sans jeton', () => {
    expect(sourceKey({ stream: { infoHash: 'ABCDEF' } })).toBe('h:abcdef');
    expect(sourceKey({ stream: { url: 'https://cdn.example/dl/abc/film.mkv?token=123' } })).toBe('u:https://cdn.example/dl/abc/film.mkv');
  });

  it('mémorisée par titre et épisode, oubliée après 24 h', () => {
    localStorage.clear();
    markBad('tv:1:1:3', 'h:aa', 'trop lente', 1_000);
    expect(badSources('tv:1:1:3', 2_000).get('h:aa')).toBe('trop lente');
    expect(badSources('tv:1:1:4', 2_000).size).toBe(0);
    expect(badSources('tv:1:1:3', 1_000 + BAD_TTL_MS + 1).size).toBe(0);
  });

  it('candidat de la course : même langue, lecture directe, cache ; jamais une source écartée', () => {
    const mk = (over: Record<string, unknown>, top: Record<string, unknown> = {}) => ({ url: 'https://x/' + Math.random().toString(36).slice(2), laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 5000, ...over }, ...top });
    const caps = { formats: ['mp4', 'matroska,webm'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };
    const views = withWebPlayback(toSourceViews([
      mk({ audio: ['DTS'] }), // 0 : en cours, audio à convertir
      mk({ languages: ['en'], audio: ['AAC'] }), // 1 : autre langue
      mk({ codec: 'HEVC', audio: ['AAC'] }), // 2 : réencodage vidéo
      mk({ audio: ['AAC'], cached: false }), // 3 : directe mais pas en cache
      mk({ audio: ['AAC'] }), // 4 : directe et en cache
    ] as never), caps);
    const key = (v: (typeof views)[number]) => sourceKey(v);
    expect(pickRaceCandidate(views, views[0], new Set([0]), new Set(), key)?.index).toBe(4);
    expect(pickRaceCandidate(views, views[0], new Set([0]), new Set([key(views[4])]), key)?.index).toBe(3);
    expect(pickRaceCandidate(views, views[0], new Set([0, 3, 4]), new Set(), key)?.index).toBe(2); // audio du même type avant l'autre langue
    expect(pickRaceCandidate(views, views[0], new Set([0, 1, 2, 3, 4]), new Set(), key)).toBeNull();
  });
});

describe('paramètres de codecs du serveur : remux plutôt que réencodage', () => {
  const canPlay = (ok: RegExp) => (mime: string) => (ok.test(mime) ? 'probably' : '');

  it('la requête HLS annonce les vrais codecs du navigateur', () => {
    const caps = detectCaps(canPlay(/avc1|hvc1|mp4a|ec-3|opus/), { chromium: true, maxChannels: 6 });
    expect(caps.videoCodecs).toEqual(['h264', 'h265', 'hevc']);
    expect(caps.audioCodecs).toEqual(['aac', 'eac3', 'opus']);
    const q = new URLSearchParams(hlsQuery('http://x/a.mkv', caps));
    expect(q.getAll('videoCodecs')).toEqual(['h264', 'h265', 'hevc']);
    expect(q.getAll('audioCodecs')).toEqual(['aac', 'eac3', 'opus']);
    expect(q.get('maxAudioChannels')).toBe('6');
    expect(q.get('forceTranscoding')).toBeNull();
    expect(new URLSearchParams(hlsQuery('http://x/a.mkv', caps, true)).get('forceTranscoding')).toBe('1');
  });

  it('HEVC : annoncé seulement si le navigateur le décode', () => {
    expect(detectCaps(canPlay(/avc1|mp4a/), { chromium: true, maxChannels: 2 }).videoCodecs).toEqual(['h264']);
    expect(detectCaps(canPlay(/hev1\.1\.6\.L150/), { chromium: false, maxChannels: 2 }).videoCodecs).toContain('hevc');
  });

  const probe = (video: string, audio: string, channels = 2) => ({ format: { name: 'matroska,webm' }, streams: [{ track: 'video', codec: video }, { track: 'audio', codec: audio, channels }] as never });
  const caps = { formats: ['mp4', 'matroska,webm'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };

  it('nature de la conversion pour une session HLS', () => {
    expect(probeConversion(probe('h264', 'aac'), caps)).toBe('none');
    expect(probeConversion(probe('h264', 'dts', 6), caps)).toBe('audio');
    expect(probeConversion(probe('h264', 'aac', 6), caps)).toBe('audio'); // trop de canaux : mixage
    expect(probeConversion(probe('hevc', 'aac'), caps)).toBe('video');
    expect(probeConversion(probe('h264', 'aac'), caps, true)).toBe('video'); // transcodage forcé
    expect(probeConversion(null, caps)).toBe('unknown');
    expect(CONVERSION_LABEL.audio).toBe('Conversion audio seulement');
    expect(CONVERSION_LABEL.video).toContain('réencodage');
  });

  it('démarrage rapide : la vidéo passe telle quelle, seul l’audio demande le transcodage', () => {
    expect(directVideoOk(probe('h264', 'aac'), caps)).toBe(true);
    expect(directVideoOk(probe('h264', 'dts', 6), caps)).toBe(false); // aucune piste audio lisible
    expect(directVideoOk({ ...probe('h264', 'aac'), streams: [...probe('h264', 'aac').streams, { track: 'audio', codec: 'dts', channels: 6 }] as never }, caps)).toBe(true);
    expect(directVideoOk(probe('hevc', 'aac'), caps)).toBe(false);
    expect(directVideoOk(null, caps)).toBe(false);
  });

  const mk = (over: Record<string, unknown>, hints: Record<string, unknown> = {}) => ({ url: 'https://x/play/abc', behaviorHints: hints, laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 5000, ...over } });

  it('source : audio seul (léger) ou vidéo (lent)', () => {
    const c = (s: ReturnType<typeof mk>) => conversionOf(s as never, getLaststream(s), caps);
    expect(c(mk({ audio: ['AAC'] }, { filename: 'a.mkv' }))).toBe('none');
    expect(c(mk({ audio: ['DTS'] }))).toBe('audio');
    expect(c(mk({ audio: ['AAC'] }, { filename: 'a.avi' }))).toBe('audio'); // conteneur seul : remux
    expect(c(mk({ source: 'REMUX', audio: ['TrueHD'] }, { filename: 'a.REMUX.mkv' }))).toBe('audio');
    expect(c(mk({ codec: 'HEVC', audio: ['AAC'] }))).toBe('video');
  });

  it('classement navigateur : un réencodage vidéo passe bien après une conversion audio', () => {
    const views = withWebPlayback(toSourceViews([
      mk({ resolution: '2160p', score: 95, codec: 'HEVC', audio: ['AAC'], estBitrateKbps: 30_000 }), // réencodage vidéo
      mk({ resolution: '1080p', score: 70, codec: 'AVC', audio: ['DTS'], estBitrateKbps: 9000 }), // audio seulement
      mk({ resolution: '720p', score: 40, codec: 'AVC', audio: ['AAC'], estBitrateKbps: 3000 }, { filename: 'a.mp4' }), // direct
    ] as never), caps);
    expect(views.map((v) => v.convert)).toEqual(['video', 'audio', null]);
    expect(views.map(webRank)).toEqual([0, 1, 1]); // 4K réencodé : -3 crans ; 1080p audio : -1 ; 720p direct : 0
    // À rang égal, la lecture directe l'emporte ; le 4K à réencoder ne passe jamais devant.
    expect(recommend(views, 100_000, 'fr', { preferDirect: true })!.view.index).toBe(2);
    // Un 1080p avec simple conversion audio bat un SD direct.
    const sd = withWebPlayback(toSourceViews([
      mk({ resolution: 'SD', height: 480, score: 30, codec: 'AVC', audio: ['AAC'], estBitrateKbps: 1500 }, { filename: 'a.mp4' }),
      mk({ resolution: '1080p', score: 70, codec: 'AVC', audio: ['DTS'], estBitrateKbps: 9000 }),
    ] as never), caps);
    expect(recommend(sd, 100_000, 'fr', { preferDirect: true })!.view.index).toBe(1);
  });
});
