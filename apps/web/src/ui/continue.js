/* « Reprendre la lecture » : cartes paysage 16:9 montrant où tu en es (épisode en cours, logo, temps restant, progression). */
import { nextSeasonNumber, seasonEpisodes } from './seasons.js';
import { fallbackHTML } from './typo.js';
import { userStore } from '../data/userStore';
import { getDetail, register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { dayDiff } from './dates.js';
import { ICON } from './icons.js';
import { progressResume } from './resume.js';
import { isSoonPlayable, playableBadge } from './soon.js';
import { playDirect } from './sources-ui.js';
import { esc, fmtMin } from './util.js';

const placeholder = (t) => !t || /^\s*(é|e)pisode\s*\d+\s*$/i.test(t);

/** Empreinte de ce qui s'affiche sur une carte : une carte inchangée est gardée telle quelle lors d'un rafraîchissement. */
export function continueSig(p) {
  return [p.key, p.position, p.duration, p.updatedAt, p.finished ? 1 : 0, p.suggested ? 1 : 0, p.season, p.episode, p.title, p.poster, p.backdrop].join('|');
}

/** Séries dont la carte a été retirée (plus d'épisode suivant) : tant que leur progression ne change pas, elle reste absente. */
const endedSigs = new Set();
export const isSeriesEnded = (p) => endedSigs.has(continueSig(p));

export function continueCardHTML(p) {
  const sig = continueSig(p);
  const raw = { id: p.id, poster_path: p.poster, backdrop_path: p.backdrop || '' };
  raw[p.type === 'tv' ? 'name' : 'title'] = p.title;
  const it = register(toItem(raw, p.type));
  const next = p.suggested ? 'self' : p.finished ? 'after' : '';
  const pct = next || !p.duration ? 0 : Math.max(0, Math.min(100, Math.round((p.position / p.duration) * 100)));
  const left = !next && p.duration ? Math.max(1, Math.round((p.duration - p.position) / 60)) : 0;
  const rs = next ? null : progressResume(p); // timecode + pourcentage, absents hors de la plage affichée
  const restTxt = left ? 'reste ' + (left >= 60 ? fmtMin(left) : left + ' min') : '';
  const code = p.type === 'tv' && p.season != null ? 'S' + p.season + ' · É' + p.episode : '';
  const src = IMG('w780', p.backdrop) || IMG('w500', p.poster);
  const info = next ? 'À suivre' + (code ? ' : ' + code : '') : (code || (left ? '' : 'Film'));
  return '<button type="button" class="card tile tile-land cont-card" data-tile="' + esc(it.key) + '" data-resume="' + esc(it.key) + '" data-next="' + next + '"' +
    ' data-season="' + (p.season != null ? p.season : '') + '" data-episode="' + (p.episode != null ? p.episode : '') + '" data-variant="logo" data-sig="' + esc(sig) + '"' +
    ' aria-label="' + esc('Reprendre ' + p.title + (code ? ', ' + code : '') + (rs ? ', reprise à ' + rs.label : '') + (left ? ', reste ' + left + ' min' : '')) + '">' +
    '<span class="card-media' + (src ? '' : ' no-img') + '">' +
    (src ? '<img class="cont-img" src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: p.title, type: p.type }) +
    '<span class="cont-shade" aria-hidden="true"></span>' +
    '<span class="cont-new" aria-hidden="true" hidden>Nouveau</span>' +
    '<span class="cont-play" aria-hidden="true">' + ICON.play + '</span>' +
    '<span class="cont-info"><span class="cont-name">' + esc(p.title) + '</span>' +
    '<span class="cont-code">' + esc(info) + '</span>' +
    '<span class="cont-left">' + esc([rs ? rs.label : '', restTxt].filter(Boolean).join(' · ')) + '</span></span>' +
    '<span class="t-more" aria-hidden="true" title="Plus d’options">•••</span>' +
    '<span class="t-remove" data-continue-remove="' + esc(it.key) + '" aria-hidden="true" title="Retirer de Reprendre la lecture">' + ICON.close + '</span>' +
    '<span class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></span></span></button>';
}

async function episodeAfter(id, season, episode) {
  let s = await seasonEpisodes(id, season);
  let e = (s.episodes || []).find((x) => x.episode_number === episode + 1);
  if (e) return { season, e };
  const nxt = await nextSeasonNumber(id, season);
  if (nxt == null) return null;
  s = await seasonEpisodes(id, nxt);
  e = (s.episodes || []).sort((a, b) => a.episode_number - b.episode_number)[0];
  return e ? { season: nxt, e } : null;
}

async function hydrateCard(card) {
  const key = card.dataset.resume;
  const [type, id] = key.split(':');
  const it = (await import('./state.js')).state.byKey.get(key);
  const media = card.querySelector('.card-media');
  // Logo de la série ou du film (sinon son nom reste affiché).
  if (it) {
    getDetail(it).then((d) => {
      if (!d || !d.logo || !card.isConnected) return;
      const name = card.querySelector('.cont-name');
      if (name) name.outerHTML = '<img class="logo-img cont-logo" src="' + esc(d.logo) + '" alt="' + esc(it.name) + '" data-logo="' + esc(it.name) + '">';
    });
  }
  if (type !== 'tv' || card.dataset.season === '') return;
  let season = Number(card.dataset.season);
  let episode = Number(card.dataset.episode);
  try {
    let ep;
    if (card.dataset.next === 'after') {
      const nx = await episodeAfter(id, season, episode);
      if (!nx) { removeCard(card); return; } // série terminée
      season = nx.season;
      ep = nx.e;
      episode = ep.episode_number;
      card.dataset.season = String(season);
      card.dataset.episode = String(episode);
    } else {
      const s = await seasonEpisodes(id, season);
      ep = (s.episodes || []).find((x) => x.episode_number === episode);
      // Épisode suggéré par le serveur (dernier vu + 1) au-delà de la fin de saison : premier épisode de la saison suivante.
      if (!ep && card.dataset.next === 'self' && episode > 1 && (s.episodes || []).length) {
        const nx = await episodeAfter(id, season, episode - 1);
        if (!nx) { removeCard(card); return; } // série terminée
        season = nx.season;
        ep = nx.e;
        episode = ep.episode_number;
        card.dataset.season = String(season);
        card.dataset.episode = String(episode);
      }
    }
    if (!ep || !card.isConnected) return;
    const code = 'S' + season + ' · É' + episode + (placeholder(ep.name) ? '' : ' · ' + ep.name);
    card.querySelector('.cont-code').textContent = card.dataset.next ? 'À suivre : ' + code : code;
    // Épisode diffusé dans les 14 prochains jours : lisible, la lecture lance la recherche de sources (data-air).
    if (card.dataset.next && isSoonPlayable(ep.air_date)) {
      card.dataset.air = ep.air_date;
      const left = card.querySelector('.cont-left');
      if (left) left.textContent = playableBadge(ep.air_date);
    }
    if (ep.still_path) {
      const img = card.querySelector('.cont-img');
      if (img) img.src = IMG('w780', ep.still_path);
      else if (media) { media.insertAdjacentHTML('afterbegin', '<img class="cont-img" src="' + IMG('w780', ep.still_path) + '" alt="" decoding="async">'); media.classList.remove('no-img'); }
    }
    const age = ep.air_date ? -dayDiff(ep.air_date) : NaN;
    const fresh = card.querySelector('.cont-new');
    if (fresh && card.dataset.next && age >= 0 && age <= 7) fresh.hidden = false;
  } catch (_) { /* la carte reste telle quelle */ }
}

function removeCard(card) {
  const sec = card.closest('.row-section');
  if (card.dataset.sig) endedSigs.add(card.dataset.sig);
  card.remove();
  if (sec && !sec.querySelector('.cont-card')) sec.remove();
}

/** Complète les cartes affichées : épisode en cours, visuel, logo, « Nouveau ». */
export function hydrateContinue(root) {
  if (!root) return;
  root.querySelectorAll('.cont-card').forEach((c) => { if (!c.dataset.hyd) { c.dataset.hyd = '1'; hydrateCard(c); } });
}

/** Reprend la lecture à la position enregistrée, sans passer par le tiroir de sources quand une source convient. */
export async function resumeCard(card) {
  const key = card.dataset.resume;
  const [type, id] = key.split(':');
  const entry = userStore.continueWatching(50).find((p) => p.key === key);
  const it = (await import('./state.js')).state.byKey.get(key);
  const season = card.dataset.season !== '' ? Number(card.dataset.season) : null;
  const episode = card.dataset.episode !== '' ? Number(card.dataset.episode) : null;
  await playDirect({ type, id, name: (it && it.name) || (entry && entry.title) || '', season: type === 'tv' ? season : null, episode: type === 'tv' ? episode : null, key }, card,
    card.dataset.air ? { notYetAired: card.dataset.air } : {});
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest('.t-more, .t-remove')) return;
  const card = t.closest('.cont-card');
  if (!card) return;
  e.preventDefault();
  e.stopPropagation();
  resumeCard(card);
}, true);
