/* Port du prototype (voir tools/port-prototype.mjs). */
import { trailerLang } from '../data/trailers';
import { getDetail } from './catalog.js';
import { DWELL_MS, REDUCE, STILL, YT_ORIGIN } from './constants.js';
import { ICON } from './icons.js';
import { app } from './dom.js';
import { textFade } from './playback.js';
import { quietGlide, HERO_QUIET } from './ficheQuiet.js';
import { guardAmbient, hideTrailerButtons } from './trailerFallback.js';
import { trailersAllowed } from '../player/playerState';
import { state } from './state.js';
import { esc } from './util.js';

let dwellIO = null;
// ---------- Aperçu vidéo muet (mise en avant de l'accueil) ----------
export function postYT(iframe, func, args) {
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), YT_ORIGIN);
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
    if (e.origin !== YT_ORIGIN || e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
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
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN); } catch (_) { /* iframe fermée */ }
  return () => { done = true; cleanup(); };
}

/** Appelle `cb` une seule fois quand la vidéo YouTube se termine (état 0 de l'API IFrame). Renvoie une fonction d'annulation. */
export function whenEnded(iframe, cb) {
  const onMsg = (e) => {
    if (e.origin !== YT_ORIGIN || e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d && d.info && d.info.playerState === 0) { window.removeEventListener('message', onMsg); cb(); }
  };
  window.addEventListener('message', onMsg);
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN); } catch (_) { /* iframe fermée */ }
  return () => window.removeEventListener('message', onMsg);
}

/** Bouton son (aperçu, fiche, survol) : icône haut-parleur barré quand muet, haut-parleur sinon. Même rendu partout. */
export function paintSound(btn, muted) {
  btn.innerHTML = muted ? ICON.mute : ICON.sound;
  btn.setAttribute('aria-pressed', String(!muted));
  btn.setAttribute('aria-label', muted ? 'Activer le son' : 'Couper le son');
  btn.dataset.tip = muted ? 'Activer le son' : 'Couper le son';
}

export function ytSrc(key, extra) {
  return YT_ORIGIN + '/embed/' + encodeURIComponent(key) + '?' + extra;
}
/** Aperçu muet en boucle. Jamais de sous-titres à l'arrivée : ils ne s'affichent qu'avec le son (voir setPreviewSound). */
export const ambientSrc = (key, loop = true) =>
  ytSrc(key, 'autoplay=1&mute=1&controls=0&loop=' + (loop ? 1 : 0) + '&playlist=' + encodeURIComponent(key) +
    '&modestbranding=1&rel=0&playsinline=1&disablekb=1&iv_load_policy=3&cc_load_policy=0' +
    '&fs=0&enablejsapi=1&origin=' + encodeURIComponent(location.origin));

/**
 * Mode cinéma du héros : son activé → seule la vidéo reste (logo réduit et Lecture en bas à gauche), la barre du haut
 * s'atténue. Sans effet hors du héros (fiche, survol, grille).
 */
function setCinema(iframe, on) {
  const hero = iframe.closest('.hero');
  if (!hero) return;
  hero.classList.toggle('is-cinema', on);
  if (hero.parentElement) hero.parentElement.classList.toggle('hero-cinema', on);
  if (state.preview && state.preview.iframe === iframe) fitPreview(state.preview);
}

/**
 * Son de l'aperçu (`on` : son activé). `vo` : bande-annonce non doublée dans la langue principale ; ses sous-titres
 * s'activent avec le son et sont retirés quand il est coupé. Une VF n'a jamais de sous-titres imposés.
 */
export function setPreviewSound(iframe, on, vo) {
  postYT(iframe, on ? 'unMute' : 'mute');
  setCinema(iframe, on);
  if (!vo) return;
  if (on) {
    postYT(iframe, 'loadModule', ['captions']);
    postYT(iframe, 'setOption', ['captions', 'track', { languageCode: trailerLang().lang }]);
  } else {
    postYT(iframe, 'unloadModule', ['captions']);
  }
}

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
  // Mise en avant muette (bloc au format 16:9) : centrée, les bandes noires des bandes-annonces au format cinéma se coupent
  // à parts égales. Avec le son (mode cinéma) et ailleurs, ancrée en bas : les sous-titres (bas de l'image) restent
  // visibles, le débordement se coupe en haut.
  const center = p.media.classList.contains('hero-bg') && !p.media.closest('.is-cinema');
  s.top = (center ? (h0 - h) / 2 : h0 - h) + 'px';
}

export function stopPreview() {
  const p = state.preview;
  if (!p) return;
  state.preview = null;
  try { postYT(p.iframe, 'pauseVideo'); } catch (_) { /* déjà fermé */ }
  setCinema(p.iframe, false);
  if (p.ro) p.ro.disconnect();
  if (p.unfade) p.unfade();
  if (p.unglide) p.unglide();
  if (p.unend) p.unend();
  if (p.unguard) p.unguard();
  p.wrap.remove();
  p.btn.remove();
}

export async function startPreview(media) {
  if (REDUCE || STILL || !media.isConnected || state.inDetail || !trailersAllowed()) return;
  const item = state.byKey.get(media.dataset.media);
  if (!item) return;
  const d = await getDetail(item);
  if (!d || !d.trailer || !media.isConnected || media._visible === false || state.inDetail || !trailersAllowed()) return;
  stopPreview();
  // Carrousel de l'accueil : la bande-annonce ne boucle pas, sa fin fait passer au titre suivant (évènement « trailerend »).
  const carousel = !!media.closest('[data-hero]');
  const wrap = document.createElement('div');
  wrap.className = 'preview';
  wrap.innerHTML = '<iframe title="Aperçu vidéo sans son" tabindex="-1" allow="autoplay; encrypted-media" src="' + esc(ambientSrc(d.trailer, !carousel)) + '"></iframe>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'f-round preview-sound';
  btn.setAttribute('data-preview-sound', '');
  if (d.trailerVO) btn.dataset.vo = '1';
  paintSound(btn, true);
  media.appendChild(wrap);
  media.appendChild(btn);
  const iframe = wrap.querySelector('iframe');
  const p = { media, wrap, btn, iframe, muted: true, vo: !!d.trailerVO, ro: null, unfade: null, unglide: null, unend: null, unguard: null };
  state.preview = p;
  p.ro = new ResizeObserver(() => fitPreview(p));
  p.ro.observe(media);
  fitPreview(p);
  iframe.addEventListener('load', () => {
    if (state.preview !== p) return;
    postYT(iframe, 'mute');
    postYT(iframe, 'playVideo');
    // Accueil : les textes de la diapositive s'estompent pendant la lecture effective (grille : rien à estomper).
    p.unfade = textFade(media.closest('.hero-slide'), iframe);
    // Texte estompé : le logo rejoint « Lecture » (mêmes règles que la fiche).
    if (media.closest('.hero-slide')) p.unglide = quietGlide(media.closest('.hero-slide'), HERO_QUIET);
    if (carousel) {
      p.unend = whenEnded(iframe, () => {
        if (state.preview === p) media.dispatchEvent(new CustomEvent('trailerend', { bubbles: true }));
      });
    }
  }, { once: true });
  // L'aperçu n'apparaît qu'une fois la lecture lancée : l'écran d'erreur de YouTube ne se voit jamais. Vidéo indisponible :
  // candidate suivante ; plus aucune, l'aperçu disparaît (le visuel reste) et les boutons « Bande-annonce » aussi.
  p.unguard = guardAmbient(iframe, d, d.trailer, {
    srcFor: (k) => ambientSrc(k, !carousel),
    onReveal: () => { if (state.preview === p) requestAnimationFrame(() => wrap.classList.add('is-on')); },
    onSwap: (next) => {
      wrap.classList.remove('is-on');
      p.vo = !!next.vo;
      if (next.vo) btn.dataset.vo = '1'; else delete btn.dataset.vo;
    },
    onReload: () => {
      if (state.preview !== p) return;
      postYT(iframe, 'mute');
      postYT(iframe, 'playVideo');
    },
    onExhausted: () => {
      if (state.preview !== p) return;
      stopPreview();
      hideTrailerButtons(media.closest('.hero-slide') || media);
    },
  });
}

export function cancelDwell() {
  clearTimeout(state.dwell.timer);
  state.dwell.timer = null;
  state.dwell.el = null;
}

export function scheduleDwell(el) {
  cancelDwell();
  if (!trailersAllowed()) return; // lecteur plein écran : aucun aperçu ne démarre
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
