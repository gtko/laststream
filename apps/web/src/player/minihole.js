/* Perçage de la page pour le mini-lecteur mpv : la vidéo mpv est sous la fenêtre web, donc tout ce que la page dessine
 * au-dessus de la vignette la masquerait. Chaque conteneur plein de `body` reçoit un fond plein (var(--bg)) et un
 * `clip-path` evenodd qui laisse un trou arrondi à l'emplacement de la vignette. Le trou est exprimé dans le repère de
 * l'élément : on le recalcule au défilement, au redimensionnement, au changement de page et quand un conteneur apparaît. */
import { holeClipFor, MINI_RADIUS } from './mini';

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
const IGNORED_IDS = new Set(['toast']);

const intersects = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const isTransparent = (c) => !c || c === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(c);

export class PageHole {
  /** `keep` : éléments à ne pas toucher (le lecteur et ses ancêtres). */
  constructor(keep = []) {
    this.keep = keep;
    this.saved = new Map();
    this.rect = null;
    this.raf = 0;
    this.timer = 0;
    this.obs = null;
    this.onEvent = () => this.schedule();
  }

  /** Perce la page à l'emplacement `rect` (px de la fenêtre) ; sans `rect`, rend la page telle qu'elle était. */
  apply(rect) {
    this.rect = rect;
    if (!rect) { this.release(); return; }
    this.watch();
    this.paint();
  }

  paint() {
    const rect = this.rect;
    if (!rect) return;
    this.observeChildren();
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement) || IGNORED_TAGS.has(el.tagName) || IGNORED_IDS.has(el.id) || this.keep.includes(el)) continue;
      const box = el.getBoundingClientRect();
      if (el.hidden || (box.width === 0 && box.height === 0)) { this.restore(el); continue; }
      const mine = { left: box.left, top: box.top, width: box.width, height: box.height };
      if (!intersects(mine, rect)) { this.restore(el); continue; }
      if (!this.saved.has(el)) {
        this.saved.set(el, { clip: el.style.clipPath, bg: el.style.background, minHeight: el.style.minHeight });
        // Les éléments fixes (menus, bandeaux) ne sont que découpés ; seuls les conteneurs de page reçoivent un fond plein.
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && isTransparent(cs.backgroundColor)) {
          el.style.background = 'var(--bg)';
          if (el.id === 'app') el.style.minHeight = '100vh';
        }
      }
      el.style.clipPath = holeClipFor(mine, rect, MINI_RADIUS);
    }
  }

  restore(el) {
    const s = this.saved.get(el);
    if (!s) return;
    el.style.clipPath = s.clip;
    el.style.background = s.bg;
    el.style.minHeight = s.minHeight;
    this.saved.delete(el);
  }

  release() {
    this.unwatch();
    for (const el of Array.from(this.saved.keys())) this.restore(el);
    this.rect = null;
  }

  schedule() {
    if (this.raf || this.timer || !this.rect) return;
    const run = () => { this.raf = 0; this.timer = 0; this.paint(); };
    if (typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(run);
    else this.timer = setTimeout(run, 0);
  }

  watch() {
    if (this.obs) return;
    window.addEventListener('scroll', this.onEvent, true);
    window.addEventListener('resize', this.onEvent);
    window.addEventListener('hashchange', this.onEvent);
    window.addEventListener('popstate', this.onEvent);
    if (typeof MutationObserver === 'function') {
      this.obs = new MutationObserver(this.onEvent);
      this.obs.observe(document.body, { childList: true });
      // Les conteneurs de page changent de contenu sans changer de boîte : seul leur attribut `hidden` compte.
      this.observeChildren();
    } else this.obs = { disconnect() { /* rien à débrancher */ } };
  }

  /** Surveille `hidden` de chaque enfant de `body`, y compris ceux ajoutés après watch() (ré-observer un nœud est sans effet). */
  observeChildren() {
    if (!this.obs || !this.obs.observe) return;
    for (const el of Array.from(document.body.children)) if (el instanceof HTMLElement) this.obs.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }

  unwatch() {
    if (!this.obs) return;
    window.removeEventListener('scroll', this.onEvent, true);
    window.removeEventListener('resize', this.onEvent);
    window.removeEventListener('hashchange', this.onEvent);
    window.removeEventListener('popstate', this.onEvent);
    this.obs.disconnect();
    this.obs = null;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.raf = 0;
    this.timer = 0;
  }
}
