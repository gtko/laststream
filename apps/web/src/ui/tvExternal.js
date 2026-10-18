/* TV en direct : lecteurs externes. Dans la coque Windows, mpv lit la playlist HLS proxifiée ; dans l'application Android,
 * le plugin natif LaststreamPlayer (libVLC) l'ouvre. Hors de ces deux cas, le lecteur de la page (hls.js) s'en charge.
 * Dans les deux cas l'URL transmise est celle du proxy /lt/tv/hls avec sa signature, telle que renvoyée par le serveur. */
import { MpvEngine } from '../player/engines.js';
import { NativePlayer, isNativePlayer, nativeAudioTracks, nativeSubtitleTracks } from '../player/native';
import { connectShell, isShellEnvironment, mpvAudioTracks, mpvSubtitleTracks, setShellFullscreen } from '../player/shell';
import { trackOptions, techFromTracks, NONE } from './tvControls.js';

let mpv = null;
let mpvShell = null;
let shellFs = false; // plein écran de la fenêtre coque, tel que la coque l'annonce (`win-set-visibility`)
let nativeHandles = [];
let nativeOpen = false;
let nativePos = -1; // position du lecteur natif (événement `progress`), -1 : pas encore reçue
let nativePaused = false; // état de pause (événement `state`)
let nativeAudio = []; // pistes audio et sous-titres (événement `tracks`)
let nativeSubs = [];
let tvSaved = []; // styles d'origine modifiés pendant la lecture mpv : restaurés dans l'ordre inverse

/** Plugin Capacitor du lecteur natif (Android), ou null. */
export function nativePlugin() {
  try {
    const C = globalThis.Capacitor;
    if (C && typeof C.isNativePlatform === 'function' && C.isNativePlatform() && C.Plugins && C.Plugins.LaststreamPlayer) return C.Plugins.LaststreamPlayer;
  } catch (_) { /* pas de Capacitor */ }
  return isNativePlayer() ? NativePlayer : null;
}

/** 'native' (Android), 'mpv' (coque Windows) ou null (lecteur de la page). */
export function externalKind() {
  if (nativePlugin()) return 'native';
  return isShellEnvironment() ? 'mpv' : null;
}

/**
 * Transparence de la page pendant la lecture mpv (mpv dessine sous la fenêtre web) : fond transparent du lecteur, de ses
 * ancêtres, de body et de html ; autres enfants de body masqués ; <video> de la page masquée (son fond noir recouvrait mpv).
 * Chaque style modifié est mémorisé puis remis tel quel. Idempotent : `on` sans effet si déjà appliqué.
 */
export function setTvTransparent(on, container) {
  if (!on) {
    tvSaved.reverse().forEach(({ el, prop, value }) => { el.style[prop] = value; });
    tvSaved = [];
    return;
  }
  if (tvSaved.length || !container) return;
  const chain = [];
  for (let c = container; c; c = c.parentElement) chain.push(c);
  [document.body, document.documentElement].forEach((el) => { if (!chain.includes(el)) chain.push(el); });
  const save = (el, prop, value) => { tvSaved.push({ el, prop, value: el.style[prop] }); el.style[prop] = value; };
  chain.forEach((el) => save(el, 'background', 'transparent'));
  Array.from(document.body.children).filter((el) => !chain.includes(el) && el.style.visibility !== 'hidden')
    .forEach((el) => save(el, 'visibility', 'hidden'));
  const video = container.querySelector('video');
  if (video) save(video, 'visibility', 'hidden');
}

/**
 * Échantillon de lecture du lecteur externe (position, présence d'image, pause), ou null si aucun lecteur externe n'est
 * actif. Natif : l'image est supposée présente (le plugin ne renseigne pas les pistes vidéo).
 */
export function externalSample() {
  if (nativeOpen) return { time: nativePos, hasVideo: true, paused: nativePaused };
  if (mpv && mpv.live) {
    const tracks = Array.isArray(mpv.p['track-list']) ? mpv.p['track-list'] : [];
    return { time: Number(mpv.p['time-pos']) || 0, hasVideo: tracks.some((t) => t && t.type === 'video'), paused: !!mpv.p.pause };
  }
  return null;
}

/**
 * Commandes du lecteur externe actif (mpv ou plugin natif), ou null si c'est le lecteur de la page qui lit.
 * Même forme que les commandes de la page (player.js) : pause, volume, plein écran, pistes, qualité, infos techniques.
 * Ce que le lecteur ne sait pas faire (volume du plugin natif, PiP, qualité) est signalé par `canVolume`, `canFullscreen`…
 */
export function externalControls() {
  if (nativeOpen) {
    const p = nativePlugin();
    const call = (r) => { if (r && r.catch) r.catch(() => {}); };
    return {
      kind: 'native',
      paused: () => nativePaused,
      togglePause() {
        nativePaused = !nativePaused;
        call(nativePaused ? p.pause() : p.play());
      },
      canVolume: false, muted: () => false, setMuted: () => {}, volume: () => 1, setVolume: () => {},
      canFullscreen: false, fullscreen: () => false, setFullscreen: () => {},
      canPip: false, pip: () => false, setPip: () => {},
      audio: () => trackOptions(nativeAudioTracks(nativeAudio)),
      setAudio: (id) => call(p.setAudioTrack({ id: Number(id) })),
      subs: () => trackOptions(nativeSubtitleTracks(nativeSubs), 'Désactivés'),
      setSub: (id) => call(p.setSubtitleTrack({ id: Number(id) })),
      levels: () => [], setLevel: () => {},
      tech: () => ({}),
    };
  }
  if (mpv && mpv.live) {
    const tl = () => (Array.isArray(mpv.p['track-list']) ? mpv.p['track-list'] : []);
    return {
      kind: 'mpv',
      paused: () => !!mpv.p.pause,
      togglePause: () => { if (mpv.p.pause) mpv.play(); else mpv.pause(); },
      canVolume: true, muted: () => !!mpv.p.mute, setMuted: (m) => mpv.setMuted(m),
      volume: () => (Number(mpv.p.volume) || 0) / 100, setVolume: (v) => mpv.setVolume(v),
      canFullscreen: !!mpvShell, fullscreen: () => shellFs, setFullscreen: (on) => exitOrEnterShell(on),
      canPip: false, pip: () => false, setPip: () => {},
      audio: () => trackOptions(mpvAudioTracks(tl())),
      setAudio: (id) => mpv.setAudioTrack(id),
      subs: () => trackOptions(mpvSubtitleTracks(tl()), 'Désactivés'),
      setSub: (id) => mpv.setSubtitleTrack(id === NONE ? null : id),
      levels: () => [], setLevel: () => {},
      tech: () => techFromTracks(tl()),
    };
  }
  return null;
}

function exitOrEnterShell(on) {
  if (!mpvShell) return;
  setShellFullscreen(mpvShell, !!on);
  shellFs = !!on;
}

/** Quitte le plein écran de la coque (sans effet sinon) : appelé avant de fermer le lecteur. */
export function exitExternalFullscreen() {
  if (shellFs) exitOrEnterShell(false);
}

/**
 * Lance `url` dans le lecteur externe. Résout true si lancé, false si ce lecteur n'est pas joignable (la page lit alors
 * le flux elle-même). `onError(raison)` : échec de lecture (erreur mpv ou du plugin natif) ; `onClosed` : l'utilisateur a
 * quitté le lecteur natif.
 */
export async function startExternal(kind, url, { title, container, onError, onClosed }) {
  stopExternal(kind === 'native');
  if (kind === 'native') {
    const p = nativePlugin();
    if (!p) return false;
    try {
      await p.open({ url, title: title || '' });
      nativeOpen = true;
      nativePos = -1;
      nativePaused = false;
      nativeAudio = [];
      nativeSubs = [];
      const add = async (ev, fn) => { try { const h = await p.addListener(ev, fn); if (h) nativeHandles.push(h); } catch (_) { /* écouteur indisponible */ } };
      await add('progress', (d) => { nativePos = Number(d && d.position) || 0; });
      await add('state', (s) => { nativePaused = !!(s && s.paused); });
      await add('tracks', (t) => { nativeAudio = (t && t.audio) || []; nativeSubs = (t && t.subs) || []; });
      await add('error', (e) => onError && onError(e));
      await add('closed', () => { nativeOpen = false; stopExternal(); if (onClosed) onClosed(); });
      return true;
    } catch (_) {
      return false;
    }
  }
  const shell = await connectShell();
  if (!shell) return false;
  if (!mpv || mpvShell !== shell) {
    mpv = new MpvEngine(shell, container);
    mpvShell = shell;
    mpv.on('error', (e) => { if (mpv && mpv.onFail) mpv.onFail(e); });
    // La coque annonce ses changements de plein écran (touche, bouton de la fenêtre) : le bouton du lecteur suit.
    shell.on('win-set-visibility', (v) => { if (v && typeof v.fullscreen === 'boolean') shellFs = v.fullscreen; });
  }
  mpv.onFail = onError;
  // Avant mpv.load : MpvEngine modifie déjà les mêmes styles, on mémorise donc les valeurs d'origine.
  setTvTransparent(true, container);
  await mpv.load({ url });
  return true;
}

/** Arrête la lecture externe en cours (sans effet si aucune). */
export function stopExternal(keepNative) {
  nativeHandles.forEach((h) => { try { h.remove(); } catch (_) { /* déjà retiré */ } });
  nativeHandles = [];
  const p = nativePlugin();
  if (!keepNative && nativeOpen && p && typeof p.close === 'function') { try { Promise.resolve(p.close()).catch(() => {}); } catch (_) { /* ignoré */ } }
  if (!keepNative) { nativeOpen = false; nativePaused = false; nativeAudio = []; nativeSubs = []; }
  if (mpv && mpv.live) { mpv.onFail = null; mpv.destroy(); }
  // Restauration en dernier : elle remet les styles d'origine, après ceux de MpvEngine.
  setTvTransparent(false);
}
