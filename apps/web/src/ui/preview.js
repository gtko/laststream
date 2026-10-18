/* Port du prototype (voir tools/port-prototype.mjs). */
import { getDetail } from './catalog.js';
import { DWELL_MS, REDUCE, STILL } from './constants.js';
import { app } from './dom.js';
import { state } from './state.js';
import { esc } from './util.js';

let dwellIO = null;
// ---------- Aperçu vidéo muet (mise en avant de l'accueil) ----------
export function postYT(iframe, func, args) {
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*');
  }
}

/**
 * Appelle `cb` quand la vidéo YouTube joue vraiment depuis `delayMs` (état 1 de l'API IFrame), une seule fois :
 * au démarrage et pendant le chargement, YouTube superpose titre, chaîne et boutons qu'on ne veut pas montrer.
 * Repli : `fallbackMs` après le chargement si l'iframe ne renvoie aucun état. Renvoie une fonction d'annulation.
 */
export function whenPlaying(iframe, cb, delayMs = 2600, fallbackMs = 6000) {
  let done = false;
  let timer = 0;
  const fire = () => { if (!done) { done = true; cleanup(); cb(); } };
  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    const st = d && d.info && d.info.playerState;
    if (st === 1 && !timer) timer = setTimeout(fire, delayMs);
    else if (st !== undefined && st !== 1 && timer) { clearTimeout(timer); timer = 0; }
  };
  const fallback = setTimeout(fire, fallbackMs);
  const cleanup = () => { window.removeEventListener('message', onMsg); clearTimeout(timer); clearTimeout(fallback); };
  window.addEventListener('message', onMsg);
  // Abonnement aux événements de l'API IFrame (infoDelivery.playerState).
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch (_) { /* iframe fermée */ }
  return () => { done = true; cleanup(); };
}

export function ytSrc(key, extra) {
  return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(key) + '?' + extra;
}
export const ambientSrc = (key) =>
  ytSrc(key, 'autoplay=1&mute=1&controls=0&loop=1&playlist=' + encodeURIComponent(key) +
    '&modestbranding=1&rel=0&playsinline=1&disablekb=1&iv_load_policy=3&cc_load_policy=0&fs=0&enablejsapi=1&origin=' + encodeURIComponent(location.origin));

export function fitPreview(p) {
  const w0 = p.media.offsetWidth;
  const h0 = p.media.offsetHeight;
  if (!w0 || !h0) return;
  const k = 1.12; // léger débordement : masque les barres YouTube
  let w = w0 * k;
  let h = (w * 9) / 16;
  if (h < h0 * k) {
    h = h0 * k;
    w = (h * 16) / 9;
  }
  const s = p.iframe.style;
  s.width = w + 'px';
  s.height = h + 'px';
  s.left = (w0 - w) / 2 + 'px';
  s.top = (h0 - h) / 2 + 'px';
}

export function stopPreview() {
  const p = state.preview;
  if (!p) return;
  state.preview = null;
  try { postYT(p.iframe, 'pauseVideo'); } catch (_) { /* déjà fermé */ }
  if (p.ro) p.ro.disconnect();
  p.wrap.remove();
  p.btn.remove();
}

export async function startPreview(media) {
  if (REDUCE || STILL || !media.isConnected || state.inDetail) return;
  const item = state.byKey.get(media.dataset.media);
  if (!item) return;
  const d = await getDetail(item);
  if (!d || !d.trailer || !media.isConnected || media._visible === false || state.inDetail) return;
  stopPreview();
  const wrap = document.createElement('div');
  wrap.className = 'preview';
  wrap.innerHTML = '<iframe title="Aperçu vidéo sans son" tabindex="-1" allow="autoplay; encrypted-media" src="' + esc(ambientSrc(d.trailer)) + '"></iframe>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'preview-sound';
  btn.setAttribute('data-preview-sound', '');
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', 'Activer le son');
  btn.textContent = 'Son';
  media.appendChild(wrap);
  media.appendChild(btn);
  const iframe = wrap.querySelector('iframe');
  const p = { media, wrap, btn, iframe, muted: true, ro: null };
  state.preview = p;
  p.ro = new ResizeObserver(() => fitPreview(p));
  p.ro.observe(media);
  fitPreview(p);
  iframe.addEventListener('load', () => {
    if (state.preview !== p) return;
    postYT(iframe, 'mute');
    postYT(iframe, 'playVideo');
    requestAnimationFrame(() => wrap.classList.add('is-on'));
  }, { once: true });
}

export function cancelDwell() {
  clearTimeout(state.dwell.timer);
  state.dwell.timer = null;
  state.dwell.el = null;
}

export function scheduleDwell(el) {
  cancelDwell();
  state.dwell.el = el;
  state.dwell.timer = setTimeout(() => {
    state.dwell.timer = null;
    state.dwell.el = null;
    if (el._visible !== false) startPreview(el);
  }, DWELL_MS);
}

export function onDwell(entries) {
  for (const e of entries) {
    const el = e.target;
    el._visible = e.intersectionRatio >= 0.5;
    if (el._visible) {
      if (state.dwell.el !== el && !(state.preview && state.preview.media === el)) scheduleDwell(el);
    } else {
      if (state.dwell.el === el) cancelDwell();
      if (state.preview && state.preview.media === el) stopPreview();
    }
  }
}

export function setupPreviews() {
  if (dwellIO) dwellIO.disconnect();
  dwellIO = null;
  if (REDUCE || STILL || !('IntersectionObserver' in window)) return;
  dwellIO = new IntersectionObserver(onDwell, { threshold: [0, 0.5] });
  app.querySelectorAll('.hero-slide.is-current [data-media], [data-media]:not(.hero-slide *)').forEach((el) => dwellIO.observe(el));
}
