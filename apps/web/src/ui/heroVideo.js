/* Port du prototype (voir tools/port-prototype.mjs). */
import { FICHE_IDLE_MS, REDUCE, STILL } from './constants.js';
import { detailEl, modal } from './dom.js';
import { ICON } from './icons.js';
import { ambientSrc, fitPreview, postYT } from './preview.js';
import { state } from './state.js';
import { esc } from './util.js';

let fv = null;
// ---------- Fiche : vidéo d'ambiance ----------
export function heroVideoStop() {
  if (!fv) return;
  clearTimeout(fv.timer);
  if (fv.io) fv.io.disconnect();
  if (fv.ro) fv.ro.disconnect();
  if (fv.wrap) fv.wrap.remove();
  fv = null;
}

export function heroVideoSetup(m) {
  heroVideoStop();
  if (!m.trailer || REDUCE || STILL) return;
  const bg = detailEl.querySelector('.f-bg');
  const hero = detailEl.querySelector('.f-first');
  if (!bg || !hero) return;
  fv = { bg, key: m.trailer, wrap: null, iframe: null, io: null, ro: null, muted: true, inView: true, ready: false, timer: null };
  const me = fv;
  const mount = () => {
    if (fv !== me) return;
    if (document.hidden) {
      me.timer = setTimeout(mount, 1000);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'f-video';
    wrap.innerHTML = '<iframe title="Bande-annonce en arrière-plan, sans son" tabindex="-1" allow="autoplay; encrypted-media" src="' + esc(ambientSrc(me.key)) + '"></iframe>';
    bg.appendChild(wrap);
    me.wrap = wrap;
    me.iframe = wrap.querySelector('iframe');
    const p = { media: bg, iframe: me.iframe };
    me.ro = new ResizeObserver(() => fitPreview(p));
    me.ro.observe(bg);
    fitPreview(p);
    me.iframe.addEventListener('load', () => {
      if (fv !== me) return;
      postYT(me.iframe, 'mute');
      postYT(me.iframe, 'playVideo');
      me.ready = true;
      requestAnimationFrame(() => wrap.classList.add('is-on'));
      const btn = detailEl.querySelector('[data-fsound]');
      if (btn) btn.hidden = false;
      ambientBump();
    }, { once: true });
  };
  me.timer = setTimeout(mount, FICHE_IDLE_MS);
  if ('IntersectionObserver' in window) {
    me.io = new IntersectionObserver((entries) => {
      me.inView = entries[0].isIntersecting;
      heroVideoSync();
    }, { threshold: 0.2 });
    me.io.observe(hero);
  }
}

export function heroVideoSync() {
  if (!fv || !fv.ready) return;
  const shouldPlay = fv.inView && !document.hidden && modal.hidden;
  postYT(fv.iframe, shouldPlay ? 'playVideo' : 'pauseVideo');
}

export function toggleHeroSound(btn) {
  if (!fv || !fv.ready) return;
  fv.muted = !fv.muted;
  postYT(fv.iframe, fv.muted ? 'mute' : 'unMute');
  if (!fv.muted) postYT(fv.iframe, 'setVolume', [80]);
  btn.setAttribute('aria-pressed', String(!fv.muted));
  btn.setAttribute('aria-label', fv.muted ? 'Activer le son' : 'Couper le son');
  btn.dataset.tip = fv.muted ? 'Activer le son' : 'Couper le son';
  btn.innerHTML = fv.muted ? ICON.mute : ICON.sound;
}

// ---------- Fiche : routage et cycle de vie ----------
// Mode ambiance : après ~6 s sans activité (vidéo lancée), l'info s'estompe ; toute action la restaure.
let ambTimer = null;
export function ambientBump() {
  detailEl.classList.remove('is-ambient');
  clearTimeout(ambTimer);
  ambTimer = null;
  if (!state.inDetail || !fv || !fv.ready || REDUCE) return;
  ambTimer = setTimeout(() => {
    if (state.inDetail && fv && fv.ready && modal.hidden && window.scrollY < 40) detailEl.classList.add('is-ambient');
  }, 6000);
}
['mousemove', 'keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll'].forEach((ev) =>
  document.addEventListener(ev, ambientBump, { passive: true }));
export function clearAmbient() {
  clearTimeout(ambTimer);
  ambTimer = null;
}
