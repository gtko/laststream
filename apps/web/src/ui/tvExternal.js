/* TV en direct : lecteurs externes. Dans la coque Windows, mpv lit la playlist HLS proxifiée ; dans l'application Android,
 * le plugin natif LaststreamPlayer (libVLC) l'ouvre. Hors de ces deux cas, le lecteur de la page (hls.js) s'en charge.
 * Dans les deux cas l'URL transmise est celle du proxy /lt/tv/hls avec sa signature, telle que renvoyée par le serveur. */
import { MpvEngine } from '../player/engines.js';
import { connectShell, isShellEnvironment } from '../player/shell';

let mpv = null;
let mpvShell = null;
let nativeHandles = [];
let nativeOpen = false;

/** Plugin Capacitor du lecteur natif (Android), ou null. */
export function nativePlugin() {
  try {
    const C = globalThis.Capacitor;
    if (C && typeof C.isNativePlatform === 'function' && C.isNativePlatform() && C.Plugins && C.Plugins.LaststreamPlayer) return C.Plugins.LaststreamPlayer;
  } catch (_) { /* pas de Capacitor */ }
  return null;
}

/** 'native' (Android), 'mpv' (coque Windows) ou null (lecteur de la page). */
export function externalKind() {
  if (nativePlugin()) return 'native';
  return isShellEnvironment() ? 'mpv' : null;
}

/**
 * Lance `url` dans le lecteur externe. Résout true si lancé, false si ce lecteur n'est pas joignable (la page lit alors
 * le flux elle-même). `onError` : échec de lecture ; `onClosed` : l'utilisateur a quitté le lecteur natif.
 */
export async function startExternal(kind, url, { title, container, onError, onClosed }) {
  stopExternal(kind === 'native');
  if (kind === 'native') {
    const p = nativePlugin();
    if (!p) return false;
    try {
      await p.open({ url, title: title || '' });
      nativeOpen = true;
      const add = async (ev, fn) => { try { const h = await p.addListener(ev, fn); if (h) nativeHandles.push(h); } catch (_) { /* écouteur indisponible */ } };
      await add('error', () => onError && onError());
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
    mpv.on('error', () => { if (mpv && mpv.onFail) mpv.onFail(); });
  }
  mpv.onFail = onError;
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
}
