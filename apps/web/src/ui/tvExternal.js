/* TV en direct : lecteurs externes. Dans la coque Windows, mpv lit la playlist HLS proxifiée ; dans l'application Android,
 * le plugin natif LaststreamPlayer (libVLC) l'ouvre. Hors de ces deux cas, le lecteur de la page (hls.js) s'en charge.
 * Dans les deux cas l'URL transmise est celle du proxy /lt/tv/hls avec sa signature, telle que renvoyée par le serveur. */
import { MpvEngine } from '../player/engines.js';
import { NativePlayer, isNativePlayer } from '../player/native';
import { connectShell, isShellEnvironment } from '../player/shell';

let mpv = null;
let mpvShell = null;
let nativeHandles = [];
let nativeOpen = false;
let nativePos = -1; // position du lecteur natif (événement `progress`), -1 : pas encore reçue
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
  if (nativeOpen) return { time: nativePos, hasVideo: true, paused: false };
  if (mpv && mpv.live) {
    const tracks = Array.isArray(mpv.p['track-list']) ? mpv.p['track-list'] : [];
    return { time: Number(mpv.p['time-pos']) || 0, hasVideo: tracks.some((t) => t && t.type === 'video'), paused: !!mpv.p.pause };
  }
  return null;
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
      const add = async (ev, fn) => { try { const h = await p.addListener(ev, fn); if (h) nativeHandles.push(h); } catch (_) { /* écouteur indisponible */ } };
      await add('progress', (d) => { nativePos = Number(d && d.position) || 0; });
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
  if (!keepNative) nativeOpen = false;
  if (mpv && mpv.live) { mpv.onFail = null; mpv.destroy(); }
  // Restauration en dernier : elle remet les styles d'origine, après ceux de MpvEngine.
  setTvTransparent(false);
}
