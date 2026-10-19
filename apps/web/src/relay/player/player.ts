import type { EncodedPacket } from 'mediabunny';
import type { CodecEnv } from './detect';
import { openMedia, type OpenedMedia } from './demux';
import { resolvePlayback } from './fallback';
import {
  audioSchedule,
  canFeed,
  DRIFT_SEEK_THRESHOLD_S,
  expectedPosition,
  mediaClock,
  needsResync,
  pickFrame,
  type FeedLimits,
} from './sync';
import type {
  PlaybackPlan,
  PlayerCallbacks,
  PlayerState,
  PlayerStats,
  RangeReader,
  RoomState,
} from './types';

/** Images décodées : au plus 6 en attente, 8 confiées au décodeur, 2 s d'avance. */
const VIDEO_LIMITS: FeedLimits = { maxQueue: 6, maxDecodeQueue: 8, maxAheadSec: 2 };
/** Audio : 1,5 s programmés d'avance au plus. */
const AUDIO_LIMITS: FeedLimits = { maxQueue: Number.POSITIVE_INFINITY, maxDecodeQueue: 16, maxAheadSec: 1.5 };
const WAKE_MS = 15;
const STATS_MS = 1000;
/** Marge (s) avant la fin pour considérer le média terminé. */
const END_MARGIN_S = 0.05;

export interface GuestPlayerOptions extends PlayerCallbacks {
  /** Environnement WebCodecs (tests). Par défaut : globalThis. */
  env?: CodecEnv;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Lecteur invité : décode vidéo (VideoDecoder -> canvas) et audio (AudioDecoder -> WebAudio).
 *
 * Horloge maîtresse : l'horloge audio (`AudioContext.currentTime`) si le fichier a de l'audio, sinon
 * l'horloge murale. Les images sont choisies sur cette horloge (les périmées sont écartées).
 *
 * `play`, `pause` et `seek` sont les actions de l'utilisateur : elles émettent onUserPlay/Pause/Seek.
 * `applyRoomState` suit le salon : il ne déclenche aucun de ces événements (pas de boucle).
 */
export class GuestPlayer {
  private readonly cb: PlayerCallbacks;
  private readonly env?: CodecEnv;
  private media: OpenedMedia | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private vdec: VideoDecoder | null = null;
  private adec: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private readonly audioNodes = new Set<AudioBufferSourceNode>();
  private frames: VideoFrame[] = [];
  private shown: VideoFrame | null = null;

  private playing = false;
  private ended = false;
  private duration = 0;
  /** Position média et instant d'horloge correspondant (ancre de l'horloge maîtresse). */
  private anchorMedia = 0;
  private anchorClock = 0;
  /** Incrémenté à chaque seek ou déchargement : invalide les producteurs en cours. */
  private gen = 0;
  private videoFedEnd = 0;
  private audioFedEnd = 0;
  private mediaEnd = 0;
  private videoEOF = true;
  private audioEOF = true;
  private destroyed = false;
  private rafId = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private counters = { decodedFrames: 0, droppedFrames: 0, audioChunks: 0, seeks: 0, lastDriftSec: 0 };

  constructor(options: GuestPlayerOptions = {}) {
    this.cb = options;
    this.env = options.env;
  }

  /**
   * Ouvre le fichier et prépare le décodage sur `canvas`. Ne lit que les plages nécessaires.
   * Renvoie `{kind:'unsupported', message}` (sans lever d'erreur) si le navigateur ne peut pas décoder.
   */
  async load(reader: RangeReader, canvas: HTMLCanvasElement): Promise<PlaybackPlan> {
    this.unload();
    const media = await openMedia(reader);
    const plan = await resolvePlayback({ video: media.info.video, audio: media.info.audio }, this.env);
    if (plan.kind !== 'native') {
      media.close();
      return plan;
    }
    try {
      this.setup(media, canvas);
    } catch (error) {
      this.unload();
      throw error;
    }
    return { kind: 'native' };
  }

  /** Lance la lecture (action utilisateur). */
  play(): void {
    if (!this.media || this.playing) return;
    if (this.ended) this.seekInternal(0);
    this.startPlayback();
    this.cb.onUserPlay?.(this.mediaNow());
  }

  /** Met en pause (action utilisateur). */
  pause(): void {
    if (!this.media || !this.playing) return;
    this.stopPlayback();
    this.cb.onUserPause?.(this.mediaNow());
  }

  /** Déplace la lecture vers `t` (secondes), sur l'image clé précédente (action utilisateur). */
  seek(t: number): void {
    if (!this.media) return;
    const target = this.seekInternal(t);
    this.cb.onUserSeek?.(target);
  }

  /**
   * Recale la lecture sur l'état du salon. Si l'écart dépasse 0,5 s, on fait un seek ; la lecture ou la pause
   * suit `room.playing`. Aucun événement onUser* n'est émis.
   */
  applyRoomState(room: RoomState, nowMs: number = Date.now()): void {
    if (!this.media) return;
    const target = expectedPosition(room, nowMs, this.duration);
    const local = this.mediaNow();
    this.counters.lastDriftSec = local - target;
    if (needsResync(local, target, DRIFT_SEEK_THRESHOLD_S)) this.seekInternal(target);
    if (room.playing) this.startPlayback();
    else this.stopPlayback();
  }

  getState(): PlayerState {
    return { playing: this.playing, position: this.mediaNow(), duration: this.duration };
  }

  getStats(): PlayerStats {
    return {
      videoCodec: this.media?.info.video?.codec ?? null,
      audioCodec: this.media?.info.audio?.codec ?? null,
      decodedFrames: this.counters.decodedFrames,
      droppedFrames: this.counters.droppedFrames,
      audioChunks: this.counters.audioChunks,
      queuedFrames: this.frames.length,
      audioAheadSec: Math.max(0, this.audioFedEnd - this.mediaNow()),
      lastDriftSec: this.counters.lastDriftSec,
      seeks: this.counters.seeks,
    };
  }

  /** Libère décodeurs, contexte audio et fichier. Le lecteur ne sert plus ensuite. */
  destroy(): void {
    this.destroyed = true;
    this.unload();
  }

  // ---- Mise en place et déchargement -------------------------------------------------------------

  private setup(media: OpenedMedia, canvas: HTMLCanvasElement): void {
    this.media = media;
    this.duration = media.info.duration;
    this.canvas = canvas;
    const video = media.info.video;
    if (video && video.width > 0 && video.height > 0) {
      canvas.width = video.width;
      canvas.height = video.height;
    }
    this.ctx2d = canvas.getContext('2d');
    if (!this.ctx2d) throw new Error('Canvas 2D indisponible dans ce navigateur.');

    if (media.videoConfig) {
      const decoder = new VideoDecoder({
        output: (frame) => this.onVideoFrame(frame),
        error: (error) => this.fail(error),
      });
      decoder.configure(media.videoConfig);
      this.vdec = decoder;
    }
    if (media.audioConfig) {
      this.audioCtx = new AudioContext();
      const decoder = new AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (error) => this.fail(error),
      });
      decoder.configure(media.audioConfig);
      this.adec = decoder;
    }

    this.playing = false;
    this.ended = false;
    this.seekInternal(0);
    this.rafId = requestAnimationFrame(this.tick);
    this.statsTimer = setInterval(() => this.cb.onStats?.(this.getStats()), STATS_MS);
  }

  private unload(): void {
    this.gen++;
    this.playing = false;
    this.ended = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.stopAudioNodes();
    this.closeFrames();
    for (const decoder of [this.vdec, this.adec]) {
      try {
        decoder?.close();
      } catch {
        // Déjà fermé.
      }
    }
    this.vdec = null;
    this.adec = null;
    if (this.audioCtx) void this.audioCtx.close().catch(() => undefined);
    this.audioCtx = null;
    this.media?.close();
    this.media = null;
    this.canvas = null;
    this.ctx2d = null;
    this.duration = 0;
    this.videoEOF = true;
    this.audioEOF = true;
  }

  // ---- Horloge -----------------------------------------------------------------------------------

  private clockNow(): number {
    return this.audioCtx ? this.audioCtx.currentTime : performance.now() / 1000;
  }

  private mediaNow(): number {
    if (!this.media) return 0;
    const t = mediaClock(this.anchorMedia, this.anchorClock, this.clockNow(), this.playing);
    return this.duration > 0 ? Math.min(t, this.duration) : t;
  }

  private startPlayback(): void {
    // Un média terminé ne repart pas tout seul : un seek (utilisateur ou salon) le réarme avant.
    if (!this.media || this.playing || this.ended) return;
    this.anchorClock = this.clockNow();
    this.playing = true;
    if (this.audioCtx) void this.audioCtx.resume().catch(() => undefined);
  }

  private stopPlayback(): void {
    if (!this.playing) return;
    this.anchorMedia = this.mediaNow();
    this.anchorClock = this.clockNow();
    this.playing = false;
    if (this.audioCtx) void this.audioCtx.suspend().catch(() => undefined);
  }

  // ---- Seek --------------------------------------------------------------------------------------

  /** Seek synchrone côté état (ancres, file d'images), asynchrone côté alimentation des décodeurs. */
  private seekInternal(t: number): number {
    if (!this.media) return 0;
    const target = clamp(t, 0, this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY);
    this.gen++;
    const gen = this.gen;
    this.anchorMedia = target;
    this.anchorClock = this.clockNow();
    this.ended = false;
    this.counters.seeks++;
    this.stopAudioNodes();
    this.closeFrames();
    try {
      // reset() ramène le décodeur à l'état « unconfigured » : il faut le reconfigurer avant de décoder.
      if (this.vdec && this.media.videoConfig) {
        this.vdec.reset();
        this.vdec.configure(this.media.videoConfig);
      }
      if (this.adec && this.media.audioConfig) {
        this.adec.reset();
        this.adec.configure(this.media.audioConfig);
      }
    } catch (error) {
      this.fail(error);
    }
    this.videoFedEnd = target;
    this.audioFedEnd = target;
    this.videoEOF = !this.media.videoSink;
    this.audioEOF = !this.media.audioSink;
    this.startFeeders(gen, target).catch((error: unknown) => this.fail(error));
    return target;
  }

  private async startFeeders(gen: number, target: number): Promise<void> {
    const media = this.media;
    if (!media) return;
    if (media.videoSink && this.vdec) {
      // Décodage depuis l'image clé précédant la cible ; les images antérieures à la cible sont écartées à l'affichage.
      const key = (await media.videoSink.getKeyPacket(target)) ?? (await media.videoSink.getFirstPacket());
      if (gen !== this.gen) return;
      if (key) void this.feedVideo(gen, media.videoSink.packets(key));
      else this.videoEOF = true;
    }
    if (media.audioSink && this.adec) {
      const packet = (await media.audioSink.getPacket(target)) ?? (await media.audioSink.getFirstPacket());
      if (gen !== this.gen) return;
      if (packet) void this.feedAudio(gen, media.audioSink.packets(packet));
      else this.audioEOF = true;
    }
  }

  // ---- Alimentation des décodeurs (buffering borné) -----------------------------------------------

  private async feedVideo(gen: number, packets: AsyncGenerator<EncodedPacket, void, unknown>): Promise<void> {
    try {
      for (;;) {
        const decoder = this.vdec;
        if (gen !== this.gen || !decoder) return;
        const ahead = this.videoFedEnd - this.mediaNow();
        if (!canFeed({ queued: this.frames.length, decodeQueue: decoder.decodeQueueSize, aheadSec: ahead }, VIDEO_LIMITS)) {
          await sleep(WAKE_MS);
          continue;
        }
        const next = await packets.next();
        if (gen !== this.gen || this.vdec !== decoder) return;
        if (next.done) {
          this.videoEOF = true;
          decoder.flush().catch(() => undefined);
          return;
        }
        const packet = next.value;
        this.videoFedEnd = Math.max(this.videoFedEnd, packet.timestamp + packet.duration);
        this.mediaEnd = Math.max(this.mediaEnd, packet.timestamp + packet.duration);
        decoder.decode(packet.toEncodedVideoChunk());
      }
    } catch (error) {
      if (gen === this.gen) this.fail(error);
    }
  }

  private async feedAudio(gen: number, packets: AsyncGenerator<EncodedPacket, void, unknown>): Promise<void> {
    try {
      for (;;) {
        const decoder = this.adec;
        if (gen !== this.gen || !decoder) return;
        const ahead = this.audioFedEnd - this.mediaNow();
        if (!canFeed({ queued: 0, decodeQueue: decoder.decodeQueueSize, aheadSec: ahead }, AUDIO_LIMITS)) {
          await sleep(WAKE_MS);
          continue;
        }
        const next = await packets.next();
        if (gen !== this.gen || this.adec !== decoder) return;
        if (next.done) {
          this.audioEOF = true;
          decoder.flush().catch(() => undefined);
          return;
        }
        const packet = next.value;
        this.audioFedEnd = Math.max(this.audioFedEnd, packet.timestamp + packet.duration);
        this.mediaEnd = Math.max(this.mediaEnd, packet.timestamp + packet.duration);
        decoder.decode(packet.toEncodedAudioChunk());
      }
    } catch (error) {
      if (gen === this.gen) this.fail(error);
    }
  }

  // ---- Sorties des décodeurs ---------------------------------------------------------------------

  private onVideoFrame(frame: VideoFrame): void {
    if (this.destroyed || !this.media) {
      frame.close();
      return;
    }
    this.counters.decodedFrames++;
    this.frames.push(frame);
  }

  private onAudioData(data: AudioData): void {
    try {
      const ctx = this.audioCtx;
      if (!ctx || this.destroyed || !this.media) return;
      const ts = data.timestamp / 1e6;
      const duration = data.numberOfFrames / data.sampleRate;
      const { when, offset } = audioSchedule(ts, this.anchorMedia, this.anchorClock, ctx.currentTime);
      if (offset >= duration) return;

      const buffer = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let c = 0; c < data.numberOfChannels; c++) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buffer.copyToChannel(plane, c);
      }
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => {
        this.audioNodes.delete(node);
      };
      this.audioNodes.add(node);
      node.start(when, offset);
      this.counters.audioChunks++;
    } catch (error) {
      this.fail(error);
    } finally {
      data.close();
    }
  }

  // ---- Affichage ---------------------------------------------------------------------------------

  private readonly tick = (): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.tick);
    this.render();
  };

  private render(): void {
    const ctx = this.ctx2d;
    const canvas = this.canvas;
    if (!this.media || !ctx || !canvas) return;
    const now = this.mediaNow();

    if (this.frames.length > 0) {
      const idx = pickFrame(
        this.frames.map((frame) => frame.timestamp / 1e6),
        now,
      );
      if (idx > 0) {
        for (let i = 0; i < idx; i++) this.frames[i].close();
        this.frames.splice(0, idx);
        this.counters.droppedFrames += idx;
      }
      const frame = idx >= 0 ? this.frames[0] : undefined;
      if (frame && frame !== this.shown) {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        this.shown = frame;
      }
    }

    // La dernière image reste affichée (elle n'est jamais retirée de la file) : « fini » = rien d'autre en attente.
    const nothingPending = this.frames.length === 0 || (this.frames.length === 1 && this.frames[0] === this.shown);
    const endSec = this.duration > 0 ? this.duration : this.mediaEnd;
    if (
      this.playing &&
      !this.ended &&
      this.videoEOF &&
      this.audioEOF &&
      nothingPending &&
      endSec > 0 &&
      now >= endSec - END_MARGIN_S
    ) {
      this.ended = true;
      this.stopPlayback();
      this.cb.onEnded?.();
    }
  }

  private closeFrames(): void {
    for (const frame of this.frames) frame.close();
    this.frames = [];
    this.shown = null;
  }

  private stopAudioNodes(): void {
    for (const node of this.audioNodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Jamais démarré : rien à arrêter.
      }
      node.disconnect();
    }
    this.audioNodes.clear();
  }

  private fail(error: unknown): void {
    this.cb.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
