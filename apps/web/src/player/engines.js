/* Moteurs de lecture : HTML5 (direct ou HLS via hls.js), mpv (coque Windows) et lecteur natif Android (libVLC). Même interface pour les deux :
 *   on(event, fn), load({ url, hls, startAt }), play(), pause(), seek(s), setVolume(0..1), setMuted(b), setRate(r),
 *   state(), audioTracks(), setAudioTrack(id), subtitleTracks(), setSubtitleTrack(id|null), nativeCues(), destroy()
 * Événements : state, ended, error, tracks, ready, buffering. */
import { audioTrackLabel, langName, trackLang } from './tracks';
import { nativeAudioTracks, nativeSubtitleTracks } from './native';
import { loadfileArgs, mpvAudioTracks, mpvSubtitleTracks, mpvVersionAtLeast } from './shell';
import { marginProps, mpvMargins, sameMargins, ZERO_MARGINS } from './mini';
import { PageHole } from './minihole.js';

class Emitter {
  constructor() { this.ls = new Map(); }
  on(ev, fn) { this.ls.set(ev, [...(this.ls.get(ev) || []), fn]); return this; }
  emit(ev, ...a) { (this.ls.get(ev) || []).forEach((fn) => { try { fn(...a); } catch (_) { /* un écouteur ne casse pas le moteur */ } }); }
}

/** `play()` renvoie une promesse refusée si l'autoplay est bloqué ; absente ou muette dans certains environnements. */
function safePlay(v) {
  try {
    const r = v.play();
    if (r && typeof r.catch === 'function') return r.catch(() => {});
  } catch (_) { /* ignoré */ }
  return Promise.resolve();
}

let hlsPromise = null;
function loadHls() {
  if (!hlsPromise) {
    hlsPromise = import('hls.js').then((m) => m.default);
    hlsPromise.catch(() => { hlsPromise = null; });
  }
  return hlsPromise;
}

const VIDEO_EVENTS = ['timeupdate', 'play', 'pause', 'volumechange', 'ratechange', 'progress', 'waiting', 'playing', 'seeking', 'seeked', 'loadedmetadata', 'durationchange', 'canplay'];

export class HtmlEngine extends Emitter {
  constructor(video) {
    super();
    this.kind = 'html';
    this.video = video;
    this.hls = null;
    this.pendingStart = 0;
    this.hlsSubIndex = -1;
    this.net = 0;
    this.media = 0;
    VIDEO_EVENTS.forEach((e) => video.addEventListener(e, () => this.emit('state')));
    video.addEventListener('ended', () => this.emit('ended'));
    video.addEventListener('error', () => {
      if (!video.getAttribute('src') && !this.hls) return; // vidage volontaire de l'élément
      this.emit('error', new Error('media-error:' + (video.error ? video.error.code : '?')));
    });
    video.addEventListener('loadedmetadata', () => {
      if (this.pendingStart > 0 && !this.hls) { try { video.currentTime = this.pendingStart; } catch (_) { /* ignoré */ } }
      this.pendingStart = 0;
      this.emit('tracks');
      this.emit('ready');
    });
    const al = video.audioTracks;
    if (al && al.addEventListener) { al.addEventListener('addtrack', () => this.emit('tracks')); al.addEventListener('change', () => this.emit('tracks')); }
  }

  async load({ url, hls, startAt }) {
    this.teardown();
    const v = this.video;
    this.pendingStart = startAt || 0;
    if (!hls) {
      v.src = url;
      safePlay(v);
      return;
    }
    const H = await loadHls();
    if (H && H.isSupported()) {
      const h = new H({
        startPosition: startAt > 0 ? startAt : -1,
        maxBufferLength: 40,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 5,
        subtitleDisplay: false,
        enableWebVTT: true,
        // Le chargement ne démarre qu'après le choix de la piste audio : sinon la piste par défaut du fichier (souvent la VO)
        // est transcodée pour rien avant de basculer.
        autoStartLoad: false,
      });
      this.hls = h;
      h.on(H.Events.MANIFEST_PARSED, () => {
        this.emit('tracks'); // la session choisit la piste audio (`hls.audioTrack`) avant la première requête
        h.startLoad(startAt > 0 ? startAt : -1);
        safePlay(v);
      });
      h.on(H.Events.AUDIO_TRACKS_UPDATED, () => this.emit('tracks'));
      h.on(H.Events.AUDIO_TRACK_SWITCHED, () => this.emit('tracks'));
      h.on(H.Events.SUBTITLE_TRACKS_UPDATED, () => this.emit('tracks'));
      h.on(H.Events.FRAG_LOADED, () => { this.net = 0; this.media = 0; });
      h.on(H.Events.ERROR, (_e, d) => {
        if (!d || !d.fatal) return;
        if (d.type === H.ErrorTypes.NETWORK_ERROR && this.net++ < 2) h.startLoad();
        else if (d.type === H.ErrorTypes.MEDIA_ERROR && this.media++ < 2) h.recoverMediaError();
        else this.emit('error', new Error('hls:' + (d.details || d.type)));
      });
      h.loadSource(url);
      h.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      safePlay(v);
    } else {
      throw new Error('hls-unsupported');
    }
  }

  teardown() {
    if (this.hls) { try { this.hls.destroy(); } catch (_) { /* déjà détruit */ } this.hls = null; }
    this.hlsSubIndex = -1;
  }

  destroy() {
    this.teardown();
    const v = this.video;
    try { v.pause(); } catch (_) { /* ignoré */ }
    v.removeAttribute('src');
    try { v.load(); } catch (_) { /* ignoré */ }
  }

  play() { return safePlay(this.video); }
  pause() { this.video.pause(); }
  seek(t) { try { this.video.currentTime = Math.max(0, t); } catch (_) { /* pas encore prêt */ } }
  setVolume(v) { this.video.volume = Math.min(1, Math.max(0, v)); }
  setMuted(m) { this.video.muted = !!m; }
  setRate(r) { this.video.playbackRate = r; }

  state() {
    const v = this.video;
    const ranges = [];
    for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
    return {
      time: v.currentTime || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      ended: v.ended,
      seeking: v.seeking,
      buffering: !v.paused && !v.ended && v.readyState < 3,
      buffered: ranges,
      volume: v.volume,
      muted: v.muted,
      rate: v.playbackRate,
      pip: document.pictureInPictureElement === v,
    };
  }

  audioTracks() {
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length) {
      return this.hls.audioTracks.map((t, i) => {
        const lang = trackLang(t.lang || t.language, t.name);
        const ch = parseInt(t.channels, 10) || 0;
        return { id: String(i), title: t.name || '', lang, codec: String(t.audioCodec || '').toLowerCase(), channels: ch, selected: i === this.hls.audioTrack, label: audioTrackLabel({ lang, title: t.name, codec: t.audioCodec, channels: ch }) };
      });
    }
    const al = this.video.audioTracks;
    if (al && al.length) {
      return Array.from({ length: al.length }, (_, i) => {
        const t = al[i];
        const lang = trackLang(t.language, t.label);
        return { id: String(i), title: t.label || '', lang, codec: '', channels: 0, selected: !!t.enabled, label: audioTrackLabel({ lang, title: t.label }) };
      });
    }
    return [];
  }

  setAudioTrack(id) {
    const i = Number(id);
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length) { this.hls.audioTrack = i; return; }
    const al = this.video.audioTracks;
    if (al) for (let k = 0; k < al.length; k++) al[k].enabled = k === i;
  }

  /** Sous-titres proposés par le flux HLS (le serveur de streaming les expose en WebVTT). */
  subtitleTracks() {
    if (!this.hls || !this.hls.subtitleTracks) return [];
    return this.hls.subtitleTracks.map((t, i) => {
      const lang = trackLang(t.lang, t.name);
      return { id: 'h' + i, title: t.name || '', lang, codec: 'webvtt', forced: !!t.forced, origin: 'embedded', renderable: true, engineId: i, selected: i === this.hlsSubIndex, label: (lang ? langName(lang) : t.name || 'Sous-titres') + (t.forced ? ' (forcés)' : '') };
    });
  }

  setSubtitleTrack(id) {
    if (!this.hls) return;
    if (id === null) { this.hlsSubIndex = -1; this.hls.subtitleTrack = -1; return; }
    const i = Number(String(id).replace(/^h/, ''));
    this.hlsSubIndex = i;
    this.hls.subtitleDisplay = false;
    this.hls.subtitleTrack = i;
  }

  /** Cues de la piste hls.js chargée (affichage assuré par notre calque, pas par le navigateur). */
  nativeCues() {
    if (this.hlsSubIndex < 0) return [];
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if ((t.kind === 'subtitles' || t.kind === 'captions') && t.mode !== 'disabled') {
        if (t.mode === 'showing') t.mode = 'hidden';
        // hls.js ajoute les cues segment par segment, pas forcément dans l'ordre : la recherche dichotomique exige un tri.
        return t.cues ? Array.from(t.cues).map((c) => ({ start: c.startTime, end: c.endTime, text: c.text })).sort((x, y) => x.start - y.start) : [];
      }
    }
    return [];
  }

  supportsPip() { return !!document.pictureInPictureEnabled && !this.video.disablePictureInPicture; }
  async togglePip() {
    const v = this.video;
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  }
}

/** mpv piloté par la coque Windows : la fenêtre mpv est sous la page, rendue transparente pendant la lecture. */
export class MpvEngine extends Emitter {
  constructor(ipc, container) {
    super();
    this.kind = 'mpv';
    this.ipc = ipc;
    this.container = container;
    this.p = { 'time-pos': 0, duration: 0, pause: false, volume: 100, mute: false, speed: 1, 'paused-for-cache': false, seeking: false, 'demuxer-cache-time': 0, 'track-list': [], aid: null, sid: null };
    this.loaded = false;
    this.version = '';
    this.hidden = [];
    this.transparent = false;
    this.miniRect = null; // vignette du mini-lecteur (px de la fenêtre) ; null : plein lecteur
    this.margins = { ...ZERO_MARGINS }; // dernières marges envoyées à mpv
    this.hole = new PageHole();
    this.nativeSub = false;
    this.lastEmit = 0;
    ['time-pos', 'volume', 'pause', 'seeking', 'eof-reached', 'duration', 'track-list', 'paused-for-cache', 'demuxer-cache-time', 'aid', 'sid', 'speed', 'mute', 'mpv-version'].forEach((n) => ipc.send('mpv-observe-prop', n));
    ipc.on('mpv-prop-change', (a) => this.onProp(a));
    ipc.on('mpv-event-ended', (a) => {
      if (!this.live) return;
      if (a && a.error) this.emit('error', new Error('mpv:' + (a.error.message || a.error)));
      else if (!a || !a.reason || a.reason === 'eof' || a.reason === 'other') {
        const { 'time-pos': t, duration: d } = this.p;
        if (!(d && t + 60 < d)) this.emit('ended');
      }
    });
  }

  onProp(a) {
    if (!a || !a.name) return;
    // La version de mpv arrive juste après l'observation, avant tout chargement : elle fixe la syntaxe de `loadfile`.
    if (a.name === 'mpv-version') this.version = String(a.data || '');
    if (!this.live) return;
    this.p[a.name] = a.data;
    if (a.name === 'track-list') { this.emit('tracks'); }
    if (a.name === 'aid' || a.name === 'sid') {
      // mpv ne ré-émet pas `track-list` quand la piste change : on aligne les indicateurs `selected` pour que le panneau suive.
      const type = a.name === 'aid' ? 'audio' : 'sub';
      const list = this.p['track-list'];
      if (Array.isArray(list)) this.p['track-list'] = list.map((t) => (t.type === type ? { ...t, selected: Number(a.data) === t.id } : t));
      this.emit('tracks');
    }
    if (a.name === 'duration' && a.data > 0 && !this.loaded) { this.loaded = true; this.emit('ready'); }
    const now = Date.now();
    if (a.name !== 'time-pos' || now - this.lastEmit > 250) { this.lastEmit = now; this.emit('state'); }
  }

  setTransparent(on) {
    const els = [];
    for (let c = this.container; c; c = c.parentElement) els.push(c);
    els.push(document.body, document.documentElement);
    els.forEach((el) => { el.style.background = on ? 'transparent' : ''; });
    this.transparent = on;
    this.hole.keep = els;
    this.syncPage();
  }

  /**
   * Mini-lecteur : l'image mpv est calée dans `rect` (px de la fenêtre) par les marges mpv et la page est percée à cet endroit,
   * au lieu d'être masquée. `null` : retour au plein lecteur (marges à 0, page masquée sous la vidéo comme avant).
   */
  setMini(rect) {
    this.miniRect = rect ? { ...rect } : null;
    this.syncPage();
  }

  syncPage() {
    const mini = this.transparent && this.miniRect;
    if (this.transparent && !mini) {
      // Le reste de la page (accueil, fiche…) masquerait la vidéo mpv, qui est sous la fenêtre web.
      if (!this.hidden.length) {
        this.hidden = [...document.body.children].filter((el) => !this.hole.keep.includes(el) && el.style.visibility !== 'hidden');
        this.hidden.forEach((el) => { el.style.visibility = 'hidden'; });
      }
    } else {
      this.hidden.forEach((el) => { el.style.visibility = ''; });
      this.hidden = [];
    }
    this.hole.apply(mini ? this.miniRect : null);
    this.sendMargins(mini ? mpvMargins(this.miniRect, { width: window.innerWidth, height: window.innerHeight }) : { ...ZERO_MARGINS });
  }

  sendMargins(m) {
    if (sameMargins(this.margins, m)) return;
    this.margins = m;
    marginProps(m).forEach(([name, value]) => this.ipc.send('mpv-set-prop', [name, value]));
  }

  async load({ url, startAt }) {
    this.live = true;
    this.loaded = false;
    this.ipc.send('mpv-command', ['stop']);
    this.setTransparent(true);
    // La syntaxe de loadfile dépend de la version de mpv, annoncée juste après l'observation de `mpv-version`.
    if (!this.version) await new Promise((r) => setTimeout(r, 400));
    this.ipc.send('mpv-command', ['loadfile', ...loadfileArgs(url, startAt || 0, mpvVersionAtLeast(this.version || '0.0', '0.39'))]);
    this.ipc.send('mpv-set-prop', ['sid', 'no']);
    this.ipc.send('mpv-set-prop', ['pause', false]);
    this.ipc.send('mpv-set-prop', ['mute', 'no']);
  }

  destroy() {
    this.live = false;
    this.ipc.send('mpv-command', ['stop']);
    this.setTransparent(false);
  }

  play() { this.ipc.send('mpv-set-prop', ['pause', false]); }
  pause() { this.ipc.send('mpv-set-prop', ['pause', true]); }
  seek(t) { this.p['time-pos'] = Math.max(0, t); this.ipc.send('mpv-set-prop', ['time-pos', Math.max(0, t)]); }
  // Mise à jour immédiate de l'état : l'icône suit le clic sans attendre (ni dépendre de) l'écho de mpv.
  setVolume(v) { this.ipc.send('mpv-set-prop', ['mute', 'no']); this.ipc.send('mpv-set-prop', ['volume', Math.round(v * 100)]); this.p.mute = false; this.p.volume = Math.round(v * 100); this.emit('state'); }
  setMuted(m) { this.ipc.send('mpv-set-prop', ['mute', m ? 'yes' : 'no']); this.p.mute = !!m; this.emit('state'); }
  setRate(r) { this.ipc.send('mpv-set-prop', ['speed', r]); }

  state() {
    const p = this.p;
    const cache = p['demuxer-cache-time'] > 0 ? p['demuxer-cache-time'] : 0;
    return {
      time: p['time-pos'] || 0,
      duration: p.duration || 0,
      paused: !!p.pause,
      ended: false,
      seeking: !!p.seeking,
      buffering: !!p['paused-for-cache'],
      buffered: cache ? [[0, cache]] : [],
      volume: (p.volume || 0) / 100,
      muted: p.mute === true || p.mute === 'yes' || p.mute === 1,
      rate: p.speed || 1,
      pip: false,
    };
  }

  audioTracks() { return mpvAudioTracks(this.p['track-list'] || []); }
  setAudioTrack(id) { this.ipc.send('mpv-set-prop', ['aid', Number(id)]); }
  subtitleTracks() { return mpvSubtitleTracks(this.p['track-list'] || []); }
  setSubtitleTrack(id) { this.ipc.send('mpv-set-prop', ['sid', id === null ? 'no' : Number(id)]); }
  nativeCues() { return []; }
  supportsPip() { return true; } // image dans l'image gérée par la coque (fenêtre réduite), voir session.togglePip
  togglePip() { return Promise.resolve(); }
}

/** Lecteur natif Android (libVLC, plugin Capacitor) : l'activité native porte l'image, le son et ses propres contrôles ;
 * ce moteur ne fait que relayer ses évènements (état, pistes, fin, erreur) et ses commandes. */
export class NativeEngine extends Emitter {
  constructor(plugin) {
    super();
    this.kind = 'native';
    this.plugin = plugin;
    this.p = { time: 0, duration: 0, paused: false, buffering: true, rate: 1 };
    this.audio = [];
    this.subs = [];
    this.loaded = false;
    this.live = false;
    this.closeTimer = null;
    const on = (ev, fn) => { plugin.addListener(ev, (d) => { if (this.live) fn(d || {}); }).catch(() => {}); };
    on('state', (d) => { this.setState(d); this.emit('state'); });
    on('progress', (d) => { this.setState(d); this.emit('state'); });
    on('tracks', (d) => { this.audio = d.audio || []; this.subs = d.subs || []; this.emit('tracks'); });
    on('ended', (d) => { this.setState(d); this.emit('ended'); });
    on('error', (d) => this.emit('error', new Error('native:' + (d.code || 'inconnue'))));
    // La fermeture par l'utilisateur est toujours transmise, même si la session prépare déjà une autre source.
    plugin.addListener('closed', (d) => { this.setState(d || {}); this.emit('closed', d); }).catch(() => {});
    on('selectSource', (d) => this.emit('selectSource', d));
    on('selectEpisode', (d) => this.emit('selectEpisode', d));
    on('loadSeason', (d) => this.emit('loadSeason', d));
    on('nextEpisode', () => this.emit('next'));
    on('trackChanged', (d) => this.emit('trackChanged', d));
  }

  setState(d) {
    const p = this.p;
    if (typeof d.position === 'number') p.time = d.position;
    if (typeof d.duration === 'number' && d.duration > 0) p.duration = d.duration;
    if (typeof d.paused === 'boolean') p.paused = d.paused;
    if (typeof d.buffering === 'boolean') p.buffering = d.buffering;
    if (typeof d.rate === 'number') p.rate = d.rate;
    if (!this.loaded && p.duration > 0 && p.time > 0) { this.loaded = true; this.emit('ready'); }
  }

  async load({ url, startAt, open }) {
    clearTimeout(this.closeTimer);
    this.live = true;
    this.loaded = false;
    this.p = { time: startAt || 0, duration: 0, paused: false, buffering: true, rate: 1 };
    this.audio = [];
    this.subs = [];
    await this.plugin.open({ ...open, url, startPosition: startAt || 0 });
  }

  /** Fermeture différée : un `load` immédiat (épisode suivant, autre source) réutilise l'activité sans la fermer. */
  destroy() {
    this.live = false;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => { this.plugin.close().catch(() => {}); }, 700);
  }

  /** La session prépare une autre source ou un autre épisode : l'activité reste ouverte (en attente), sans évènements. */
  detach() {
    this.live = false;
    clearTimeout(this.closeTimer);
  }

  closeNow() {
    this.live = false;
    clearTimeout(this.closeTimer);
    this.plugin.close().catch(() => {});
  }

  play() { this.plugin.play().catch(() => {}); }
  pause() { this.plugin.pause().catch(() => {}); }
  seek(t) { this.p.time = Math.max(0, t); this.plugin.seek({ position: Math.max(0, t) }).catch(() => {}); }
  setVolume() { /* volume du système */ }
  setMuted() { /* volume du système */ }
  setRate(r) { this.plugin.setRate({ rate: r }).catch(() => {}); }

  state() {
    const p = this.p;
    return { time: p.time, duration: p.duration, paused: p.paused, ended: false, seeking: false, buffering: p.buffering, buffered: [], volume: 1, muted: false, rate: p.rate, pip: false };
  }

  audioTracks() { return nativeAudioTracks(this.audio); }
  setAudioTrack(id) { this.plugin.setAudioTrack({ id: Number(id) }).catch(() => {}); }
  subtitleTracks() { return nativeSubtitleTracks(this.subs); }
  setSubtitleTrack(id) { this.plugin.setSubtitleTrack({ id: id === null ? -1 : Number(id) }).catch(() => {}); }
  addSubtitles(list) { if (list.length) this.plugin.addSubtitles({ subtitles: list }).catch(() => {}); }
  update(patch) { this.plugin.update(patch).catch(() => {}); }
  nativeCues() { return []; }
  supportsPip() { return false; }
  togglePip() { return Promise.resolve(); }
}
