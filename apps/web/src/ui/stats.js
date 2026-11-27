/* Page « Statistiques » (#/stats) : chiffres du profil actif, rythme sur 12 mois, genres, décennies, acteurs et réalisateurs,
 * repères. Calcul côté client : l'historique « vu » (userStore) et, pour au plus DETAIL_LIMIT titres (les plus récents et les
 * plus vus), la fiche TMDB avec crédits, gardée dans le navigateur. Le rendu part du cache puis se complète ; le reste est estimé.
 * Profil enfant : page absente (le routeur refuse la route). */
import '../styles/stats.css';
import { isKidProfile } from '../data/auth';
import { onDataEvent } from '../data/events';
import { tmdb } from '../data/lt';
import { userStore } from '../data/userStore';
import { watchedProgressLabel } from '../data/watchedHistory';
import { computeStats, DAYPARTS, DETAIL_LIMIT, isFreshMeta, metaFromTmdb, pickDetailTargets, readMetaCache, WEEKDAYS, writeMetaCache } from '../data/stats';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { columnsSvg, rowsSvg } from './statsCharts.js';
import { state } from './state.js';
import { esc, fmtMin } from './util.js';
import { t as tr } from '../i18n';

const MONTH_SHORT = ['jan', tr('fév'), 'mar', 'avr', 'mai', 'juin', 'juil', tr('août'), 'sep', 'oct', 'nov', tr('déc')];
const WEEK_SHORT = [tr('Lun'), tr('Mar'), tr('Mer'), tr('Jeu'), tr('Ven'), tr('Sam'), tr('Dim')];
const ROLE_LABEL = { director: tr('Réalisateur'), creator: tr('Créateur'), cast: tr('Acteur') };

const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
const int = (n) => Math.round(n).toLocaleString('fr-FR');
const count = (n, one, many) => int(n) + ' ' + (n === 1 ? one : many);
const argmax = (a) => a.indexOf(Math.max(...a));
const fmtDay = (ts) => new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDuration = (minutes) => fmtMin(minutes) || tr('0 min');

let runId = 0;

/** Ouvre la page (#/stats) du profil actif et calcule ses statistiques. */
export function showStats() {
  if (isKidProfile()) return undefined;
  teardownFiche();
  state.kind = 'stats';
  document.title = tr('Statistiques · Laststream');
  const who = userStore.currentProfile().name || '';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page stats-page" aria-labelledby="stats-title">' +
    '<header class="stats-head"><p class="svc-eyebrow">' + esc(who ? tr('Profil · {who}', { who }) : tr('Profil')) + '</p>' +
    '<h1 class="stats-title" id="stats-title" tabindex="-1">' + tr('Statistiques') + '</h1>' +
    '<p class="stats-intro">' + tr('Ce que ce profil a regardé : films et séries marqués vus ou terminés.') + '</p></header>' +
    '<div class="stats-body" id="stats-body" aria-live="polite"><p class="row-msg">' + tr('Calcul des statistiques…') + '</p></div></article>';
  detailEl.querySelector('#stats-title')?.focus({ preventScroll: true });
  return refresh();
}

/** Affiche tout de suite ce que le cache permet, puis complète avec les fiches TMDB manquantes (au plus DETAIL_LIMIT appels). */
async function refresh() {
  const mine = ++runId;
  const titles = userStore.watchedTitles().filter((t) => t.watched > 0);
  const ratings = userStore.getRatings().length;
  const cache = readMetaCache(storage());
  const now = Date.now();
  const metas = new Map();
  const missing = [];
  for (const t of pickDetailTargets(titles, DETAIL_LIMIT)) {
    const hit = cache.get(t.key);
    if (hit && isFreshMeta(hit, now)) metas.set(t.key, hit.meta);
    else missing.push(t);
  }
  paint(titles, metas, ratings, missing.length > 0);
  if (!missing.length) return;
  const fetched = await fetchMetas(missing);
  if (mine !== runId) return;
  for (const [key, entry] of fetched) {
    metas.set(key, entry.meta);
    cache.set(key, entry);
  }
  if (fetched.size) writeMetaCache(storage(), cache);
  paint(titles, metas, ratings, false);
}

/** Fiches TMDB avec crédits ; un échec laisse le titre estimé (il sera retenté à la prochaine ouverture). */
async function fetchMetas(targets) {
  const out = new Map();
  await Promise.all(targets.map((t) => tmdb(t.type + '/' + t.id, { append_to_response: 'credits' })
    .then((raw) => { out.set(t.key, { at: Date.now(), meta: metaFromTmdb(t.type, t.key, raw) }); })
    .catch(() => undefined)));
  return out;
}

function paint(titles, metas, ratings, loading) {
  const body = detailEl.querySelector('#stats-body');
  if (!body || state.kind !== 'stats') return;
  body.innerHTML = renderStats(computeStats({ titles, metas, ratings, now: Date.now() }), loading);
}

const card = (k, v, s = '') => '<div class="stat-card"><span class="stat-k">' + esc(k) + '</span><strong class="stat-v">' + v + '</strong>' +
  (s ? '<span class="stat-s">' + esc(s) + '</span>' : '') + '</div>';
const panel = (title, body, wide = false) => '<section class="stats-panel' + (wide ? ' is-wide' : '') + '"><h2>' + esc(title) + '</h2>' + body + '</section>';
const note = (text) => '<p class="stats-note">' + esc(text) + '</p>';

function emptyState() {
  return '<div class="stats-empty"><p class="stats-empty-t">' + tr('Pas encore de statistiques') + '</p>' +
    '<p>' + tr('Marque des films et des séries comme vus, ou termine-les : le temps regardé, les genres et les acteurs préférés apparaîtront ici, même hors de « Ma bibliothèque ».') + '</p>' +
    '<a class="btn btn-ghost" href="#/" data-go>' + tr('Retour à l’accueil') + '</a></div>';
}

/** Explication d'un panneau sans données : fiches TMDB en cours de chargement, indisponibles, ou simplement vides. */
function detailNote(s, loading) {
  if (loading) return tr('Chargement des fiches TMDB…');
  if (s.totals.detailed === 0) return tr('Fiches TMDB indisponibles pour l’instant : genres, décennies et personnes ne peuvent pas être calculés.');
  return tr('Pas encore de données pour ce panneau.');
}

function renderStats(s, loading) {
  if (s.empty) return emptyState();
  const t = s.totals;
  const estShare = t.minutes > 0 ? Math.round((t.estimatedMinutes / t.minutes) * 100) : 0;
  const cards = '<div class="stats-cards">' +
    card(tr('Temps regardé'), (estShare ? '≈ ' : '') + esc(fmtDuration(t.minutes)), estShare ? tr('dont {estShare} % estimé', { estShare }) : tr('d’après les durées TMDB')) +
    card(tr('Films vus'), int(t.movies)) +
    card(tr('Épisodes vus'), int(t.episodes), count(t.seriesDone + t.seriesOngoing, tr('série'), tr('séries'))) +
    card(tr('Séries terminées'), int(t.seriesDone), tr('tous les épisodes vus')) +
    card(tr('Séries en cours'), int(t.seriesOngoing), tr('au moins un épisode vu')) +
    card(tr('Titres notés'), int(t.rated)) +
    '</div>';
  const status = loading ? '<p class="stats-loading" role="status">' + tr('Chargement des fiches TMDB : les chiffres se mettent à jour.') + '</p>' : '';
  return status + cards + '<div class="stats-grid">' +
    monthsPanel(s) + rhythmPanel(s) + reperesPanel(s) + genresPanel(s, loading) + decadesPanel(s, loading) + peoplePanel(s, loading) +
    '</div>' + footnote(s);
}

function monthsPanel(s) {
  if (!s.hasDates) return panel(tr('Heures par mois'), note(tr('Pas de dates de visionnage sur cet appareil : le graphique apparaît avec l’historique du compte.')), true);
  const items = s.months.map((m) => ({ label: MONTH_SHORT[m.month], value: m.minutes / 60, title: MONTH_SHORT[m.month] + ' : ' + fmtDuration(m.minutes) }));
  return panel(tr('Heures par mois'),
    '<p class="stats-sub">' + tr('12 derniers mois') + '</p>' +
    columnsSvg(items, { ariaLabel: tr('Heures regardées par mois, sur les 12 derniers mois'), fmt: (v) => (v >= 1 ? String(Math.round(v)) : '') }) +
    note(tr('Chaque titre compte pour le mois de sa dernière lecture.')), true);
}

function rhythmPanel(s) {
  if (!s.hasDates) return panel(tr('Jour et moment préférés'), note(tr('Disponible quand l’historique du compte a des dates de lecture.')));
  if (!s.weekday.some((m) => m > 0)) return panel(tr('Jour et moment préférés'), note(tr('Pas encore assez de dates de lecture.')));
  const items = WEEK_SHORT.map((label, i) => ({ label, value: s.weekday[i] / 60, title: WEEKDAYS[i] + ' : ' + fmtDuration(s.weekday[i]) }));
  return panel(tr('Jour et moment préférés'),
    '<p class="stats-line">' + tr('Jour préféré : <strong>{v}</strong><br>Moment préféré : <strong>{v2}</strong>', { v: WEEKDAYS[argmax(s.weekday)], v2: esc(DAYPARTS[argmax(s.dayparts)].toLowerCase()) }) + '</p>' +
    columnsSvg(items, { ariaLabel: tr('Heures regardées par jour de la semaine'), fmt: (v) => (v >= 1 ? String(Math.round(v)) : ''), height: 130 }) +
    note(tr('D’après la dernière lecture de chaque titre, à l’heure locale.')));
}

function reperesPanel(s) {
  const hasTv = s.totals.seriesDone + s.totals.seriesOngoing > 0;
  const streak = s.streak.current ? tr('<strong>{current} d’affilée</strong>', { current: count(s.streak.current, 'jour', 'jours') }) : tr('aucune en cours');
  const rows = [
    [tr('Série de jours'), s.hasDates ? tr('{streak} · record : {best}', { streak, best: count(s.streak.best, 'jour', 'jours') }) : tr('non disponible sur cet appareil')],
    [tr('Dernier visionnage'), s.lastWatch
      ? esc(s.lastWatch.name ?? tr('Titre non détaillé')) + '<br><span class="stats-sub">' + esc(fmtDay(s.lastWatch.at)) + '</span>'
      : tr('non disponible sur cet appareil')],
    [tr('Série la plus regardée'), s.topSeries
      ? esc(s.topSeries.name) + '<br><span class="stats-sub">' + esc(watchedProgressLabel(s.topSeries.watched, s.topSeries.episodes)) + (s.topSeries.complete ? ' ' + tr('· terminée') : '') + '</span>'
      : (hasTv ? tr('fiche TMDB indisponible') : tr('aucune série vue'))],
  ];
  return panel(tr('Repères'), '<dl class="stats-kv">' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>');
}

function genresPanel(s, loading) {
  if (!s.genres.length) return panel(tr('Genres préférés'), note(detailNote(s, loading)));
  return panel(tr('Genres préférés'),
    '<p class="stats-sub">' + tr('Titres vus par genre (8 premiers)') + '</p>' +
    rowsSvg(s.genres.map((g) => ({ label: g.name, value: g.count })), { ariaLabel: tr('Titres vus par genre'), fmt: (v) => String(v) }));
}

function decadesPanel(s, loading) {
  if (!s.decades.length) return panel(tr('Décennies de sortie'), note(detailNote(s, loading)));
  const items = s.decades.map((d) => ({ label: '’' + String(d.decade % 100).padStart(2, '0'), value: d.count, title: d.decade + ' : ' + count(d.count, 'titre', 'titres') }));
  return panel(tr('Décennies de sortie'),
    '<p class="stats-sub">' + tr('Titres vus par décennie de sortie') + '</p>' +
    columnsSvg(items, { ariaLabel: tr('Titres vus par décennie de sortie'), fmt: (v) => String(v), height: 140 }));
}

function peoplePanel(s, loading) {
  if (!s.people.length) return panel(tr('Acteurs et réalisateurs les plus vus'), note(detailNote(s, loading)), true);
  const items = s.people.map((p) => '<li><span class="sp-name">' + esc(p.name) + '</span><span class="sp-meta">' + esc(ROLE_LABEL[p.role]) + ' · ' +
    esc(count(p.titles, 'titre', 'titres')) + (p.minutes ? ' · ' + esc(fmtDuration(p.minutes)) : '') + '</span></li>').join('');
  return panel(tr('Acteurs et réalisateurs les plus vus'), '<ol class="stats-people">' + items + '</ol>', true);
}

function footnote(s) {
  const t = s.totals;
  const parts = [tr('Calcul sur {detailed} titre{v} sur {titles} avec leur fiche TMDB.', { detailed: t.detailed, v: (t.detailed > 1 ? 's' : ''), titles: t.titles })];
  if (t.detailed < t.titles) parts.push(tr('Les autres comptent avec une durée estimée (médiane des titres détaillés) ; les séries non détaillées comptent en cours.'));
  parts.push(tr('Une série est terminée quand tous ses épisodes sont vus.'));
  return '<p class="stats-foot">' + esc(parts.join(' ')) + '</p>';
}

// Les changements de « vu » et les relectures du compte mettent la page à jour sans la recharger.
onDataEvent((e) => {
  if ((e.kind === 'watched' || e.kind === 'remote') && state.kind === 'stats' && detailEl.querySelector('#stats-body')) void refresh();
});
