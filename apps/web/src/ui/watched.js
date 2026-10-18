/* « Vu » : épisodes, saisons, série entière et films. Affichage optimiste, retour arrière si le serveur refuse. */
import { seasonEpisodes } from './seasons.js';
import { newEpisodeCount } from '../data/episodes';
import { refreshRatingUI, showRatePrompt } from './rate.js';
import { refreshNewBadges } from './tiles.js';
import { userStore } from '../data/userStore';
import { notifyHomeChange, setSeriesCompleted } from '../data/homeFilters';
import { markNext, updatePlayLabel } from './fiche.js';
import { detailEl, toast } from './dom.js';
import { ICON } from './icons.js';
import { progressResume } from './resume.js';
import { state } from './state.js';

const today = () => new Date().toISOString().slice(0, 10);
const isAired = (e) => !e.air_date || e.air_date <= today();

/** Épisodes diffusés de la saison actuellement affichée. */
export function seasonAired() {
  const s = state.seasonEps;
  return s ? s.eps.filter(isAired).map((e) => ({ season: s.n, episode: e.episode_number })) : [];
}

const allWatched = (key, refs) => refs.length > 0 && refs.every((r) => userStore.isWatched(key, r.season, r.episode));

/** Applique le changement tout de suite, puis confirme auprès du serveur ; en cas d'échec l'affichage revient en arrière. */
export async function mark(key, refs, watched) {
  const pending = userStore.setWatched(key, refs, watched);
  refreshWatchedUI();
  const ok = await pending;
  if (!ok) {
    refreshWatchedUI();
    toast('Enregistrement impossible : modification annulée');
  } else if (!watched && key.startsWith('tv:')) {
    setSeriesCompleted(key, false); // un épisode non vu : la série n'est plus vue en entier
  } else if (watched && key.startsWith('movie:')) {
    showRatePrompt(key); // « Tu as aimé ? »
  }
  return ok;
}

/** Remet à jour tout ce qui montre l'état « vu » : cartes d'épisodes, boutons, libellé de lecture, badges des tuiles. */
export function refreshWatchedUI() {
  const m = state.model;
  if (m && m.type === 'tv') {
    detailEl.querySelectorAll('.ep[data-ep]').forEach((li) => {
      const [s, e] = li.dataset.ep.split(':').map(Number);
      const on = userStore.isWatched(m.key, s, e);
      li.classList.toggle('is-seen', on);
      const bar = li.querySelector('.ep-bar > span');
      const rs = on ? null : progressResume(userStore.getProgress(m.key, s, e));
      if (bar) bar.style.width = on ? '100%' : (rs ? Math.round(rs.ratio * 100) : 0) + '%';
      const b = li.querySelector('.ep-seen');
      if (b) {
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', (on ? 'Marquer comme non vu : É' : 'Marquer comme vu : É') + e);
      }
    });
    const sb = detailEl.querySelector('[data-season-watch]');
    if (sb) {
      const refs = seasonAired();
      const all = allWatched(m.key, refs);
      sb.textContent = all ? 'Marquer la saison comme non vue' : 'Marquer la saison comme vue';
      sb.dataset.state = all ? 'on' : 'off';
      sb.disabled = !refs.length;
    }
    updatePlayLabel(m);
    markNext(m);
    const nc = detailEl.querySelector('#f-newcount');
    if (nc) {
      const n = newEpisodeCount(m.seasons || [], m.lastAired, userStore.watchedEpisodes(m.key).map((x) => ({ season: x.season, episode: x.episode })));
      nc.hidden = !n;
      nc.textContent = n === 1 ? '1 nouvel épisode' : n + ' nouveaux épisodes';
    }
  }
  if (m && m.type === 'movie') {
    const b = detailEl.querySelector('[data-watch-movie]');
    if (b) {
      const on = userStore.isWatched(m.key);
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
      b.dataset.tip = on ? 'Vu (cliquer pour retirer)' : 'Marquer comme vu';
      b.setAttribute('aria-label', on ? 'Marqué comme vu (retirer)' : 'Marquer comme vu');
    }
  }
  refreshRatingUI();
  refreshNewBadges();
  notifyHomeChange(); // l'accueil retire les titres devenus vus
  document.querySelectorAll('[data-tile^="movie:"]').forEach((el) => {
    const on = userStore.isWatched(el.dataset.tile);
    const media = el.querySelector('.card-media');
    if (!media) return;
    const badge = media.querySelector('.t-watched');
    if (on && !badge) media.insertAdjacentHTML('beforeend', '<span class="t-watched" aria-hidden="true" title="Vu">' + ICON.check + '</span>');
    else if (!on && badge) badge.remove();
  });
}

/** Toutes les saisons (hors saison 0) : épisodes diffusés. */
async function seriesAired(m) {
  const seasons = (m.seasons || []).filter((s) => s.season_number > 0);
  const lists = await Promise.all(seasons.map((s) => seasonEpisodes(m.id, s.season_number).catch(() => null)));
  const out = [];
  lists.forEach((d, i) => {
    if (d && d.episodes) d.episodes.filter(isAired).forEach((e) => out.push({ season: seasons[i].season_number, episode: e.episode_number }));
  });
  return out;
}

/** Tous les épisodes précédant celui-ci (saisons antérieures complètes, puis la saison courante jusqu'à lui). */
function untilHere(m, s, e) {
  const out = [];
  (m.seasons || []).filter((x) => x.season_number > 0 && x.season_number < s).forEach((x) => {
    for (let k = 1; k <= (x.episode_count || 0); k++) out.push({ season: x.season_number, episode: k });
  });
  for (let k = 1; k <= e; k++) out.push({ season: s, episode: k });
  return out;
}

function closeMenu() {
  detailEl.querySelectorAll('.f-eps-head .ep-menu').forEach((x) => { x.hidden = true; });
  detailEl.querySelectorAll('[data-eps-menu]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const m = state.model;
  const menuBtn = t.closest('[data-eps-menu]');
  if (menuBtn) {
    e.preventDefault();
    const menu = menuBtn.parentElement.querySelector('.ep-menu');
    const open = menu.hidden;
    closeMenu();
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) { const first = menu.querySelector('button'); if (first) first.focus(); }
    return;
  }
  if (!t.closest('.f-eps-head .ep-menu')) closeMenu();
  if (!m) return;
  if (t.closest('[data-season-watch]')) {
    e.preventDefault();
    const refs = seasonAired();
    await mark(m.key, refs, !allWatched(m.key, refs));
    return;
  }
  const series = t.closest('[data-series-watch]');
  if (series) {
    e.preventDefault();
    closeMenu();
    toast('Marquage de la série…');
    const refs = await seriesAired(m);
    if (state.model !== m) return;
    await mark(m.key, refs, series.dataset.seriesWatch === '1');
    return;
  }
  const upto = t.closest('[data-upto]');
  if (upto) {
    e.preventDefault();
    const [s, ep] = upto.dataset.upto.split(':').map(Number);
    await mark(m.key, untilHere(m, s, ep), true);
    toast('Marqué comme vu jusqu’à É' + ep);
    return;
  }
  if (t.closest('[data-watch-movie]')) {
    e.preventDefault();
    await mark(m.key, null, !userStore.isWatched(m.key));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailEl.querySelector('.f-eps-head .ep-menu:not([hidden])')) { e.stopPropagation(); closeMenu(); }
}, true);

/** Série entière : tous les épisodes diffusés (saison 0 exclue). */
export async function markSeries(m, watched) {
  const refs = await seriesAired(m);
  const ok = await mark(m.key, refs, watched);
  if (ok && watched) setSeriesCompleted(m.key, true); // « vue en entier » : la série sort de l'accueil
  return ok;
}

/** Bascule d'un épisode (bouton coche d'une carte). */
export function toggleEpisode(btn) {
  const m = state.model;
  if (!m) return Promise.resolve(false);
  const [s, e] = btn.dataset.seen.slice(m.key.length + 1).split(':').map(Number);
  return mark(m.key, [{ season: s, episode: e }], !userStore.isWatched(m.key, s, e));
}
