/* Aperçu d'image au survol de la barre : une vidéo secondaire muette, sur la même source, est déplacée à l'instant survolé
 * (cadence limitée, pointeur au repos) et dessinée dans un canevas ; les images sont gardées par seau de 10 s.
 * Affichage seulement : on ne lit jamais les pixels, un canevas « teinté » ne gêne donc pas. Ne bloque jamais la lecture. */
import { FrameCache, IDLE_TEARDOWN_HLS_MS, IDLE_TEARDOWN_MS, MAX_THUMB_FAILURES, REST_MS, bucketOf, bucketTime, shouldSeek, thumbSize } from './thumbs';

export class Thumbs {
  /**
   * @param canvas canevas visible du cadre d'aperçu
   * @param opts { allowed(): bool, duration(): number, source(): Promise<{url, hls}|null> }
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.opts = opts;
    this.cache = new FrameCache();
    this.video = null;
    this.hls = null;
    this.target = null; // { t, bucket }
    this.lastMoveAt = 0;
    this.lastSeekAt = 0;
    this.pending = null; // seau en cours de chargement
    this.timer = null;
    this.idleTimer = null; // détruit la vidéo d'aperçu quand la barre n'est plus survolée
    this.ready = false;
    this.gen = 0;
    this.failures = 0;
    this.dead = false; // trop d'échecs sur cette source : plus d'aperçu, sans bruit
  }

  /** Nouvelle source (changement de source ou d'épisode) : on repart de zéro. */
  reset() {
    this.cancel();
    this.cache.clear();
    this.teardownVideo();
    this.gen += 1;
    this.failures = 0;
    this.dead = false;
  }

  teardownVideo() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.hls) { try { this.hls.destroy(); } catch (_) { /* déjà détruit */ } this.hls = null; }
    if (this.video) {
      try { this.video.pause(); } catch (_) { /* ignoré */ }
      this.video.removeAttribute('src');
      try { this.video.load(); } catch (_) { /* ignoré */ }
      this.video.remove();
      this.video = null;
    }
    this.ready = false;
    this.pending = null;
  }

  /** Le pointeur est en `t` (secondes) : montre l'image la plus proche tout de suite, puis demande la bonne au repos. */
  request(t, now = Date.now()) {
    if (!this.ctx || this.dead || !this.opts.allowed()) { this.hideCanvas(); return false; }
    const bucket = bucketOf(t);
    if (!this.target || this.target.bucket !== bucket) this.lastMoveAt = now;
    this.target = { t, bucket };
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const near = this.cache.nearest(bucket);
    if (near) this.draw(near.value);
    this.canvas.hidden = !near;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), REST_MS + 10);
    return !!near;
  }

  /** Abandonne l'aperçu en cours (le pointeur a quitté la barre) ; une image en route est simplement ignorée. */
  cancel() {
    this.target = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.canvas.hidden = true;
    // Même sans vidéo encore : une ouverture en cours (source en attente) est alors abandonnée par release().
    // En HLS, chaque recréation ouvre une session du serveur : on garde la vidéo plus longtemps.
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.release(), this.hls ? IDLE_TEARDOWN_HLS_MS : IDLE_TEARDOWN_MS);
  }

  /** Barre au repos depuis un moment : plus de seconde lecture en parallèle ; les images gardées restent (cache borné). */
  release() {
    this.gen += 1; // une ouverture en cours (source, hls.js) est abandonnée
    this.teardownVideo();
  }

  hideCanvas() { this.canvas.hidden = true; }

  /** Dessine une image gardée à sa taille propre (ratio de la vidéo) ; le canevas visible prend la même taille. */
  draw(src) {
    const { width: w, height: h } = src;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    try { this.ctx.drawImage(src, 0, 0, w, h); } catch (_) { /* image non dessinable : on garde la précédente */ }
  }

  async tick() {
    const tg = this.target;
    if (!tg || this.dead || !this.opts.allowed()) return;
    const now = Date.now();
    if (!shouldSeek({ now, bucket: tg.bucket, lastMoveAt: this.lastMoveAt, lastSeekAt: this.lastSeekAt, pendingBucket: this.pending, cached: this.cache.has(tg.bucket) })) {
      // Trop tôt : on réessaie dès que la cadence le permet.
      if (!this.cache.has(tg.bucket) && this.pending !== tg.bucket) this.timer = setTimeout(() => this.tick(), 60);
      return;
    }
    const gen = this.gen;
    if (!(await this.ensureVideo())) return;
    if (gen !== this.gen || !this.target || this.target.bucket !== tg.bucket) return;
    this.lastSeekAt = Date.now();
    this.pending = tg.bucket;
    try { this.video.currentTime = bucketTime(tg.bucket, this.opts.duration()); } catch (_) { this.pending = null; }
  }

  async ensureVideo() {
    if (this.video) return true;
    const gen = this.gen;
    const src = await this.opts.source();
    if (!src || gen !== this.gen) return false;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;left:-9px;top:-9px';
    document.body.appendChild(v);
    this.video = v;
    // Un évènement tardif d'une vidéo déjà détruite ne touche ni l'état ni le compteur d'échecs de la suivante.
    v.addEventListener('seeked', () => { if (v === this.video) this.onSeeked(); });
    v.addEventListener('error', () => { if (v !== this.video) return; this.pending = null; this.fail(); });
    if (src.hls) {
      try {
        const H = (await import('hls.js')).default;
        if (gen !== this.gen) { v.remove(); if (this.video === v) this.video = null; return false; }
        if (!H.isSupported()) { v.remove(); if (this.video === v) this.video = null; return false; }
        const h = new H({ maxBufferLength: 2, maxMaxBufferLength: 4, startLevel: 0, capLevelToPlayerSize: true, enableWorker: true, subtitleDisplay: false });
        this.hls = h;
        h.on(H.Events.ERROR, (_e, d) => { if (d && d.fatal) { this.pending = null; this.fail(true); } });
        h.on(H.Events.MANIFEST_PARSED, () => { try { h.audioTrack = -1; } catch (_) { /* pas d'audio à charger */ } });
        h.loadSource(src.url);
        h.attachMedia(v);
      } catch (_) { return false; }
    } else {
      v.src = src.url;
    }
    this.ready = true;
    return true;
  }

  /** Échec de lecture de la vidéo d'aperçu : après quelques essais on abandonne cette source et on masque la vignette. */
  fail(fatal = false) {
    this.failures = fatal ? MAX_THUMB_FAILURES : this.failures + 1;
    if (this.failures >= MAX_THUMB_FAILURES) {
      this.dead = true;
      clearTimeout(this.timer);
      this.hideCanvas();
      this.teardownVideo();
    }
  }

  onSeeked() {
    const v = this.video;
    const b = this.pending;
    this.pending = null;
    if (!v || b === null) return;
    // Image prise dans un canevas hors écran, gardée pour ce seau.
    const { w, h } = thumbSize(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    try {
      c.getContext('2d').drawImage(v, 0, 0, w, h);
    } catch (_) {
      return;
    }
    this.cache.set(b, c);
    if (this.target && this.target.bucket === b) {
      this.draw(c);
      this.canvas.hidden = false;
    } else if (this.target) {
      // Le pointeur a changé de seau pendant le déplacement : on enchaîne.
      this.timer = setTimeout(() => this.tick(), 20);
    }
  }

  destroy() { this.reset(); }
}

