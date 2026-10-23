/* Notes de 0,5 à 5 étoiles : sur la fiche (après visionnage), invite « Tu as aimé ? », menu contextuel, bibliothèque. */
import { userStore } from '../data/userStore';
import { detailEl, toast } from './dom.js';
import { registerCtxItems, state } from './state.js';
import { esc, fmtNum } from './util.js';

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>';

/** Étoiles cliquables par demi-étoile. `value` : note actuelle (ou null). */
function starsHTML(value, key) {
  let out = '<span class="stars" role="radiogroup" aria-label="Ta note" data-stars="' + esc(key) + '">';
  for (let i = 1; i <= 5; i++) {
    const fill = value >= i ? 'full' : value >= i - 0.5 ? 'half' : '';
    out += '<span class="star' + (fill ? ' is-' + fill : '') + '"><span class="star-bg">' + STAR + '</span><span class="star-fg">' + STAR + '</span>' +
      '<button type="button" class="half l" role="radio" aria-checked="' + (value === i - 0.5) + '" data-rate="' + (i - 0.5) + '" data-rkey="' + esc(key) + '" aria-label="' + (i - 0.5) + ' étoiles"></button>' +
      '<button type="button" class="half r" role="radio" aria-checked="' + (value === i) + '" data-rate="' + i + '" data-rkey="' + esc(key) + '" aria-label="' + i + ' étoile' + (i > 1 ? 's' : '') + '"></button></span>';
  }
  return out + '</span>';
}

export const starsText = (v) => '★'.repeat(Math.floor(v)) + (v % 1 ? '½' : '');

/** Note possible une fois le titre vu, ou entamé à 50 % au moins. */
function canRate(key) {
  const [type] = key.split(':');
  if (type === 'movie' ? userStore.isWatched(key) : userStore.watchedEpisodes(key).length > 0) return true;
  const entry = userStore.continueWatching().find((p) => p.key === key) || userStore.getProgress(key);
  return !!entry && entry.duration > 0 && entry.position / entry.duration >= 0.5;
}

function metaOf(key) {
  const [type, id] = key.split(':');
  const m = state.model && state.model.key === key ? state.model : null;
  const it = state.byKey.get(key);
  return { type, id: Number(id), title: m ? m.name : it ? it.name : '', year: m ? m.year : it ? it.year : '' };
}

/** Enregistre (ou retire, si on reclique la même note) ; affichage immédiat, retour arrière si refus. */
async function rate(key, value) {
  const cur = userStore.getRating(key);
  const next = cur === value ? null : value;
  const pending = userStore.setRating(metaOf(key), next);
  refreshRatingUI();
  toast(next === null ? 'Note retirée' : 'Note enregistrée : ' + starsText(next));
  const ok = await pending;
  if (!ok) {
    refreshRatingUI();
    toast('Enregistrement impossible : note annulée');
  }
  return ok;
}

/** Zone de note de la fiche. */
export function ficheRateHTML(m) {
  const v = userStore.getRating(m.key);
  if (canRate(m.key)) {
    return '<span class="f-rate-label">Ta note</span>' + starsHTML(v, m.key) +
      '<span class="f-rate-value">' + (v ? fmtNum(v, 1) + ' / 5' : 'Pas encore noté') + '</span>';
  }
  return '<button type="button" class="btn btn-ghost btn-sm" disabled title="Regarde au moins la moitié pour pouvoir noter">Noter</button>' +
    '<span class="set-hint">Disponible une fois le titre vu (ou à moitié).</span>';
}

export function refreshRatingUI() {
  const m = state.model;
  const box = detailEl.querySelector('#f-rate');
  if (m && box) box.innerHTML = ficheRateHTML(m);
  document.querySelectorAll('.rate-pop [data-stars]').forEach((s) => {
    const key = s.dataset.stars;
    s.outerHTML = starsHTML(userStore.getRating(key), key);
  });
  document.querySelectorAll('[data-tile] .t-rating').forEach((n) => n.remove());
  paintTileRatings(document);
}

/** Petite étoile « ★ 4,5 » sur les tuiles notées de la bibliothèque. */
export function paintTileRatings(root) {
  if (state.kind !== 'library') return;
  root.querySelectorAll('#lib-grid [data-tile]').forEach((el) => {
    const v = userStore.getRating(el.dataset.tile);
    const media = el.querySelector('.card-media');
    if (v && media && !media.querySelector('.t-rating')) media.insertAdjacentHTML('beforeend', '<span class="t-rating" aria-hidden="true">★ ' + fmtNum(v, 1) + '</span>');
  });
}

// ---------- Invite « Tu as aimé ? » ----------
let popTimer = null;

function closeRatePrompt() {
  clearTimeout(popTimer);
  document.querySelectorAll('.rate-pop').forEach((n) => n.remove());
}

/** Invite de notation (fin de lecture, titre marqué comme vu, menu « Noter… »). */
export function showRatePrompt(key, opts) {
  const o = opts || {};
  if (!o.force && userStore.getRating(key) != null) return;
  closeRatePrompt();
  const meta = metaOf(key);
  const pop = document.createElement('div');
  pop.className = 'rate-pop glass';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Noter ' + meta.title);
  pop.innerHTML = '<p class="rate-q">' + esc(o.question || 'Tu as aimé ?') + (meta.title ? ' <strong>' + esc(meta.title) + '</strong>' : '') + '</p>' +
    starsHTML(userStore.getRating(key), key) + '<button type="button" class="link-btn" data-rate-close>Plus tard</button>';
  document.body.appendChild(pop);
  popTimer = setTimeout(closeRatePrompt, 14000);
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('[data-rate-close]')) { e.preventDefault(); closeRatePrompt(); return; }
  const b = t.closest('[data-rate]');
  if (b) {
    e.preventDefault();
    e.stopPropagation();
    rate(b.dataset.rkey, Number(b.dataset.rate)).then(() => { if (b.closest('.rate-pop')) setTimeout(closeRatePrompt, 900); });
  }
}, true);

// Menu contextuel : « Noter… » sur les titres.
registerCtxItems((t) => {
  if (t.kind !== 'title' && t.kind !== 'show') return [];
  const v = userStore.getRating(t.key);
  return [{
    id: 'rate', label: v ? 'Modifier ma note (' + fmtNum(v, 1) + ' ★)' : 'Noter…', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>',
    run: () => { if (canRate(t.key)) showRatePrompt(t.key, { force: true, question: 'Ta note' }); else toast('Regarde au moins la moitié pour pouvoir noter'); },
  }];
});
