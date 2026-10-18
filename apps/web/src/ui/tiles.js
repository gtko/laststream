/* Port du prototype (voir tools/port-prototype.mjs). */
import { canonSummary } from '../data/series';
import { canonical } from './seasons.js';
import { fillMissingPosters } from './posters.js';
import { fallbackHTML } from './typo.js';
import { newEpisodeCount } from '../data/episodes';
import { userStore } from '../data/userStore';
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { certification, detailOf, pickLogo } from './catalog.js';
import { IMG } from './constants.js';
import { countdown, dayDiff, fmtShort, todayStr } from './dates.js';
import { getRemind } from './fiche.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { esc, fmtDate, fmtMin, fmtNum, typeLabel } from './util.js';

export const infoStore = new Map(); // clé -> infos chargées paresseusement (fournisseur, logo, fraîcheur)
export const enrichCache = new Map();
export const enrichQueue = [];
let enrichActive = 0;
let tileIO = null;

export function freshText(it, info) {
  const age = (d) => (d ? -dayDiff(d) : NaN);
  const a = age(it.date);
  if (it.type === 'movie') return a >= 0 && a < 14 ? 'Nouveau film' : '';
  if (a >= 0 && a < 14) return 'Nouvelle série';
  if (info) {
    const s = age(info.seasonDate);
    if (info.seasonNum > 1 && s >= 0 && s < 14) return 'Nouvelle saison';
  }
  return '';
}

export function tileCard(it, o) {
  o = o || {};
  const variant = o.variant || 'poster';
  const land = variant !== 'poster';
  const upDate = ''; // « Prochainement » a sa propre carte (upCard)
  const rank = (upDate || o.soon) ? 0 : (o.rank || state.top10.get(it.key) || 0);
  const fresh = o.soon ? 'Prochainement' : (!upDate && !rank ? freshText(it, infoStore.get(it.key)) : '');
  const src = land ? it.backdrop || it.poster : it.poster || it.backdrop; // sans affiche : le fond, recadré au centre
  const imdb = (detailOf(it).ratings || {}).imdb;
  const score = imdb != null ? fmtNum(imdb, 1) : it.vote;
  const metaTxt = o.sub || [it.genre, it.year, score ? '★ ' + score : ''].filter(Boolean).join(' · ');

  const label = [it.name];
  if (upDate) label.push('Prochainement, le ' + fmtDate(upDate) + (it.upLabel ? ' (' + it.upLabel + ')' : ''));
  else if (rank) label.push('Top 10 cette semaine, numéro ' + rank);
  else if (fresh) label.push(fresh);
  if (o.pct != null) label.push(o.pct + ' % vu');
  if (o.sub) label.push(o.sub);
  else if (!upDate && score) label.push('note ' + score);

  const ribbon = upDate
    ? '<span class="rib-up" aria-hidden="true"><span>Prochainement</span></span>'
    : rank ? '<span class="rib-top" aria-hidden="true"><b>TOP</b><i>' + rank + '</i><em>cette semaine</em></span>' : '';
  const badge = fresh ? '<span class="t-badge" aria-hidden="true">' + esc(fresh) + '</span>' : '';
  const dateBar = upDate
    ? '<span class="t-date" aria-hidden="true"><strong>' + esc((it.upLabel ? it.upLabel + ' · ' : '') + 'Le ' + fmtShort(upDate)) + '</strong><span>' + esc(countdown(upDate)) + '</span></span>' : '';
  const lazy = land || it.type === 'tv' || isKidProfile();

  const cls = 'card tile' + (land ? ' tile-land' : '') + (variant === 'logo' ? ' tile-logo' : '') + (upDate ? ' is-upcoming' : '') + (o.current ? ' is-current' : '') + (o.alwaysMeta ? ' meta-on' : '');
  const media =
    '<span class="card-media' + (src ? '' : ' no-img') + '">' +
    (src ? '<img src="' + esc(src) + '" alt="' + (land ? '' : esc(it.name)) + '" data-fb="' + esc(it.poster) + '" loading="lazy" decoding="async">' : '') +
    fallbackHTML(it) + ribbon + badge + dateBar +
    (land ? '<span class="t-shade" aria-hidden="true"></span><span class="t-titlewrap"><span class="t-title">' + esc(it.name) + '</span></span><span class="t-prov"></span>' : '') +
    '<span class="t-meta" aria-hidden="true">' + esc(metaTxt) + '</span>' +
    (it.cinema ? '<span class="t-cinema" aria-hidden="true">Au cinéma</span>' : '') +
    '<span class="t-more" aria-hidden="true" title="Plus d’options">•••</span>' +
    (o.removable ? '<span class="t-remove" data-continue-remove="' + esc(it.key) + '" aria-hidden="true" title="Retirer de Reprendre la lecture">' + ICON.close + '</span>' : '') +
    (it.type === 'movie' && userStore.isWatched(it.key) ? '<span class="t-watched" aria-hidden="true" title="Vu">' + ICON.check + '</span>' : '') +
    (o.pct != null ? '<span class="progress" aria-hidden="true"><span style="width:' + o.pct + '%"></span></span>' : '') +
    '</span>';
  return '<button type="button" class="' + cls + '" data-open="' + esc(it.key) + '" data-tile="' + esc(it.key) + '" data-variant="' + variant + '"' +
    (lazy ? ' data-lazy' : '') + (!upDate && !rank ? ' data-plain="1"' : '') + (fresh ? ' data-badge="1"' : '') +
    (o.current ? ' aria-current="true"' : '') + ' aria-label="' + esc(label.join(', ')) + '">' + media +
    (land ? '' : '<span class="card-title" aria-hidden="true">' + esc(it.name) + '</span>' +
      '<span class="card-meta" aria-hidden="true">' + esc(o.caption || (typeLabel(it) + (it.year ? ' · ' + it.year : ''))) + '</span>') +
    '</button>';
}

export const posterCard = (it, o) => tileCard(it, o);

export function topCard(it, n) {
  return '<button type="button" class="top-item" data-open="' + esc(it.key) + '" data-tile="' + esc(it.key) + '"' + (isKidProfile() ? ' data-lazy' : '') + ' aria-label="' + n + '. ' + esc(it.name) + ', Top 10 cette semaine">' +
    '<span class="rank" aria-hidden="true">' + n + '</span>' +
    '<span class="card-media' + (it.poster ? '' : ' no-img') + '">' +
    (it.poster ? '<img src="' + esc(it.poster) + '" alt="" decoding="async">' : '') +
    fallbackHTML(it) +
    '<span class="rib-top" aria-hidden="true"><b>TOP</b><i>' + n + '</i><em>cette semaine</em></span></span></button>';
}

// « Reprendre la lecture » : carte à logo avec la progression réelle.
export function continueCard(it, pct) {
  const d = detailOf(it);
  const rem = d.minutes ? Math.round(d.minutes * (1 - pct / 100)) : 0;
  return tileCard(it, { variant: 'logo', pct, alwaysMeta: true, removable: true, sub: typeLabel(it) + (rem ? ' · reste ' + fmtMin(rem) : '') });
}

// Chargement paresseux (tuiles visibles seulement) : fournisseur FR ou chaîne, logo du titre, fraîcheur.
import { isKidProfile, kidMaxAge } from '../data/auth';
import { kidAllows, kidGenreOk } from '../data/kid';

export function enrich(it, needLogo) {
  const ck = it.key + (needLogo ? '#l' : '');
  if (!enrichCache.has(ck)) {
    const job = new Promise((resolve) => {
      enrichQueue.push(async () => {
        try {
          const raw = await tmdb(it.type + '/' + it.id, {
            append_to_response: 'watch/providers' + (needLogo ? ',images' : '') + (isKidProfile() ? (it.type === 'tv' ? ',content_ratings' : ',release_dates') : ''),
            include_image_language: 'fr,en,null',
          });
          const fr = (raw['watch/providers'] && raw['watch/providers'].results && raw['watch/providers'].results[getRegion().code]) || {};
          const fl = (fr.flatrate || []).filter((x) => x.logo_path).sort((a, b) => (a.display_priority || 99) - (b.display_priority || 99))[0];
          const net = (raw.networks || []).find((n) => n.logo_path);
          const t = todayStr();
          const ss = (raw.seasons || []).filter((s) => s.season_number > 0 && s.air_date && s.air_date <= t);
          const last = ss[ss.length - 1];
          const info = Object.assign({}, infoStore.get(it.key), {
            provider: fl ? { name: fl.provider_name, logo: IMG('w92', fl.logo_path) } : net ? { name: net.name, logo: IMG('w92', net.logo_path) } : null,
            seasonNum: last ? last.season_number : 0,
            seasonDate: last ? last.air_date : '',
            epDate: (raw.last_episode_to_air && raw.last_episode_to_air.air_date) || '',
            cert: certification(raw, it.type),
            seasons: (raw.seasons || []).map((s) => ({ season_number: s.season_number, episode_count: s.episode_count })),
            lastAired: raw.last_episode_to_air ? { season_number: raw.last_episode_to_air.season_number, episode_number: raw.last_episode_to_air.episode_number } : null,
            genreIds: (raw.genres || []).map((g) => g.id),
          });
          if (needLogo) info.logo = pickLogo(raw.images && raw.images.logos, 'w300');
          infoStore.set(it.key, info);
          applyEnrich(it.key);
        } catch (_) {
          // Profil enfant : sans classification vérifiée, la tuile est retirée.
          if (isKidProfile()) removeTiles(it.key);
        }
        resolve();
      });
      pumpEnrich();
    });
    enrichCache.set(ck, job);
  }
  return enrichCache.get(ck).then(() => applyEnrich(it.key));
}

export function pumpEnrich() {
  while (enrichActive < 4 && enrichQueue.length) {
    const job = enrichQueue.shift();
    enrichActive++;
    job().then(() => { enrichActive--; pumpEnrich(); });
  }
}

/** Retire du DOM toutes les tuiles d'un titre (profil enfant). */
export function removeTiles(key) {
  document.querySelectorAll('[data-tile="' + key + '"]').forEach((el) => (el.closest('.up-item') || el).remove());
}

/** Badge « +N » (épisodes diffusés depuis le dernier vu) pour les séries suivies ou entamées, « Sorti » pour un film suivi. */
export function paintNewBadge(el, it, info) {
  const media = el.querySelector('.card-media');
  if (!media || !it) return;
  let text = '';
  let label = '';
  if (it.type === 'tv' && info && info.seasons) {
    const watched = userStore.watchedEpisodes(it.key);
    if (userStore.isFollowing(it.key) || watched.length) {
      let seasons = info.seasons;
      let lastAired = info.lastAired;
      if (info.canon) ({ seasons, lastAired } = info.canon);
      else if (info.canon === undefined) {
        // Une seule fois par série : la numérotation canonique remplace celle de TMDB, puis le badge est recalculé.
        info.canon = null;
        canonical(it.id).then((c) => {
          if (!c) return;
          const s = canonSummary(c, new Date().toISOString().slice(0, 10));
          info.canon = { seasons: s.seasons, lastAired: s.lastAired };
          document.querySelectorAll('[data-tile="' + it.key + '"]').forEach((t) => paintNewBadge(t, it, info));
        });
      }
      const n = newEpisodeCount(seasons, lastAired, watched);
      if (n > 0) { text = '+' + n; label = n === 1 ? '1 nouvel épisode' : n + ' nouveaux épisodes'; }
    }
  } else if (it.type === 'movie' && userStore.isFollowing(it.key) && !userStore.isWatched(it.key)) {
    const age = it.date ? -dayDiff(it.date) : NaN;
    if (age >= 0 && age <= 45) { text = 'Sorti'; label = 'Nouveau film sorti'; }
  }
  let badge = media.querySelector('.t-new');
  if (!text) { if (badge) badge.remove(); return; }
  if (!badge) { media.insertAdjacentHTML('beforeend', '<span class="t-new" role="img"></span>'); badge = media.querySelector('.t-new'); }
  badge.textContent = text;
  badge.setAttribute('aria-label', label);
}

export function refreshNewBadges() {
  document.querySelectorAll('[data-tile]').forEach((el) => {
    const it = state.byKey.get(el.dataset.tile);
    if (it) paintNewBadge(el, it, infoStore.get(el.dataset.tile));
  });
}

export function applyEnrich(key) {
  const info = infoStore.get(key);
  const it = state.byKey.get(key);
  if (!info || !it) return;
  if (isKidProfile()) {
    if (!kidAllows(info.cert, kidMaxAge()) || !kidGenreOk(info.genreIds)) { removeTiles(key); return; }
    document.querySelectorAll('[data-tile="' + key + '"]').forEach((el) => { el.dataset.kid = 'ok'; });
  }
  document.querySelectorAll('[data-tile="' + key + '"]').forEach((el) => {
    paintNewBadge(el, it, info);
    const prov = el.querySelector('.t-prov');
    if (prov && info.provider && !prov.firstChild) {
      prov.innerHTML = '<img src="' + esc(info.provider.logo) + '" alt="" title="' + esc(info.provider.name) + '" width="26" height="26">';
      el.setAttribute('aria-label', el.getAttribute('aria-label') + ', disponible sur ' + info.provider.name);
    }
    if (el.dataset.plain === '1' && !el.dataset.badge) {
      const ft = freshText(it, info);
      const media = el.querySelector('.card-media');
      if (ft && media) {
        el.dataset.badge = '1';
        media.insertAdjacentHTML('beforeend', '<span class="t-badge" aria-hidden="true">' + esc(ft) + '</span>');
        el.setAttribute('aria-label', el.getAttribute('aria-label') + ', ' + ft);
      }
    }
    if (el.dataset.variant === 'logo' && info.logo) {
      const t = el.querySelector('.t-title');
      if (t) t.outerHTML = '<img class="logo-img t-logo" src="' + esc(info.logo) + '" alt="' + esc(it.name) + '" data-logo="' + esc(it.name) + '">';
    }
  });
}

export function observeTiles(root) {
  if (!root || !root.querySelectorAll) return;
  // Tuiles sans image : on cherche une image dans TMDB avant de laisser l'affiche typographique.
  const missing = [];
  root.querySelectorAll('[data-tile] .card-media.no-img').forEach((m) => {
    const it = state.byKey.get(m.closest('[data-tile]').dataset.tile);
    if (it && it.type && !it.noImage) missing.push(it);
  });
  if (missing.length) fillMissingPosters(missing);
  root.querySelectorAll('[data-lazy]:not([data-obs])').forEach((el) => {
    el.dataset.obs = '1';
    const go1 = () => {
      const it = state.byKey.get(el.dataset.tile);
      if (it) enrich(it, el.dataset.variant === 'logo');
    };
    if (!('IntersectionObserver' in window)) { go1(); return; }
    if (!tileIO) {
      tileIO = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          tileIO.unobserve(e.target);
          const it = state.byKey.get(e.target.dataset.tile);
          if (it) enrich(it, e.target.dataset.variant === 'logo');
        });
      }, { rootMargin: '200px 100px' });
    }
    tileIO.observe(el);
  });
}

// Carte « Prochainement » : paysage net, logo du titre, bloc date calendrier, compte à rebours.
export function upCard(it) {
  const d = new Date(String(it.upDate) + 'T00:00:00');
  const day = d.getDate();
  const mon = d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toUpperCase();
  const cd = countdown(it.upDate);
  const cdTxt = cd ? cd.charAt(0).toUpperCase() + cd.slice(1).replace(/^Dans/, 'Dans') : '';
  const type = it.type === 'tv' ? it.upLabel || 'Série' : 'Film';
  const on = getRemind().includes(it.key);
  const src = it.backdrop || it.poster;
  const label = it.name + ', Prochainement, le ' + fmtDate(it.upDate) + (it.upLabel ? ' (' + it.upLabel + ')' : '') + ', ' + cd;
  return '<div class="up-item"><button type="button" class="up-card" data-open="' + esc(it.key) + '" data-tile="' + esc(it.key) + '" data-variant="logo" data-lazy aria-label="' + esc(label) + '">' +
    '<span class="up-media' + (src ? '' : ' no-img') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<span class="up-shade" aria-hidden="true"></span>' +
    '<span class="up-date" aria-hidden="true"><b>' + day + '</b><i>' + esc(mon) + '</i></span>' +
    (cdTxt ? '<span class="up-count" aria-hidden="true">' + esc(cdTxt) + '</span>' : '') +
    '<span class="t-titlewrap"><span class="t-title">' + esc(it.name) + '</span></span></span>' +
    '<span class="up-title" aria-hidden="true">' + esc(it.name) + '</span><span class="up-type" aria-hidden="true">' + esc(type) + '</span></button>' +
    '<button type="button" class="up-bell" data-remindkey="' + esc(it.key) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Rappel activé : ' : 'Me rappeler : ') + esc(it.name) + '" data-tip="' + (on ? 'Rappel activé' : 'Me rappeler') + '">' + (on ? ICON.check : ICON.bell) + '</button></div>';
}
