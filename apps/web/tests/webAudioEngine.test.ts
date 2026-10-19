import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAudioFallback, type VideoLike } from '../src/player/webaudio/engine';
import type { AudioSource, PcmChunk } from '../src/player/webaudio/source';

/* Moteur audio de repli : horloge, attente du tampon, seek, vitesse, volume, dérive. Vidéo, contexte audio et source de
 * segments sont des mocks ; le temps (vidéo et contexte) avance pas à pas avec les minuteries simulées. */

class FakeVideo extends EventTarget implements VideoLike {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  volume = 0.8;
  muted = false;
  pauses = 0;
  plays = 0;
  play(): Promise<void> {
    this.plays++;
    if (this.paused) { this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); }
    return Promise.resolve();
  }
  pause(): void {
    this.pauses++;
    if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
}

interface Started { when: number; offset: number; rate: number; stopped: boolean; node?: { onended: null | (() => void) }; chunk: { timestamp: number; duration: number } }

class FakeCtx {
  currentTime = 0;
  outputLatency = 0;
  baseLatency = 0;
  state = 'running';
  destination = {};
  starts: Started[] = [];
  gainValues: number[] = [];
  gain = { value: 1, setTargetAtTime: (v: number) => { this.gain.value = v; this.gainValues.push(v); } };
  createGain() { return { gain: this.gain, connect: () => undefined }; }
  createBufferSource() {
    const rec: Started = { when: 0, offset: 0, rate: 1, stopped: false, chunk: null as unknown as Started["chunk"] };
    const node = {
      buffer: null as unknown as Started["chunk"],
      playbackRate: { value: 1 },
      onended: null as null | (() => void),
      connect: () => undefined,
      disconnect: () => undefined,
      start: (when: number, offset: number) => { rec.node = node; rec.when = when; rec.offset = offset; rec.rate = node.playbackRate.value; rec.chunk = node.buffer; this.starts.push(rec); },
      stop: () => { rec.stopped = true; },
    };
    return node;
  }
  /** Les nœuds dont la fin est passée appellent onended, comme un vrai AudioBufferSourceNode. */
  settle() {
    for (const r of this.starts) {
      if (r.stopped || !r.node?.onended) continue;
      if (r.when + (r.chunk.duration - r.offset) / r.rate <= this.currentTime) { const f = r.node.onended; r.node.onended = null; f(); }
    }
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

class FakeSource implements AudioSource {
  opened: number[] = [];
  closed = false;
  failures = 0;
  stalled: Promise<void> | null = null;
  /** Temps réseau simulé par segment (ms) : 20 ms pour 0,1 s de son = 5 fois le temps réel. */
  delayMs = 0;
  bytesPerSecond = 100_000;
  constructor(readonly total = 120, readonly step = 0.1) {}
  prefetchStats() { return { cachedBytes: 1000, aheadBytes: 3_500_000, inflight: 0, requests: 3 }; }
  close() { this.closed = true; }
  async *chunks(start: number): AsyncGenerator<PcmChunk, void, unknown> {
    this.opened.push(start);
    let ts = Math.floor(start / this.step) * this.step;
    while (ts < this.total) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.stalled) await this.stalled;
      if (this.failures > 0) { this.failures--; throw new Error('réseau'); }
      yield { timestamp: ts, duration: this.step, buffer: { timestamp: ts, duration: this.step } as unknown as AudioBuffer, bytes: 1000 };
      ts = Math.round((ts + this.step) * 1e6) / 1e6;
    }
  }
}

let video: FakeVideo;
let ctx: FakeCtx;
let source: FakeSource;
let engine: WebAudioFallback;
const changes = vi.fn();
const errors = vi.fn();

/** Fait avancer le temps : vidéo (si elle joue) et contexte audio, par pas de 50 ms. */
async function run(seconds: number, opts: { videoSpeed?: number; ctxSpeed?: number } = {}): Promise<void> {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    ctx.currentTime += 0.05 * (opts.ctxSpeed ?? 1);
    if (!video.paused && !video.seeking && video.readyState >= 3) video.currentTime += 0.05 * video.playbackRate * (opts.videoSpeed ?? 1);
    await vi.advanceTimersByTimeAsync(50);
    ctx.settle();
  }
}

function make(over: Partial<ConstructorParameters<typeof WebAudioFallback>[3]> = {}): void {
  engine = new WebAudioFallback(video, source, 48000, { createContext: () => ctx as unknown as AudioContext, onChange: changes, onError: errors, ...over });
}

beforeEach(() => {
  vi.useFakeTimers();
  video = new FakeVideo();
  ctx = new FakeCtx();
  source = new FakeSource();
  changes.mockClear();
  errors.mockClear();
});
afterEach(() => {
  engine?.destroy();
  vi.useRealTimers();
});

describe('moteur audio de repli : démarrage et attente du tampon', () => {
  it('la piste native est muette ; volume et muet logiques viennent de l’interface', () => {
    make();
    expect(video.muted).toBe(true);
    expect(engine.volume).toBe(0.8);
    expect(engine.muted).toBe(false);
  });

  it('attend 3 s de son décodé avant de lancer la vidéo, puis la relance', async () => {
    video.paused = false; // l'utilisateur lit déjà quand le moteur s'attache
    source.delayMs = 20;
    make();
    engine.start();
    await run(0.05);
    expect(engine.holding).toBe(true);
    expect(video.paused).toBe(true);
    expect(changes).toHaveBeenCalled();
    await run(0.3);
    expect(engine.holding).toBe(true); // 1,5 s décodées seulement
    await run(0.5);
    expect(engine.holding).toBe(false);
    expect(video.paused).toBe(false);
    expect(video.plays).toBe(1);
    expect(engine.stats().holds).toBe(1);
  });

  it('décode au moins 3 s d’avance, jamais plus de 8 s (mémoire bornée)', async () => {
    video.paused = false;
    make();
    engine.start();
    await run(3);
    const ahead = engine.stats().aheadSec;
    expect(ahead).toBeGreaterThanOrEqual(3);
    expect(ahead).toBeLessThanOrEqual(8.2);
    await run(20);
    const s = engine.stats();
    expect(s.aheadSec).toBeLessThanOrEqual(8.2);
    // 8 s de segments de 0,1 s à 1000 octets, plus un quart de seconde de passé : file courte.
    expect(s.queuedBytes).toBeLessThanOrEqual(1000 * 90);
    expect(s.prefetchedSec).toBeCloseTo(35, 0);
  });

  it('pas de trou entre segments : chaque segment démarre à la fin du précédent', async () => {
    video.paused = false;
    make();
    engine.start();
    await run(6);
    const live = ctx.starts.filter((s) => !s.stopped).sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);
    expect(live.length).toBeGreaterThan(20);
    for (let i = 1; i < live.length; i++) {
      const prev = live[i - 1];
      expect(live[i].when).toBeCloseTo(prev.when + prev.chunk.duration - prev.offset, 9);
    }
    expect(engine.stats().gaps).toBe(0);
    expect(engine.stats().late).toBe(0);
  });

  it('le son est calé sur la position de la vidéo : segment de t joué à t - ancre', async () => {
    video.currentTime = 10;
    video.paused = false;
    make();
    engine.start();
    await run(4);
    const first = ctx.starts.find((s) => !s.stopped)!;
    // Ancre prise quand l'horloge vidéo tourne : position média 10,05 au plus tôt, instant du contexte égal à cet instant.
    expect(first.chunk.timestamp).toBeGreaterThanOrEqual(10);
    expect(source.opened[0]).toBeCloseTo(9.9, 1);
  });
});

describe('moteur audio de repli : pause, lecture, seek, vitesse', () => {
  async function playing(): Promise<void> {
    video.paused = false;
    make();
    engine.start();
    await run(4);
  }

  it('pause : les nœuds programmés sont arrêtés, plus rien n’est programmé', async () => {
    await playing();
    expect(ctx.starts.some((s) => !s.stopped)).toBe(true);
    video.pause();
    await run(0.1);
    expect(ctx.starts.every((s) => s.stopped || s.when + s.chunk.duration <= ctx.currentTime)).toBe(true);
    const n = ctx.starts.length;
    await run(1);
    expect(ctx.starts.length).toBe(n);
    expect(engine.holding).toBe(false);
  });

  it('reprise après pause : le son repart de la position de la vidéo, sans redécoder', async () => {
    await playing();
    video.pause();
    await run(1);
    const opened = source.opened.length;
    const pos = video.currentTime;
    await video.play();
    await run(0.5);
    const live = ctx.starts.filter((s) => !s.stopped && s.when >= ctx.currentTime - 0.2);
    expect(live.length).toBeGreaterThan(0);
    expect(Math.min(...live.map((s) => s.chunk.timestamp))).toBeGreaterThanOrEqual(pos - 0.2);
    expect(source.opened.length).toBe(opened);
  });

  it('seek : file vidée, flux relancé à la nouvelle position, attente du son puis reprise', async () => {
    await playing();
    source.delayMs = 20;
    video.seeking = true;
    video.currentTime = 60;
    video.dispatchEvent(new Event('seeking'));
    expect(engine.holding).toBe(true);
    expect(video.paused).toBe(true);
    await run(0.2);
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    expect(source.opened.at(-1)).toBeCloseTo(60, 0);
    expect(engine.stats().seeks).toBe(1);
    await run(0.1);
    expect(engine.holding).toBe(true); // moins de 3 s décodées
    await run(1);
    expect(engine.holding).toBe(false);
    expect(video.paused).toBe(false);
    const after = ctx.starts.filter((s) => !s.stopped && s.chunk.timestamp >= 59);
    expect(after.length).toBeGreaterThan(0);
  });

  it('rafale de seeks (barre de recherche) : un seul flux relancé', async () => {
    await playing();
    const before = source.opened.length;
    for (const t of [20, 30, 40, 50]) {
      video.currentTime = t;
      video.dispatchEvent(new Event('seeking'));
      await run(0.05);
    }
    video.dispatchEvent(new Event('seeked'));
    await run(0.1);
    expect(source.opened.length - before).toBe(1);
    expect(source.opened.at(-1)).toBeCloseTo(50, 0);
  });

  it('vitesse : les nœuds jouent à la vitesse de la vidéo et le temps du contexte suit', async () => {
    await playing();
    video.playbackRate = 2;
    video.dispatchEvent(new Event('ratechange'));
    await run(1);
    const fast = ctx.starts.filter((s) => !s.stopped && s.rate === 2);
    expect(fast.length).toBeGreaterThan(3);
    // Un segment de 0,1 s à vitesse 2 occupe 0,05 s de contexte.
    const sorted = [...fast].sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);
    expect(sorted[2].when - sorted[1].when).toBeCloseTo(0.05, 6);
    expect(engine.stats().gaps).toBe(0);
  });

  it('volume et muet branchés sur le gain ; la piste native reste muette', async () => {
    await playing();
    engine.setVolume(0.35);
    expect(ctx.gain.value).toBeCloseTo(0.35, 6);
    engine.setMuted(true);
    expect(ctx.gain.value).toBe(0);
    expect(engine.muted).toBe(true);
    engine.setMuted(false);
    expect(ctx.gain.value).toBeCloseTo(0.35, 6);
    engine.setVolume(7);
    expect(engine.volume).toBe(1);
    expect(video.muted).toBe(true);
  });

  it('cancelHold : pause demandée pendant l’attente du son, la vidéo reste en pause', async () => {
    video.paused = false;
    source.stalled = new Promise(() => undefined);
    make();
    engine.start();
    await run(0.2);
    expect(engine.holding).toBe(true);
    engine.cancelHold();
    expect(engine.holding).toBe(false);
    await run(0.5);
    expect(video.paused).toBe(true);
  });
});

describe('moteur audio de repli : dérive et panne', () => {
  async function playing(): Promise<void> {
    video.paused = false;
    make();
    engine.start();
    await run(4);
  }

  it('dérive faible (< 80 ms) : aucun recalage', async () => {
    await playing();
    await run(5, { ctxSpeed: 1.004 }); // 4 ms de plus toutes les secondes
    const s = engine.stats();
    expect(s.resyncs).toBe(0);
    expect(Math.abs(s.driftMs)).toBeLessThan(80);
  });

  it('dérive lente cumulée au-delà de 80 ms : recalage, puis retour sous le seuil', async () => {
    await playing();
    await run(30, { ctxSpeed: 1.004 }); // 120 ms d'écart cumulé en 30 s
    const s = engine.stats();
    expect(s.resyncs).toBeGreaterThanOrEqual(1);
    expect(s.maxDriftMs).toBeLessThan(150);
    expect(Math.abs(s.driftMs)).toBeLessThan(80);
  });

  it('saut franc de la vidéo (> 250 ms) : recalage immédiat sans redécoder', async () => {
    await playing();
    const opened = source.opened.length;
    video.currentTime += 0.5;
    await run(0.1);
    expect(engine.stats().resyncs).toBe(1);
    expect(source.opened.length).toBe(opened);
    const live = ctx.starts.filter((s) => !s.stopped);
    expect(live.length).toBeGreaterThan(0);
  });

  it('vidéo qui attend ses données : le son s’arrête puis repart avec une nouvelle ancre', async () => {
    await playing();
    video.readyState = 1;
    video.dispatchEvent(new Event('waiting'));
    await run(1);
    const stoppedAll = ctx.starts.every((s) => s.stopped || s.when + s.chunk.duration <= ctx.currentTime);
    expect(stoppedAll).toBe(true);
    video.readyState = 4;
    video.dispatchEvent(new Event('playing'));
    await run(0.5);
    expect(ctx.starts.some((s) => !s.stopped && s.when > ctx.currentTime - 0.1)).toBe(true);
    expect(engine.stats().resyncs).toBe(0);
  });

  it('tampon audio vide en lecture : attente du son (« chargement du son »), reprise au retour des données', async () => {
    await playing();
    let release: () => void = () => undefined;
    source.stalled = new Promise((r) => { release = r; });
    // On vide la file : un seek vers une zone que la source ne livre plus.
    video.seeking = true;
    video.currentTime = 80;
    video.dispatchEvent(new Event('seeking'));
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    await run(2);
    expect(engine.holding).toBe(true);
    expect(video.paused).toBe(true);
    release();
    source.stalled = null;
    await run(1);
    expect(engine.holding).toBe(false);
    expect(video.paused).toBe(false);
  });

  it('flux audio en erreur : nouvelles tentatives, puis abandon du son sans bloquer l’image', async () => {
    video.paused = false;
    source.failures = 99;
    make({ retries: 2 });
    engine.start();
    await run(3);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(engine.isFailed).toBe(true);
    expect(engine.stats().errors).toBe(3);
    expect(engine.holding).toBe(false);
    expect(video.paused).toBe(false);
  });

  it('une erreur passagère est rattrapée sans interrompre la lecture', async () => {
    video.paused = false;
    source.failures = 1;
    make();
    engine.start();
    await run(4);
    expect(errors).not.toHaveBeenCalled();
    expect(engine.holding).toBe(false);
    expect(ctx.starts.some((s) => !s.stopped)).toBe(true);
  });

  it('destroy : nœuds arrêtés, source fermée, écouteurs retirés', async () => {
    await playing();
    engine.destroy();
    expect(source.closed).toBe(true);
    expect(ctx.starts.every((s) => s.stopped || s.when + s.chunk.duration <= ctx.currentTime)).toBe(true);
    const n = ctx.starts.length;
    video.dispatchEvent(new Event('ratechange'));
    await run(1);
    expect(ctx.starts.length).toBe(n);
  });
});
