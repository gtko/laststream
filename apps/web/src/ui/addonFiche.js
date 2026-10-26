/* Fiche d'un titre d'addon (#/addon/<slug>/<type>/meta/<id>, ODY-252) : titre, fond, année, genres, synopsis, épisodes par saison
 * (séries) et lecture. Tout vient de l'addon, lu depuis l'appareil (`fetchAddonMeta`, `loadAddonSources`) : ni TMDB, ni IMDb, ni serveur,
 * donc jamais de message « Aucun identifiant IMDb ». Sans fiche complète (addon sans route `meta`, erreur), la page reprend l'aperçu gardé
 * par la rangée ou le catalogue, sans message d'erreur. L'adresse de l'addon, qui peut contenir un jeton, n'est jamais affichée ni journalisée. */
import { addonBaseOf, mappedIds, readAddonCatalogs } from '../data/addonCatalog';
import { isKidProfile } from '../data/auth';
import { addonTitleKey, isInAddonLibrary, toggleAddonLibrary } from '../data/addonUserStore';
import { numberedVideos } from '../player/addonRequest';
import { playBest, playSource } from '../player/sessionLoader.js';
import { fetchAddonMeta, loadAddonSources } from '../sources/addonSources';
import { openSourcePicker } from '../sources/picker.js';
import { addonPreviewKey, addonTypeLabel, previewOf } from './addonRows.js';
import { addonSlug } from './addonRoutes.js';
import { ficheHash } from './ficheRoute.js';
import { topBar } from './fragments.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

/** Types de fiche à épisodes (la liste vient de l'addon). */
const SERIES = new Set(['series', 'anime', 'tv']);
const NO_SOURCE = 'Aucune source trouvée sur cet addon';

const notice = (msg, action = '') => '<div class="state" role="status"><p>' + esc(msg) + '</p>' + action + '</div>';
const SETTINGS = '<div class="f-actions"><a class="btn btn-ghost" href="#/settings" data-go>Ouvrir les réglages</a></div>';
const HOME = '<div class="f-actions"><a class="btn btn-ghost" href="#/" data-go>Retour à l’accueil</a></div>';

const yearOf = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const m = /\d{4}/.exec(s);
  return m ? m[0] : '';
};
const runtimeText = (r) => (typeof r === 'number' ? r + ' min' : typeof r === 'string' ? r.trim() : '');

/** Aperçu gardé par la rangée ou le catalogue (sessionStorage), nettoyé comme à l'écriture. Null si absent ou illisible. */
function readPreview(slug, type, id) {
  try {
    const raw = globalThis.sessionStorage?.getItem(addonPreviewKey(slug, type, id));
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const preview = previewOf(data);
    return typeof preview.name === 'string' && preview.name ? preview : null;
  } catch {
    return null;
  }
}

/** Ce qu'affiche la page : l'aperçu, complété par la fiche de l'addon quand elle existe. Champs nettoyés. */
function modelOf(type, id, preview, meta) {
  const base = { ...(preview || {}), ...(meta ? previewOf(meta) : {}) };
  return {
    type,
    id,
    name: typeof base.name === 'string' ? base.name : '',
    poster: base.poster || '',
    backdrop: base.background || base.poster || '',
    year: yearOf(base.releaseInfo) || yearOf(meta ? meta.year : undefined),
    runtime: base.runtime,
    genres: Array.isArray(base.genres) ? base.genres : [],
    description: typeof base.description === 'string' ? base.description : '',
    videos: meta && Array.isArray(meta.videos) ? numberedVideos(meta.videos) : [],
    ids: meta ? mappedIds(meta) : {},
    loaded: !!meta, // fiche complète lue (et non le seul aperçu) : seul cas où « aucun épisode » est affirmé
  };
}

const libLabel = (on) => (on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream');
const libTip = (on) => (on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream');
const libHTML = (on) =>
  '<button type="button" class="btn-round' + (on ? ' is-on' : '') + '" data-lib aria-pressed="' + on + '" data-tip="' + libTip(on) +
  '" aria-label="' + libLabel(on) + '">' + (on ? ICON.check : ICON.list) + '</button>';

const epRowsHTML = (m, season, canStream) => m.videos.filter((v) => v.season === season).map((v) =>
  '<li class="ep"><div class="ep-main"><span class="ep-title">' + esc(v.title || 'Épisode ' + v.episode) + '</span>' +
  '<span class="ep-meta">Saison ' + v.season + ' · épisode ' + v.episode + '</span></div>' +
  (canStream ? '<button type="button" class="btn btn-ghost btn-sm" data-ep="' + v.season + ':' + v.episode + '">Lire</button>' : '') +
  '</li>').join('');

function episodesHTML(m, canStream) {
  if (!SERIES.has(m.type)) return '';
  // Série sans épisode numéroté, fiche lue : un mot discret, sans liste vide.
  if (!m.videos.length) return m.loaded ? '<div class="f-panels"><p class="f-next">Aucun épisode disponible sur cet addon</p></div>' : '';
  const seasons = [...new Set(m.videos.map((v) => v.season))];
  const options = seasons.map((s) => '<option value="' + s + '">Saison ' + s + '</option>').join('');
  return '<div class="f-panels"><section class="f-sec" id="f-p-eps" aria-labelledby="f-p-eps-h"><h2 class="f-sec-title" id="f-p-eps-h">Épisodes</h2>' +
    '<div class="f-eps-head"><label class="dc-field" for="af-season"><span>Saison</span><select id="af-season">' + options + '</select></label></div>' +
    '<ol class="eps" id="af-eplist" data-nav>' + epRowsHTML(m, seasons[0], canStream) + '</ol></section></div>';
}

/** Page complète : fond, titre, méta, synopsis, actions, épisodes. `libOn` : titre déjà dans la bibliothèque d'addons. */
function pageHTML(m, sourceName, canStream, libOn) {
  const metaItems = [addonTypeLabel(m.type), m.year, runtimeText(m.runtime), m.genres.slice(0, 3).join(' · ')]
    .filter(Boolean).map((x) => '<li>' + esc(x) + '</li>').join('');
  const isSeries = SERIES.has(m.type);
  const actions = [];
  if (!isSeries && canStream) {
    actions.push('<button type="button" class="btn btn-primary btn-pill" data-play>' + ICON.play + '<span class="f-play-label">Lecture</span></button>');
    actions.push('<button type="button" class="btn btn-ghost" data-sources>Sources</button>');
  }
  actions.push(libHTML(libOn));
  if (m.ids.tmdb) {
    actions.push('<a class="btn btn-ghost" href="' + esc(ficheHash(m.type === 'movie' ? 'movie' : 'tv', m.ids.tmdb)) + '" data-go>Voir la fiche complète</a>');
  }
  return topBar(false) +
    '<article class="fiche af-fiche" aria-labelledby="f-title" tabindex="-1">' +
    '<div class="f-bg' + (m.backdrop ? '' : ' no-img') + '">' + (m.backdrop ? '<img src="' + esc(m.backdrop) + '" alt="" decoding="async">' : '') + '</div>' +
    '<div class="f-scrim" aria-hidden="true"></div>' +
    '<section class="f-first" aria-label="Présentation"><div class="f-info">' +
    '<p class="f-release"><span>Addon</span> ' + esc(sourceName) + '</p>' +
    '<h1 class="f-title" id="f-title" tabindex="-1"><span class="title-text">' + esc(m.name) + '</span></h1>' +
    '<ul class="meta f-meta">' + metaItems + '</ul>' +
    '<div class="f-syn"><p class="f-ov">' + esc(m.description || 'Pas de synopsis disponible.') + '</p></div>' +
    '<div class="f-actions" data-nav>' + actions.join('') + '</div>' +
    '<p class="f-next" id="af-msg" role="status"></p>' +
    '</div></section>' +
    episodesHTML(m, canStream) +
    '</article>';
}

/**
 * Affiche la fiche `{ addonKey, type, id }` dans `root`. Renvoie `{ destroy }` : à appeler en quittant la page (les réponses en
 * retard ne réécrivent plus la page). `addonKey` absent du registre : message « plus activé ».
 */
export function showAddonFiche(root, { addonKey, type, id }) {
  const entry = addonKey ? readAddonCatalogs()[addonKey] : undefined;
  let alive = true;
  const done = { destroy() { alive = false; } };

  if (isKidProfile()) {
    root.innerHTML = topBar(false) + '<article class="svc-page" tabindex="-1">' + notice('Cette fiche n’est pas disponible sur ce profil.') + '</article>';
    return done;
  }
  if (!entry) {
    root.innerHTML = topBar(false) + '<article class="svc-page" tabindex="-1">' + notice('Ce catalogue n’est plus activé.', SETTINGS) + '</article>';
    return done;
  }

  const canStream = entry.resources?.stream !== false;
  const libKey = addonTitleKey(type, id);
  const preview = readPreview(addonSlug(addonKey), type, id);
  let painted = false;

  /** Demande de lecture d'un titre d'addon (forme attendue par la session) : `video` pour un épisode, sinon le film. */
  const requestOf = (m, video) => ({
    type: video || SERIES.has(m.type) ? 'tv' : 'movie',
    id: String(id),
    name: m.name,
    key: libKey,
    season: video ? video.season : null,
    episode: video ? video.episode : null,
    ...(video ? { streamId: video.id } : {}),
    addon: { key: addonKey, base: addonBaseOf(entry.manifestUrl), type, id, title: m.name, videos: m.videos },
  });

  const setMsg = (text) => {
    const el = root.querySelector('#af-msg');
    if (el) el.textContent = text;
  };

  const sourcesOf = async (m, btn) => {
    btn.disabled = true;
    setMsg('Recherche des sources…');
    const views = await loadAddonSources(entry, type, id).catch(() => []);
    if (!alive) return;
    btn.disabled = false;
    if (!views.length) {
      setMsg(NO_SOURCE);
      return;
    }
    setMsg('');
    const request = requestOf(m, null);
    // Sélecteur avec les sources déjà chargées : il ne cherche rien de plus (pas de voie TMDB / IMDb).
    openSourcePicker(request, btn, { views, onPick: (view) => { void Promise.resolve(playSource(request, views, view, btn)).catch(() => undefined); } });
  };

  const toggleLib = (m, btn) => {
    const on = toggleAddonLibrary({ key: libKey, addonKey, type, id, title: m.name, poster: m.poster || undefined, year: m.year || undefined });
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
    btn.setAttribute('data-tip', libTip(on));
    btn.setAttribute('aria-label', libLabel(on));
    btn.innerHTML = on ? ICON.check : ICON.list;
  };

  const paint = (m) => {
    root.innerHTML = pageHTML(m, entry.name, canStream, isInAddonLibrary(libKey));
    document.title = m.name + ' · Laststream';
    const article = root.querySelector('.af-fiche');
    if (article) {
      article.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('button') : null;
        if (!btn) return;
        if (btn.hasAttribute('data-play')) void Promise.resolve(playBest(requestOf(m, null), btn)).catch(() => undefined);
        else if (btn.hasAttribute('data-sources')) sourcesOf(m, btn);
        else if (btn.hasAttribute('data-lib')) toggleLib(m, btn);
        else if (btn.dataset.ep) {
          const [s, ep] = btn.dataset.ep.split(':').map(Number);
          const video = m.videos.find((v) => v.season === s && v.episode === ep);
          if (video) void Promise.resolve(playBest(requestOf(m, video), btn)).catch(() => undefined);
        }
      });
    }
    const season = root.querySelector('#af-season');
    if (season) {
      season.addEventListener('change', () => {
        const list = root.querySelector('#af-eplist');
        if (list) list.innerHTML = epRowsHTML(m, Number(season.value), canStream);
      });
    }
    const h1 = root.querySelector('#f-title');
    if (h1 && !painted) h1.focus({ preventScroll: true });
    painted = true;
  };

  const model = modelOf(type, id, preview, null);
  if (model.name) paint(model);
  else root.innerHTML = topBar(false) + '<article class="svc-page" tabindex="-1" aria-busy="true">' + notice('Chargement de la fiche…') + '</article>';

  fetchAddonMeta(entry, type, id).catch(() => ({})).then((res) => {
    if (!alive) return;
    if (!res.meta) {
      // Pas de fiche complète : l'aperçu (déjà affiché) suffit, sans message ; sans aperçu, la fiche ne peut pas s'afficher.
      if (!model.name) root.innerHTML = topBar(false) + '<article class="svc-page" tabindex="-1">' + notice('Cette fiche n’a pas pu être chargée.', HOME) + '</article>';
      return;
    }
    paint(modelOf(type, id, preview, res.meta));
  });

  return done;
}
