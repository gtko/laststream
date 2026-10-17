/* Port du prototype (voir tools/port-prototype.mjs). */
import { certLabel, getDetail } from './catalog.js';
import { REDUCE, STILL } from './constants.js';
import { modal } from './dom.js';
import { ICON } from './icons.js';
import { inLib } from './library.js';
import { ambientSrc, postYT } from './preview.js';
import { compactRates } from './ratings.js';
import { state } from './state.js';
import { playerEl } from './tv.js';
import { esc, plural } from './util.js';

export const HOVER_OPEN_MS = 900;
export const HOVER_FOCUS_MS = 1200;
export const HOVER_CLOSE_MS = 250;
export const hv = { openTimer: null, closeTimer: null, tile: null, el: null, key: '', token: 0, lastEvt: 0 };
export const finePointer = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);


export function hoverMeta(it, d) {
  const parts = [];
  if (it.year) parts.push(it.year);
  if (d.cert) parts.push('<span class="cert-badge">' + esc(certLabel(d.cert)) + '</span>');
  if (it.type === 'tv' && d.seasons) parts.push(plural(d.seasons, 'saison', 'saisons'));
  else if (d.runtime) parts.push(d.runtime);
  if (d.genres && d.genres.length) parts.push(esc(d.genres.slice(0, 3).join(' · ')));
  return parts.join(' <span class="hc-dot">·</span> ');
}

export function closeHover() {
  clearTimeout(hv.openTimer);
  clearTimeout(hv.closeTimer);
  hv.openTimer = hv.closeTimer = null;
  hv.token++;
  if (hv.el) {
    const el = hv.el;
    hv.el = null;
    el.remove(); // retire aussi l'iframe : la vidéo s'arrête
  }
  hv.tile = null;
  hv.key = '';
}

export function placeHover(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
  const top = Math.max(12, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 12));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

export function openHover(tile) {
  if (!tile.isConnected || !modal.hidden || !playerEl.hidden || state.ctxMenu) return;
  const key = tile.dataset.tile;
  const it = state.byKey.get(key);
  if (!it) return;
  closeHover();
  const token = hv.token;
  hv.tile = tile;
  hv.key = key;
  const anchor = tile.querySelector('.card-media, .up-media') || tile;
  const rect = anchor.getBoundingClientRect();
  const w = Math.round(Math.max(300, Math.min(480, rect.width * 1.5)));
  const el = document.createElement('div');
  el.id = 'hovercard';
  el.className = 'hc';
  el.style.width = w + 'px';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Aperçu : ' + it.name);
  const src = it.backdrop || it.poster;
  const on = inLib(key);
  el.innerHTML =
    '<div class="hc-media">' + (src ? '<img src="' + esc(src) + '" alt="" decoding="async">' : '') + '<div class="hc-video"></div></div>' +
    '<div class="hc-body"><div class="hc-title"><span class="hc-name">' + esc(it.name) + '</span></div>' +
    '<ul class="rates hc-rates"></ul><p class="hc-meta">' + esc([it.year, it.type === 'tv' ? 'Série' : 'Film'].filter(Boolean).join(' · ')) + '</p>' +
    '<div class="hc-actions">' +
    '<button type="button" class="hc-btn hc-play" data-play data-tip="Lecture" aria-label="Lecture">' + ICON.play + '</button>' +
    '<button type="button" class="hc-btn' + (on ? ' is-on' : '') + '" data-hclib="' + esc(key) + '" aria-pressed="' + on + '" data-tip="' + (on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream') + '" aria-label="' + (on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream') + '">' + (on ? ICON.check : ICON.list) + '</button>' +
    '<button type="button" class="hc-btn hc-sound" data-hcvid hidden data-tip="Bande-annonce avec son" aria-label="Bande-annonce avec son">' + ICON.sound + '</button>' +
    '<button type="button" class="hc-btn hc-more" data-open="' + esc(key) + '" data-tip="Plus d’infos" aria-label="Plus d’infos">' + ICON.chev + '</button></div></div>';
  document.body.appendChild(el);
  hv.el = el;
  placeHover(el, anchor);
  requestAnimationFrame(() => el.classList.add('is-on'));
  state.ficheName = it.name; // nom affiché dans le tiroir « Sources »

  getDetail(it).then((d) => {
    if (token !== hv.token || !hv.el || !d) return;
    const title = hv.el.querySelector('.hc-title');
    if (d.logo && title) title.innerHTML = '<img class="hc-logo logo-img" src="' + esc(d.logo) + '" alt="' + esc(it.name) + '" data-logo="' + esc(it.name) + '">';
    const rates = hv.el.querySelector('.hc-rates');
    const fb = it.vote ? Number(it.vote.replace(',', '.')) * 10 : 0;
    if (rates) { rates.innerHTML = compactRates(d.ratings, fb); if (!rates.innerHTML) rates.hidden = true; }
    const meta = hv.el.querySelector('.hc-meta');
    if (meta) meta.innerHTML = hoverMeta(it, d);
    if (d.trailer) {
      const sb = hv.el.querySelector('[data-hcvid]');
      if (sb) { sb.hidden = false; sb.dataset.vid = d.trailer; sb.dataset.vtitle = 'Bande-annonce : ' + it.name; }
      if (!REDUCE && !STILL) {
        const vbox = hv.el.querySelector('.hc-video');
        vbox.innerHTML = '<iframe title="Aperçu vidéo sans son" tabindex="-1" allow="autoplay; encrypted-media" src="' + esc(ambientSrc(d.trailer)) + '"></iframe>';
        const fr = vbox.querySelector('iframe');
        fr.addEventListener('load', () => {
          if (token !== hv.token) return;
          postYT(fr, 'mute');
          postYT(fr, 'playVideo');
          setTimeout(() => { if (token === hv.token) vbox.classList.add('is-on'); }, 350);
        }, { once: true });
      }
    }
    placeHover(hv.el, anchor);
  });
}

export function hoverTileOf(target) {
  if (!(target instanceof Element)) return null;
  const t = target.closest('[data-tile]');
  return t && t.dataset.tile && !t.closest('.ctxmenu') ? t : null;
}

export function scheduleHover(tile, ms) {
  clearTimeout(hv.openTimer);
  clearTimeout(hv.closeTimer);
  hv.openTimer = setTimeout(() => {
    hv.openTimer = null;
    if (state.dragRow && state.dragRow.moved) return;
    openHover(tile);
  }, ms);
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse' || !finePointer() || !(e.target instanceof Element)) return;
  if (e.target.closest('#hovercard')) { clearTimeout(hv.closeTimer); hv.closeTimer = null; return; }
  const tile = hoverTileOf(e.target);
  if (tile) {
    if (hv.el && hv.tile === tile) { clearTimeout(hv.closeTimer); hv.closeTimer = null; return; }
    if (hv.tile === tile && hv.openTimer) return;
    if (hv.el) closeHover();
    hv.tile = tile;
    scheduleHover(tile, HOVER_OPEN_MS);
    return;
  }
  clearTimeout(hv.openTimer);
  hv.openTimer = null;
  if (hv.el && !hv.closeTimer) hv.closeTimer = setTimeout(closeHover, HOVER_CLOSE_MS);
  if (!hv.el) hv.tile = null;
});
document.documentElement.addEventListener('mouseleave', () => {
  clearTimeout(hv.openTimer);
  if (hv.el) { clearTimeout(hv.closeTimer); hv.closeTimer = setTimeout(closeHover, HOVER_CLOSE_MS); }
});
document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('#hovercard')) return;
  if (hv.el || hv.openTimer) closeHover();
});
window.addEventListener('scroll', () => { if (hv.el || hv.openTimer) closeHover(); }, { passive: true });
document.addEventListener('focusin', (e) => {
  if (!finePointer()) return;
  const tile = hoverTileOf(e.target);
  if (!tile || !tile.matches(':focus-visible')) return;
  if (hv.el && hv.tile === tile) return;
  closeHover();
  hv.tile = tile;
  scheduleHover(tile, HOVER_FOCUS_MS);
});
document.addEventListener('focusout', (e) => {
  if (hoverTileOf(e.target) && !(e.relatedTarget instanceof Element && e.relatedTarget.closest('#hovercard'))) closeHover();
});
