import { describe, expect, it, vi } from 'vitest';
import {
  DRIFT_RESYNC_S, aheadSeconds, driftSeconds, driftVerdict, mappedMedia, needsRecalibration, placeChunk, readyToPlay, underrun, whenFor, type Anchor,
} from '../src/player/webaudio/timing';
import {
  NOTE_CORS, NOTE_DTS, browserPlaysAudio, chooseAudioPlan, chooseAudioPlanBlind, nativeAudioSilent, pickReadableAlternative, probeRange, readableCaps,
  type AudioPlanInput,
} from '../src/player/webaudio/policy';
import { PrefetchReader } from '../src/player/webaudio/reader';
import { appAudioOf } from '../src/sources/direct';
import { toSourceViews, withWebPlayback } from '../src/sources/info';
import { recommend } from '../src/sources/rank';
import { getLaststream, type Stream } from '../src/data/stream';

const caps = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3', 'opus', 'flac', 'vorbis'], maxAudioChannels: 6 };

describe('horloge audio : ancre, dérive, recalage à 80 ms', () => {
  const a: Anchor = { media: 10, ctx: 100, rate: 1 };

  it('position jouée et instant de départ d’un segment', () => {
    expect(mappedMedia(a, 102)).toBeCloseTo(12, 9);
    expect(whenFor(a, 12.5)).toBeCloseTo(102.5, 9);
    expect(whenFor(a, 12.5, 0.04)).toBeCloseTo(102.46, 9);
    expect(whenFor({ ...a, rate: 2 }, 12)).toBeCloseTo(101, 9);
    expect(mappedMedia({ ...a, rate: 2 }, 101)).toBeCloseTo(12, 9);
  });

  it('dérive positive quand l’audio est en avance sur la vidéo', () => {
    expect(driftSeconds(a, 102, 11.9)).toBeCloseTo(0.1, 9);
    expect(driftSeconds(a, 102, 12.1)).toBeCloseTo(-0.1, 9);
  });

  it('recalage strictement au-delà de 80 ms', () => {
    expect(DRIFT_RESYNC_S).toBe(0.08);
    expect(needsRecalibration(0.08)).toBe(false);
    expect(needsRecalibration(0.081)).toBe(true);
    expect(needsRecalibration(-0.081)).toBe(true);
    expect(needsRecalibration(0.05)).toBe(false);
  });

  it('anti-rebond : deux relevés de suite, ou un écart franc (> 250 ms)', () => {
    expect(driftVerdict(0.1, 0)).toEqual({ strikes: 1, resync: false });
    expect(driftVerdict(0.1, 1)).toEqual({ strikes: 0, resync: true });
    expect(driftVerdict(0.3, 0)).toEqual({ strikes: 0, resync: true });
    expect(driftVerdict(0.02, 1)).toEqual({ strikes: 0, resync: false });
  });

  it('tampon : prêt à 3 s ou en fin de flux, vide sous 0,25 s sauf en fin de flux', () => {
    expect(aheadSeconds(15, 10)).toBe(5);
    expect(aheadSeconds(9, 10)).toBe(0);
    expect(aheadSeconds(Number.NEGATIVE_INFINITY, 10)).toBe(0);
    expect(readyToPlay(2.9, false)).toBe(false);
    expect(readyToPlay(3, false)).toBe(true);
    expect(readyToPlay(0, true)).toBe(true);
    expect(underrun(0.2, false)).toBe(true);
    expect(underrun(0.3, false)).toBe(false);
    expect(underrun(0, true)).toBe(false);
  });

  it('segments jointifs : le suivant démarre exactement à la fin du précédent', () => {
    const first = placeChunk({ ts: 10, duration: 0.032, anchor: a, ctxNow: 99, prev: null });
    expect(first).toEqual({ kind: 'start', when: 100, offset: 0, gap: 0 });
    const prev = { mediaEnd: 10.032, whenEnd: 100.032 };
    const next = placeChunk({ ts: 10.032 + 1e-9, duration: 0.032, anchor: a, ctxNow: 99, prev });
    expect(next).toMatchObject({ kind: 'start', when: 100.032, gap: 0 });
  });

  it('trou réel dans le flux : signalé', () => {
    const prev = { mediaEnd: 10.032, whenEnd: 100.032 };
    const r = placeChunk({ ts: 10.2, duration: 0.032, anchor: a, ctxNow: 99, prev });
    expect(r.kind === 'start' && r.gap).toBeCloseTo(0.168, 9);
  });

  it('segment en retard : rogné ; entièrement écoulé : ignoré', () => {
    const late = placeChunk({ ts: 10, duration: 0.1, anchor: a, ctxNow: 100.04, prev: null });
    expect(late.kind).toBe('start');
    if (late.kind === 'start') { expect(late.when).toBeCloseTo(100.04, 9); expect(late.offset).toBeCloseTo(0.04, 9); }
    expect(placeChunk({ ts: 10, duration: 0.1, anchor: a, ctxNow: 100.2, prev: null }).kind).toBe('skip');
  });
});

describe('sélection du mode de son (web, sans serveur de streaming)', () => {
  const base: AudioPlanInput = {
    web: true, hls: false, url: 'https://h.example/f.mkv', codec: 'eac3', container: 'Matroska', caps, appCanDecode: true, range: 'ok',
  };

  it('E-AC-3 / AC-3 non décodés par le navigateur : l’app décode', () => {
    expect(chooseAudioPlan(base).mode).toBe('app');
    expect(chooseAudioPlan({ ...base, codec: 'ac3', container: 'MP4' }).mode).toBe('app');
  });

  it('AAC / Opus : le navigateur lit seul', () => {
    expect(chooseAudioPlan({ ...base, codec: 'aac' }).mode).toBe('native');
    expect(chooseAudioPlan({ ...base, codec: 'opus', container: 'WebM' }).mode).toBe('native');
  });

  it('E-AC-3 annoncé par canPlayType : cru en MP4 seulement, jamais en Matroska', () => {
    const withEac3 = { audioCodecs: [...caps.audioCodecs, 'eac3'] };
    expect(browserPlaysAudio('eac3', 'MP4', withEac3)).toBe(true);
    expect(browserPlaysAudio('eac3', 'Matroska', withEac3)).toBe(false);
    expect(chooseAudioPlan({ ...base, caps: withEac3, container: 'MP4' }).mode).toBe('native');
    expect(chooseAudioPlan({ ...base, caps: withEac3, container: 'Matroska' }).mode).toBe('app');
  });

  it('muet malgré l’annonce (octets décodés à 0) : l’app prend le relais', () => {
    const withEac3 = { audioCodecs: [...caps.audioCodecs, 'eac3'] };
    expect(chooseAudioPlan({ ...base, caps: withEac3, container: 'MP4', nativeSilent: true }).mode).toBe('app');
    expect(nativeAudioSilent(0, 3)).toBe(true);
    expect(nativeAudioSilent(0, 1)).toBe(false);
    expect(nativeAudioSilent(48000, 5)).toBe(false);
    expect(nativeAudioSilent(undefined, 5)).toBe(false);
  });

  it('DTS : note « non pris en charge par le navigateur », même si CORS est refusé', () => {
    const r = chooseAudioPlan({ ...base, codec: 'dts' });
    expect(r).toMatchObject({ mode: 'unsupported', codec: 'dts', note: NOTE_DTS });
    expect(NOTE_DTS).toBe('Son DTS non pris en charge par le navigateur');
    expect(chooseAudioPlan({ ...base, codec: 'dts', range: 'denied' }).mode).toBe('unsupported');
    expect(chooseAudioPlan({ ...base, codec: 'truehd' })).toMatchObject({ mode: 'unsupported', note: 'Son TrueHD non pris en charge par le navigateur' });
  });

  it('CORS refusé, plage ignorée ou source en erreur : note claire', () => {
    for (const range of ['denied', 'norange', 'error'] as const) {
      expect(chooseAudioPlan({ ...base, range })).toEqual({ mode: 'cors', note: NOTE_CORS });
    }
    expect(NOTE_CORS).toBe('Son non disponible dans le navigateur pour cette source');
  });

  it('pas de repli : coque / Android, HLS, lien non HTTP(S), fichier sans audio', () => {
    expect(chooseAudioPlan({ ...base, web: false }).mode).toBe('none');
    expect(chooseAudioPlan({ ...base, hls: true }).mode).toBe('none');
    expect(chooseAudioPlan({ ...base, url: 'magnet:?xt=urn:btih:abc' }).mode).toBe('none');
    expect(chooseAudioPlan({ ...base, url: null }).mode).toBe('none');
    expect(chooseAudioPlan({ ...base, codec: null }).mode).toBe('none');
  });

  it('codec inconnu de l’app : note générique', () => {
    expect(chooseAudioPlan({ ...base, codec: 'pcm-s24le', appCanDecode: false })).toMatchObject({ mode: 'unsupported', note: 'Son PCM-S24LE non pris en charge par le navigateur' });
  });

  it('en-tête illisible : seul le nom tranche', () => {
    expect(chooseAudioPlanBlind('dts').mode).toBe('unsupported');
    expect(chooseAudioPlanBlind('eac3')).toEqual({ mode: 'cors', note: NOTE_CORS });
    expect(chooseAudioPlanBlind(null)).toEqual({ mode: 'cors', note: NOTE_CORS });
  });
});

describe('sonde Range d’un octet (CORS)', () => {
  const res = (status: number): Response => ({ status, body: { cancel: () => Promise.resolve() } }) as unknown as Response;

  it('206 : plage lisible ; le fetch reçoit Range bytes=0-0', async () => {
    const f = vi.fn().mockResolvedValue(res(206));
    expect(await probeRange('https://h/f', f as unknown as typeof fetch)).toBe('ok');
    expect(f.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-0' });
  });

  it('TypeError du fetch (refus CORS) : denied', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await probeRange('https://h/f', f as unknown as typeof fetch)).toBe('denied');
  });

  it('200 : le serveur ignore Range ; 403 : erreur', async () => {
    expect(await probeRange('https://h/f', (async () => res(200)) as unknown as typeof fetch)).toBe('norange');
    expect(await probeRange('https://h/f', (async () => res(403)) as unknown as typeof fetch)).toBe('error');
  });

  it('délai dépassé : erreur (pas un refus CORS)', async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError'))))) as unknown as typeof fetch;
    expect(await probeRange('https://h/f', f, 20)).toBe('error');
  });
});

describe('CORS refusé : meilleure source alternative au son lisible', () => {
  const v = (index: number, filename: string, extra: Record<string, unknown> = {}) => ({ index, filename, playable: true, stream: { url: 'https://h/' + index }, ...extra });
  const views = [
    v(0, 'Film.2023.1080p.WEB-DL.DDP5.1.x264.mkv'), // la source en cours (E-AC-3)
    v(1, 'Film.2023.2160p.REMUX.HEVC.DTS-HD.MA.mkv'),
    v(2, 'Film.2023.1080p.BluRay.x264.DD5.1.mkv'),
    v(3, 'Film.2023.1080p.WEB-DL.AAC.x264.mp4'),
    v(4, 'Film.2023.720p.WEB.x264.mp4'), // son non identifié
    v(5, 'Film.2023.720p.WEB.OPUS.x264.webm'),
  ];

  it('readableCaps : codecs lus par le navigateur', () => {
    expect(readableCaps(caps)).toEqual(['h264', 'aac', 'opus', 'flac']);
  });

  it('par le nom : saute DTS, AC-3, E-AC-3 et le son inconnu, retient AAC', async () => {
    const r = await pickReadableAlternative(views, 0, caps);
    expect(r?.view.index).toBe(3);
    expect(r?.source).toBe('name');
  });

  it('par l’en-tête : la sonde prime et lève le doute sur un nom muet', async () => {
    const probe = vi.fn(async (view: { index?: number }) => (view.index === 4 ? { video: 'h264' as const, audio: 'aac' as const } : { video: 'h264' as const, audio: 'ac3' as const }));
    const r = await pickReadableAlternative(views, 0, caps, { probe, probeLimit: 6 });
    expect(r?.view.index).toBe(4);
    expect(r?.source).toBe('header');
  });

  it('aucune alternative au son lisible : rien à proposer', async () => {
    const only = [v(0, 'A.DDP5.1.mkv'), v(1, 'B.DTS.mkv'), v(2, 'C.AC3.mkv')];
    expect(await pickReadableAlternative(only, 0, caps)).toBeNull();
  });

  it('jamais un torrent ni la source en cours', async () => {
    const t = [v(0, 'A.AAC.mp4'), v(1, 'B.AAC.mp4', { stream: { infoHash: 'abc' } })];
    expect(await pickReadableAlternative(t, 0, caps)).toBeNull();
  });
});

describe('sélecteur de sources en mode web : badge et priorité', () => {
  const mk = (over: Record<string, unknown>, filename: string): Stream => ({
    url: 'https://x/play/' + filename,
    behaviorHints: { filename },
    laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, ...over },
  });
  const list = [
    mk({ resolution: '1080p', audio: ['DTS'], score: 90 }, 'Film.1080p.x264.DTS.mkv'),
    mk({ resolution: '1080p', audio: ['EAC3'], channels: '5.1', score: 60 }, 'Film.1080p.x264.DDP5.1.mkv'),
    mk({ resolution: '720p', audio: ['AAC'], score: 40 }, 'Film.720p.x264.AAC.mp4'),
  ];

  it('appAudioOf : E-AC-3 = app, DTS = non pris en charge, AAC = rien', () => {
    const s = list.map((x) => appAudioOf(x, getLaststream(x), caps));
    expect(s).toEqual(['unsupported', 'app', null]);
  });

  it('appAudio absent quand un serveur de streaming convertit lui-même', () => {
    expect(withWebPlayback(toSourceViews(list), caps).map((x) => x.appAudio)).toEqual([null, null, null]);
    expect(withWebPlayback(toSourceViews(list), caps, { appAudio: true }).map((x) => x.appAudio)).toEqual(['unsupported', 'app', null]);
  });

  it('conteneur illisible par le navigateur (avi) : pas de repli audio', () => {
    const avi = mk({ audio: ['EAC3'] }, 'Film.avi');
    expect(appAudioOf(avi, getLaststream(avi), caps)).toBeNull();
  });

  it('une source DTS passe après toute alternative, même moins bien classée', () => {
    const views = withWebPlayback(toSourceViews(list), caps, { appAudio: true });
    const rec = recommend(views, 100_000, 'fr', { preferDirect: true })!;
    expect(rec.view.index).not.toBe(0);
    expect(rec.view.index).toBe(2); // 720p AAC lu directement
    const noAac = withWebPlayback(toSourceViews(list.slice(0, 2)), caps, { appAudio: true });
    const rec2 = recommend(noAac, 100_000, 'fr', { preferDirect: true })!;
    expect(rec2.view.index).toBe(1); // le DTS 1080p mieux noté ne passe pas devant l’E-AC-3
    expect(rec2.reason).toContain('son décodé par l’app');
    // Seule une source DTS : elle est recommandée à défaut.
    const solo = withWebPlayback(toSourceViews([list[0]]), caps, { appAudio: true });
    expect(recommend(solo, 100_000, 'fr', { preferDirect: true })!.view.index).toBe(0);
  });
});

describe('lecteur de plages avec préchargement borné', () => {
  const MIB = 1024 * 1024;
  function inner(size: number) {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      size: async () => size,
      read: async (s: number, e: number) => { calls.push([s, e]); return new Uint8Array(e - s).fill(s / MIB + 1); },
    };
  }

  it('lit des plages éparses et renvoie les bons octets', async () => {
    const r = new PrefetchReader(inner(10 * MIB), { aheadBytes: 0 });
    const out = await r.read(MIB - 2, MIB + 2);
    expect(out.length).toBe(4);
    expect([...out]).toEqual([1, 1, 2, 2]);
    expect((await r.read(10 * MIB - 1, 11 * MIB)).length).toBe(1);
  });

  it('précharge en avant de la dernière lecture, par blocs, sans relire deux fois', async () => {
    const src = inner(100 * MIB);
    const r = new PrefetchReader(src, { aheadBytes: 6 * MIB, concurrency: 2 });
    await r.read(0, 1000);
    await vi.waitFor(() => expect(r.stats().aheadBytes).toBeGreaterThanOrEqual(6 * MIB));
    const before = src.calls.length;
    await r.read(2 * MIB, 2 * MIB + 10);
    expect(src.calls.filter(([s]) => s === 2 * MIB).length).toBe(1);
    expect(src.calls.length).toBeGreaterThanOrEqual(before);
  });

  it('mémoire bornée : le cache ne dépasse jamais maxBytes', async () => {
    const src = inner(200 * MIB);
    const r = new PrefetchReader(src, { maxBytes: 12 * MIB, aheadBytes: 4 * MIB });
    for (let pos = 0; pos < 60 * MIB; pos += 3 * MIB) {
      await r.read(pos, pos + 1000);
      expect(r.stats().cachedBytes).toBeLessThanOrEqual(12 * MIB);
    }
    await vi.waitFor(() => expect(r.stats().inflight).toBe(0));
    expect(r.stats().cachedBytes).toBeLessThanOrEqual(12 * MIB);
  });

  it('close : plus rien n’est lu', async () => {
    const r = new PrefetchReader(inner(5 * MIB));
    r.close();
    await expect(r.read(0, 10)).rejects.toThrow();
  });
});
