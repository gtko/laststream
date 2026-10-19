import type { AudioSource, PcmChunk } from './source';
import {
  DRIFT_RESYNC_S, LOOKAHEAD_S, MAX_AHEAD_S, START_AHEAD_S, UNDERRUN_S,
  aheadSeconds, driftSeconds, driftVerdict, mappedMedia, placeChunk, readyToPlay, underrun, type Anchor,
} from './timing';

/* Moteur audio de repli (web) : le `<video>` garde l'image (muet sur sa piste native) ; ce moteur lit la piste son avec des
 * requêtes Range sur la même URL, la décode et la joue en WebAudio, calée sur `video.currentTime`.
 *
 *  - Deux étages : le décodage remplit une file de segments PCM (jusqu'à MAX_AHEAD_S d'avance, mémoire bornée) ;
 *    l'ordonnanceur ne programme dans le contexte audio que la prochaine seconde (LOOKAHEAD_S). Un recalage (dérive, vitesse,
 *    reprise) arrête ces quelques nœuds et reprogramme depuis la file, sans redécoder.
 *  - Attente du tampon : sans START_AHEAD_S de son décodé d'avance (démarrage, seek, panne), le moteur met la vidéo en pause
 *    (`holding`) et la relance quand le tampon est prêt. L'interface affiche « chargement du son ».
 *  - Une boucle de 50 ms réconcilie l'état de la vidéo (lecture, pause, attente, seek) avec celui de l'audio : les événements
 *    ne font qu'accélérer cette boucle. */

export interface VideoLike extends EventTarget {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

export interface FallbackStats {
  holding: boolean;
  /** Son décodé d'avance (s). */
  aheadSec: number;
  /** Compressé préchargé en avant de la position de décodage, en secondes de média. */
  prefetchedSec: number;
  prefetchedBytes: number;
  queuedBytes: number;
  chunksScheduled: number;
  /** Trous détectés entre deux segments programmés qui auraient dû être jointifs. */
  gaps: number;
  /** Segments perdus parce que déjà écoulés au moment de les programmer. */
  late: number;
  resyncs: number;
  seeks: number;
  holds: number;
  driftMs: number;
  maxDriftMs: number;
  errors: number;
}

export interface FallbackOptions {
  createContext?: (sampleRate: number) => AudioContext;
  tickMs?: number;
  /** Appelé quand `holding` ou une erreur change. */
  onChange?: () => void;
  onError?: (error: Error) => void;
  /** Tentatives de relance du flux audio après une erreur de lecture avant d'abandonner (le son se coupe, l'image continue). */
  retries?: number;
  startAheadSec?: number;
  maxAheadSec?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HAVE_FUTURE_DATA = 3;

export class WebAudioFallback {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly startAhead: number;
  private readonly maxAhead: number;
  private queue: PcmChunk[] = [];
  private queuedBytes = 0;
  private lastEnd = Number.NEGATIVE_INFINITY;
  private eof = false;
  private gen = 0;
  private feeding = false;
  private nodes = new Map<AudioBufferSourceNode, PcmChunk>();
  private scheduled = new Set<PcmChunk>();
  private prev: { mediaEnd: number; whenEnd: number } | null = null;
  private anchor: Anchor | null = null;
  private strikes = 0;
  /** Dernière position vidéo vue avant de démarrer le son : on attend que l'horloge bouge, pour ancrer sur une horloge qui tourne. */
  private armTime: number | null = null;
  private lastResyncAt = -1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private failed = false;
  private _holding = false;
  private _volume: number;
  private _muted: boolean;
  private readonly listeners: Array<[string, () => void]> = [];
  private readonly counters = { chunksScheduled: 0, gaps: 0, late: 0, resyncs: 0, seeks: 0, holds: 0, maxDriftMs: 0, driftMs: 0, errors: 0 };

  constructor(private readonly video: VideoLike, private readonly source: AudioSource, sampleRate: number, private readonly opts: FallbackOptions = {}) {
    this.startAhead = opts.startAheadSec ?? START_AHEAD_S;
    this.maxAhead = opts.maxAheadSec ?? MAX_AHEAD_S;
    this.ctx = (opts.createContext ?? ((sr) => new AudioContext({ sampleRate: sr, latencyHint: 'playback' })))(sampleRate);
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    // Volume et muet logiques : ceux de l'interface au moment de l'attache. La piste native reste muette.
    this._volume = video.volume;
    this._muted = video.muted;
    this.applyGain();
    video.muted = true;
    for (const ev of ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended', 'emptied']) {
      const fn = (): void => this.onEvent(ev);
      video.addEventListener(ev, fn);
      this.listeners.push([ev, fn]);
    }
    // Contexte suspendu par la politique d'autoplay : le premier geste le réveille.
    for (const ev of ['pointerdown', 'keydown']) {
      const wake = (): void => { void this.ctx.resume().catch(() => undefined); };
      globalThis.addEventListener?.(ev, wake, { once: true, capture: true });
    }
  }

  // ---- Interface pour le moteur HTML ------------------------------------------------------------------------------

  /** La vidéo est mise en pause par nous, en attente du son (l'utilisateur, lui, veut lire). */
  get holding(): boolean { return this._holding; }
  get volume(): number { return this._volume; }
  get muted(): boolean { return this._muted; }
  get isFailed(): boolean { return this.failed; }

  setVolume(v: number): void {
    this._volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  setMuted(m: boolean): void {
    this._muted = !!m;
    this.applyGain();
  }

  /** L'utilisateur met en pause pendant l'attente : on abandonne l'attente, la vidéo reste en pause. */
  cancelHold(): void {
    if (!this._holding) return;
    this._holding = false;
    this.opts.onChange?.();
  }

  /** Démarre le décodage à la position courante de la vidéo et la boucle de synchronisation. */
  start(): void {
    if (this.destroyed || this.tickTimer) return;
    this.restartFeed(this.video.currentTime);
    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? 50);
    this.tick();
  }

  stats(): FallbackStats {
    const p = this.source.prefetchStats();
    const bps = this.source.bytesPerSecond;
    return {
      holding: this._holding,
      aheadSec: aheadSeconds(this.lastEnd, this.video.currentTime),
      prefetchedSec: bps > 0 ? p.aheadBytes / bps : 0,
      prefetchedBytes: p.cachedBytes,
      queuedBytes: this.queuedBytes,
      ...this.counters,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gen++;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.tickTimer = null;
    this.seekTimer = null;
    for (const [ev, fn] of this.listeners) this.video.removeEventListener(ev, fn);
    this.listeners.length = 0;
    this.stopNodes();
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.source.close();
    this._holding = false;
    void this.ctx.close().catch(() => undefined);
  }

  // ---- Événements vidéo -------------------------------------------------------------------------------------------

  private onEvent(ev: string): void {
    if (this.destroyed) return;
    if (ev === 'seeking') {
      // Nouvelle position : la file n'est plus valable. Les rafales de « seeking » (barre de recherche) sont regroupées.
      this.counters.seeks++;
      this.flush();
      if (!this.video.paused) this.hold();
      if (this.seekTimer) clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => { this.seekTimer = null; this.restartFeed(this.video.currentTime); }, 120);
      return;
    }
    if (ev === 'seeked') {
      if (this.seekTimer) { clearTimeout(this.seekTimer); this.seekTimer = null; this.restartFeed(this.video.currentTime); }
    } else if (ev === 'pause' || ev === 'waiting' || ev === 'ended' || ev === 'emptied') {
      this.stopNodes();
      this.anchor = null;
    } else if (ev === 'ratechange') {
      this.recalibrate();
    }
    this.tick();
  }

  // ---- Boucle de réconciliation -----------------------------------------------------------------------------------

  /** Un pas de la boucle (50 ms) ; public pour les tests. */
  tick(): void {
    if (this.destroyed) return;
    const v = this.video;
    if (this.failed) {
      // Son abandonné : l'image continue, sans attente.
      if (this._holding) { this._holding = false; this.opts.onChange?.(); this.resumeVideo(); }
      return;
    }
    const ahead = aheadSeconds(this.lastEnd, v.currentTime);
    if (this._holding) {
      if (readyToPlay(ahead, this.eof, this.startAhead)) {
        this._holding = false;
        this.opts.onChange?.();
        this.resumeVideo();
      }
      return;
    }
    if (v.paused || v.ended || v.seeking || v.readyState < HAVE_FUTURE_DATA) {
      // La vidéo ne joue pas : le son non plus (le décodage, lui, continue jusqu'à MAX_AHEAD_S).
      if (this.anchor) { this.stopNodes(); this.anchor = null; }
      this.armTime = null;
      return;
    }
    if (!this.anchor) {
      if (!readyToPlay(ahead, this.eof, this.startAhead)) { this.armTime = null; this.hold(); return; }
      // Tampon prêt : le son part dès que l'horloge vidéo tourne vraiment (ancre sur une horloge en marche, pas sur un « play »).
      if (this.armTime !== null && this.armTime !== v.currentTime) this.startAudio();
      else this.armTime = v.currentTime;
      return;
    }
    if (underrun(ahead, this.eof, UNDERRUN_S)) {
      this.stopNodes();
      this.anchor = null;
      this.hold();
      return;
    }
    const drift = driftSeconds(this.anchor, this.ctx.currentTime, v.currentTime);
    this.counters.driftMs = drift * 1000;
    this.counters.maxDriftMs = Math.max(this.counters.maxDriftMs, Math.abs(drift) * 1000);
    const verdict = driftVerdict(drift, this.strikes);
    this.strikes = verdict.strikes;
    if (verdict.resync) { this.recalibrate(); this.counters.resyncs++; }
    this.pump();
  }

  private hold(): void {
    if (this._holding) return;
    this._holding = true;
    this.counters.holds++;
    this.stopNodes();
    this.anchor = null;
    this.armTime = null;
    // Pause posée par nous : l'événement « pause » qui suit est ignoré (holding) par le moteur HTML.
    try { this.video.pause(); } catch { /* ignoré */ }
    this.opts.onChange?.();
  }

  private resumeVideo(): void {
    try {
      const r = this.video.play();
      if (r && typeof (r as Promise<void>).catch === 'function') void (r as Promise<void>).catch(() => undefined);
    } catch { /* ignoré */ }
  }

  // ---- Ancre et programmation -------------------------------------------------------------------------------------

  private latency(): number {
    const l = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(0.15, Math.max(0, l));
  }

  private startAudio(): void {
    void this.ctx.resume().catch(() => undefined);
    this.anchor = { media: this.video.currentTime, ctx: this.ctx.currentTime, rate: this.video.playbackRate || 1 };
    this.prev = null;
    this.strikes = 0;
    this.armTime = null;
    this.pump();
  }

  /** Nouvelle ancre sur la position vidéo courante : les nœuds déjà programmés sont arrêtés et reprogrammés depuis la file. */
  private recalibrate(): void {
    if (!this.anchor) return;
    this.stopNodes();
    this.anchor = { media: this.video.currentTime, ctx: this.ctx.currentTime, rate: this.video.playbackRate || 1 };
    this.prev = null;
    this.strikes = 0;
    this.lastResyncAt = this.ctx.currentTime;
    this.pump();
  }

  private pump(): void {
    const a = this.anchor;
    if (!a) return;
    const now = this.ctx.currentTime;
    // Les segments joués depuis plus d'un quart de seconde quittent la file (mémoire bornée).
    const keepFrom = this.video.currentTime - 0.25;
    while (this.queue.length && this.queue[0].timestamp + this.queue[0].duration < keepFrom && !this.nodesOf(this.queue[0])) {
      const old = this.queue.shift() as PcmChunk;
      this.scheduled.delete(old);
      this.queuedBytes -= old.bytes;
    }
    const horizon = now + LOOKAHEAD_S;
    const latency = this.latency();
    for (const c of this.queue) {
      if (this.scheduled.has(c)) continue;
      // Déjà joué, ou absorbé par la compensation de latence de sortie (le départ est avancé de `latency`) : rien à signaler.
      if (c.timestamp + c.duration <= a.media + latency * a.rate) { this.scheduled.add(c); continue; }
      const when0 = a.ctx + (c.timestamp - a.media) / a.rate - latency;
      if (when0 > horizon) break;
      const place = placeChunk({ ts: c.timestamp, duration: c.duration, anchor: a, ctxNow: now, latency, prev: this.prev });
      this.scheduled.add(c);
      if (place.kind === 'skip') { this.counters.late++; continue; }
      if (place.gap > 0.005) this.counters.gaps++;
      const node = this.ctx.createBufferSource();
      node.buffer = c.buffer;
      node.playbackRate.value = a.rate;
      node.connect(this.gain);
      node.onended = () => { this.nodes.delete(node); };
      node.start(place.when, place.offset);
      this.nodes.set(node, c);
      this.prev = { mediaEnd: c.timestamp + c.duration, whenEnd: place.when + (c.duration - place.offset) / a.rate };
      this.counters.chunksScheduled++;
    }
  }

  private nodesOf(c: PcmChunk): boolean {
    for (const k of this.nodes.values()) if (k === c) return true;
    return false;
  }

  private stopNodes(): void {
    for (const node of this.nodes.keys()) {
      node.onended = null;
      try { node.stop(); } catch { /* jamais démarré */ }
      try { node.disconnect(); } catch { /* déjà détaché */ }
    }
    this.nodes.clear();
    this.scheduled.clear();
    this.prev = null;
  }

  private applyGain(): void {
    const target = this._muted ? 0 : this._volume;
    try { this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01); } catch { this.gain.gain.value = target; }
  }

  // ---- File de segments PCM et décodage ---------------------------------------------------------------------------

  /** Vide la file (seek) : le flux en cours est invalidé. */
  private flush(): void {
    this.gen++;
    this.stopNodes();
    this.anchor = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.lastEnd = Number.NEGATIVE_INFINITY;
    this.eof = false;
    this.feeding = false;
  }

  private restartFeed(from: number): void {
    if (this.destroyed || this.failed) return;
    this.flush();
    void this.feed(this.gen, from, this.opts.retries ?? 3);
  }

  private async feed(gen: number, from: number, retries: number): Promise<void> {
    this.feeding = true;
    let start = from;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.pull(gen, start);
          return;
        } catch (error) {
          if (gen !== this.gen || this.destroyed) return;
          this.counters.errors++;
          if (attempt >= retries) {
            this.failed = true;
            this.stopNodes();
            this.anchor = null;
            this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
            this.opts.onChange?.();
            return;
          }
          await sleep(500);
          // Reprise là où le flux s'est interrompu : la file déjà décodée reste valable.
          start = Math.max(this.video.currentTime, Number.isFinite(this.lastEnd) ? this.lastEnd : 0);
        }
      }
    } finally {
      if (gen === this.gen) this.feeding = false;
    }
  }

  /** Remplit la file depuis `from` jusqu'à la fin du flux, en gardant au plus maxAhead de son d'avance. */
  private async pull(gen: number, from: number): Promise<void> {
    const it = this.source.chunks(Math.max(0, from - 0.1));
    try {
      for (;;) {
        if (gen !== this.gen) return;
        if (aheadSeconds(this.lastEnd, this.video.currentTime) >= this.maxAhead) {
          await sleep(40);
          continue;
        }
        const next = await it.next();
        if (gen !== this.gen) return;
        if (next.done) { this.eof = true; return; }
        const c = next.value;
        // Pré-roll d'un seek : segments entièrement antérieurs à la position, inutiles.
        if (c.timestamp + c.duration <= this.video.currentTime - 0.25) continue;
        this.queue.push(c);
        this.queuedBytes += c.bytes;
        this.lastEnd = Math.max(this.lastEnd, c.timestamp + c.duration);
      }
    } finally {
      void it.return(undefined).catch(() => undefined);
    }
  }

  /** Position média que la sortie audio joue en ce moment (pour la mesure), ou null si le son ne joue pas. */
  playingMedia(): number | null {
    return this.anchor ? mappedMedia(this.anchor, this.ctx.currentTime) : null;
  }

  /** Dernier recalage (horloge du contexte), pour les tests. */
  get lastResync(): number { return this.lastResyncAt; }
  get isFeeding(): boolean { return this.feeding; }
  get driftThreshold(): number { return DRIFT_RESYNC_S; }
}
