/* Port du prototype (voir tools/port-prototype.mjs). */
import { FICHE_IDLE_MS, REDUCE, STILL } from './constants.js';
import { detailEl, modal } from './dom.js';
import { ambientSrc, fitPreview, paintSound, postYT, setPreviewSound } from './preview.js';
import { textFade } from './playback.js';
import { guardAmbient, hideTrailerButtons } from './trailerFallback.js';
import { esc } from './util.js';

let fv = null;
// ---------- Fiche : vidéo d'ambiance ----------
export function heroVideoStop() {
  if (!fv) return;
  clearTimeout(fv.timer);
  if (fv.io) fv.io.disconnect();
  if (fv.ro) fv.ro.disconnect();
  if (fv.unfade) fv.unfade();
  if (fv.unguard) fv.unguard();
  if (fv.auto) fv.auto.stop();
  if (fv.wrap) fv.wrap.remove();
  fv = null;
}

/**
 * `auto` : enchaînement bande-annonce → lecture (trailerPlay.js), ou null. Sans enchaînement, la bande-annonce boucle ;
 * avec, elle s'arrête à sa fin pour que la lecture prenne la suite.
 */
export function heroVideoSetup(m, auto = null) {
  heroVideoStop();
  if (!m.trailer || REDUCE || STILL) return;
  const bg = detailEl.querySelector('.f-bg');
  const hero = detailEl.querySelector('.f-first');
  if (!bg || !hero) return;
  fv = { bg, key: m.trailer, vo: !!m.trailerVO, wrap: null, iframe: null, io: null, ro: null, muted: true, inView: true, ready: false, timer: null, unfade: null, unguard: null, auto };
  const me = fv;
  const tried = [m.trailer]; // vidéos essayées : leurs boutons partent si aucune ne marche
  if (auto) auto.start();
  const mount = () => {
    if (fv !== me) return;
    if (document.hidden) {
      me.timer = setTimeout(mount, 1000);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'f-video';
    wrap.innerHTML = '<iframe title="Bande-annonce en arrière-plan, sans son" tabindex="-1" allow="autoplay; encrypted-media" src="' + esc(ambientSrc(me.key, !auto)) + '"></iframe>';
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
      // Les textes de la fiche s'estompent pendant la lecture effective de la bande-annonce (playback.js).
      me.unfade = textFade(detailEl, me.iframe);
      if (auto) auto.attach(me.iframe);
    }, { once: true });
    // La vidéo n'apparaît (et le bouton son avec elle) qu'une fois la lecture lancée. Vidéo indisponible : candidate
    // suivante ; plus aucune, le fond reste fixe, l'enchaînement sur la lecture est abandonné et les boutons partent.
    me.unguard = guardAmbient(me.iframe, m, me.key, {
      srcFor: (k) => ambientSrc(k, !auto),
      onReveal: () => {
        if (fv !== me) return;
        requestAnimationFrame(() => wrap.classList.add('is-on'));
        const btn = detailEl.querySelector('[data-fsound]');
        if (btn) { btn.hidden = false; if (me.vo) btn.dataset.vo = '1'; else delete btn.dataset.vo; }
      },
      onSwap: (next) => {
        if (me.wrap) me.wrap.classList.remove('is-on');
        me.key = next.key;
        me.vo = !!next.vo;
        tried.push(next.key);
        detailEl.querySelectorAll('.btn-round[data-vid]').forEach((b) => {
          b.dataset.vid = next.key;
          if (next.vo) b.dataset.vo = '1'; else delete b.dataset.vo;
        });
      },
      onReload: () => {
        if (fv !== me) return;
        postYT(me.iframe, 'mute');
        postYT(me.iframe, 'playVideo');
      },
      onExhausted: () => {
        if (fv !== me) return;
        heroVideoStop();
        hideTrailerButtons(detailEl, tried);
      },
    });
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
  setPreviewSound(fv.iframe, !fv.muted, fv.vo);
  if (!fv.muted) postYT(fv.iframe, 'setVolume', [80]);
  paintSound(btn, fv.muted);
}
