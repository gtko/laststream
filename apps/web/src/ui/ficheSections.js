/* Port du prototype (voir tools/port-prototype.mjs). */
import { seasonEpisodes } from './seasons.js';
import { countdownText, isPlaceholderTitle, isSoonPlayable, playableBadge, soonBell, soonInnerHTML } from './soon.js';
import { userStore } from '../data/userStore';
import { refreshWatchedUI } from './watched.js';
import { setupWhy } from './why.js';
import { api, tmdb, why } from '../data/lt';
import { register, toItem } from './catalog.js';
import { episodeImage, focusEpisode, hasResume, inProgressRef, scrollToCard } from './epFocus.js';
import { detailEl } from './dom.js';
import { markNext, nextToWatch, ratingsHTML } from './fiche.js';
import { ICON } from './icons.js';
import './epStill.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { progressResume, resumePillHTML } from './resume.js';
import { esc, fmtDate, fmtMin } from './util.js';
import { playableSoon } from '../player/episodes';

// ---------- Fiche : sections chargées après coup ----------
/** Notes de la fiche serveur (même forme que la route MDBList), ou null si elle n'en donne pas. */
const serverRatingsOf = (m) => {
  const r = m.serverMeta && m.serverMeta.ratings && m.serverMeta.ratings.ratings;
  return r && typeof r === 'object' ? r : null;
};

export async function fillRatings(m, token) {
  const slot = detailEl.querySelector('#f-rates');
  if (!slot) return;
  let r = serverRatingsOf(m);
  if (r === null) {
    r = {};
    try {
      r = (await api('mdblist/' + m.type + '/' + (m.imdbId || m.id))).ratings || {};
    } catch (_) { /* notes indisponibles */ }
  }
  if (token !== state.token) return;
  slot.innerHTML = ratingsHTML(m, r);
  if (!slot.innerHTML) slot.hidden = true;
}

export async function fillWhy(m, token) {
  if (!m.overview && !m.genres.length) return;
  try {
    const j = await why(m.type, m.id);
    if (token !== state.token || !j.text) return;
    detailEl.querySelector('#f-why-text').textContent = j.text;
    detailEl.querySelector('#f-why').hidden = false;
    setupWhy(detailEl.querySelector('#f-why'));
  } catch (_) { /* section masquée en cas d'erreur */ }
}

export async function fillCollection(m, token) {
  const slot = detailEl.querySelector('#f-coll');
  if (!slot || !m.collection) return;
  const drop = () => {
    const p = detailEl.querySelector('#f-p-coll');
    if (p) p.remove();
  };
  try {
    const c = await tmdb('collection/' + m.collection.id);
    if (token !== state.token) return;
    const parts = (c.parts || []).filter((p) => p.poster_path && ((p.release_date || '9999') <= new Date().toISOString().slice(0, 10) || String(p.id) === String(m.id)))
      .sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')))
      .map((p) => register(toItem(p, 'movie')));
    if (parts.length < 2) { drop(); return; }
    slot.innerHTML = parts.map((it) => posterCard(it, { current: it.key === m.key })).join('');
    observeTiles(slot);
    const h = detailEl.querySelector('#f-p-coll-h');
    if (h && c.name) h.textContent = c.name;
  } catch (_) {
    if (token === state.token) drop();
  }
}

export async function fillNext(m, token) {
  const slot = detailEl.querySelector('#f-next');
  if (!slot) return;
  let date = m.next ? m.next.airDate : '';
  if (m.tvdbId && !m.canon) { // la numérotation canonique donne déjà le prochain épisode
    try {
      const tv = (m.serverMeta && m.serverMeta.tvdb) || await api('tvdb/series/' + m.tvdbId);
      if (tv && tv.nextAired) date = tv.nextAired;
    } catch (_) { /* repli sur TMDB */ }
  }
  if (token !== state.token || !date) return;
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return;
  const label = m.next ? m.next.code + (m.next.name ? ' « ' + m.next.name + ' »' : '') : '';
  // Diffusion dans les 14 prochains jours : la ligne lance la recherche de sources de cet épisode.
  const nums = m.next && m.next.airDate === date ? m.next : null;
  if (nums && nums.season != null && isSoonPlayable(date)) {
    slot.innerHTML = 'Prochain épisode : <button type="button" class="link-btn" data-play data-play-key="' + esc(m.key) + '" data-name="' + esc(m.name || '') +
      '" data-play-season="' + esc(nums.season) + '" data-play-episode="' + esc(nums.episode) + '" data-air="' + esc(date) + '">' +
      (label ? '<strong>' + esc(label) + '</strong> · ' : '') + esc(playableBadge(date)) + '</button>';
    return;
  }
  slot.innerHTML = 'Prochain épisode : ' + (label ? '<strong>' + esc(label) + '</strong> ' : '') + 'le ' + esc(fmtDate(date));
}

export async function loadSeason(m, n, token) {
  const list = detailEl.querySelector('#f-eplist');
  if (!list) return;
  detailEl.querySelectorAll('[data-season]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.season) === n)));
  list.setAttribute('aria-busy', 'true');
  list.innerHTML = '<li class="sk sk-ep"></li><li class="sk sk-ep"></li><li class="sk sk-ep"></li>';
  let data;
  try {
    data = await seasonEpisodes(m.id, n);
  } catch (_) {
    if (token !== state.token) return;
    list.innerHTML = '<li class="row-msg">Les épisodes n’ont pas pu être chargés. <button type="button" class="link-btn" data-season-retry="' + n + '">Réessayer</button></li>';
    list.removeAttribute('aria-busy');
    return;
  }
  if (token !== state.token) return;
  const today = new Date().toISOString().slice(0, 10);
  const eps = data.episodes || [];
  list.removeAttribute('aria-busy');
  if (!eps.length) {
    list.innerHTML = '<li class="row-msg">Aucun épisode renseigné pour cette saison.</li>';
    return;
  }
  list.innerHTML = eps.map((e) => {
    const code = 'É' + e.episode_number;
    const sk = m.key + ':' + n + ':' + e.episode_number;
    const done = userStore.isWatched(m.key, n, e.episode_number);
    const future = e.air_date && e.air_date > today;
    // Diffusion dans les 14 prochains jours : « peut-être déjà en ligne », lisible ; au-delà, carte « Bientôt ».
    const soonPlayable = future && playableSoon(e.air_date, today);
    const img = episodeImage(e.still_path, m.backdropPath);
    // Vignette qui ne charge pas : repli sur le fond de la série (jamais d’image cassée, voir epStill.js).
    const bgFb = img.fallback ? '' : episodeImage('', m.backdropPath).src;
    const meta = [e.runtime ? fmtMin(e.runtime) : '', e.air_date ? fmtDate(e.air_date) : ''].filter(Boolean).join(' · ');
    if (future && !soonPlayable) {
      const real = !isPlaceholderTitle(e.name);
      return '<li class="ep is-soon" data-ep="' + n + ':' + e.episode_number + '">' +
        '<div class="ep-main" role="group" aria-label="' + esc(m.name + ', saison ' + n + ', épisode ' + e.episode_number + ', ' + countdownText(e.air_date)) + '">' +
        soonInnerHTML({ airDate: e.air_date, season: n, episode: e.episode_number, epTitle: e.name, still: e.still_path, backdrop: m.backdropPath, poster: data.poster_path || m.posterPath, logo: m.logo, name: m.name }) +
        '<span class="ep-title">' + esc(code + (real ? ' · ' + e.name : '')) + '</span>' +
        '<span class="ep-meta">' + esc('Le ' + fmtDate(e.air_date) + ' · Bientôt' + (e.runtime ? ' · ' + fmtMin(e.runtime) : '')) + '</span>' +
        (e.overview ? '<span class="ep-ov">' + esc(e.overview) + '</span>' : '') + '</div>' + soonBell(m.key) + '</li>';
    }
    // Reprise : pastille et barre d’après la progression ; un épisode vu garde son état « vu » (pastille masquée en CSS).
    const rs = progressResume(userStore.getProgress(m.key, n, e.episode_number));
    const resumeAria = rs && !done ? ', reprise à ' + rs.label : '';
    return '<li class="ep' + (done ? ' is-seen' : '') + '" data-ep="' + n + ':' + e.episode_number + '"' + (soonPlayable ? ' data-air="' + esc(e.air_date) + '"' : '') + '>' +
      '<button type="button" class="ep-main" data-play aria-label="' + esc('Lire ' + code + ' : ' + (e.name || 'Épisode ' + e.episode_number) + resumeAria) + '">' +
      '<span class="ep-still' + (img.fallback ? ' is-fb' : '') + '">' + (img.src ? '<img src="' + esc(img.src) + '" alt="" loading="lazy" decoding="async" data-still' + (bgFb ? ' data-fb="' + esc(bgFb) + '"' : '') + '>' : '') +
      '<span class="ep-num" aria-hidden="true">' + esc(code) + '</span>' +
      (rs ? resumePillHTML(rs.label) : '') +
      '<span class="ep-bar" aria-hidden="true"><span style="width:' + (done ? 100 : rs ? Math.round(rs.ratio * 100) : 0) + '%"></span></span></span>' +
      '<span class="ep-title">' + esc(code + (isPlaceholderTitle(e.name) ? '' : ' · ' + e.name)) + '</span>' +
      '<span class="ep-meta">' + esc(meta) + (soonPlayable ? ' · déjà en ligne ?' : '') + '</span>' +
      (e.overview ? '<span class="ep-ov">' + esc(e.overview) + '</span>' : '') + '</button>' +
      (future ? ''
        : '<button type="button" class="ep-upto" data-upto="' + n + ':' + e.episode_number + '" aria-label="' + esc('Marquer comme vu jusqu’à ' + code) + '">Vu jusqu’ici</button>' +
          '<button type="button" class="ep-seen" data-seen="' + esc(sk) + '" aria-pressed="' + done + '" aria-label="' + esc((done ? 'Marquer comme non vu : ' : 'Marquer comme vu : ') + code) + '">' + ICON.check + '</button>') +
      '</li>';
  }).join('');
  state.seasonEps = { n, eps };
  refreshWatchedUI();
  markNext(m);
  // Saison de l’épisode à regarder : la carte (en cours, sinon prochain non vu, sinon dernier diffusé) est centrée, sans animation.
  const at = inProgressRef(m.key) || nextToWatch(m);
  const target = at && at.s === n ? focusEpisode(eps, { today, isSeen: (ep) => userStore.isWatched(m.key, n, ep), inProgress: (ep) => hasResume(m.key, n, ep) }) : null;
  const card = target != null ? list.querySelector('.ep[data-ep="' + n + ':' + target + '"]') : null;
  if (card) scrollToCard(list, card); else list.scrollLeft = 0;
}
