/* Port du prototype (voir tools/port-prototype.mjs). */
import { filterAvailable } from './avail.js';
import { isReleasedItem } from './dates.js';
import { continueCardHTML, continueSig, hydrateContinue, isSeriesEnded } from './continue.js';
import { renderFollowRow } from './calendar.js';
import { starsText } from './rate.js';
import { RECS_COUNT, HOME_ROW_COUNT, compactItems, excludeList, rawOf, readRecs, saveRecs, todayLocal } from '../data/recs';
import { HERO_MAX, heroCarousel, initHero, prepareSingle, stopHero } from './hero.js';
import { loadKidsHome, viewKids } from './kids.js';
import { startRegistry, stopRegistry } from './registry.js';
import { canAdmin, isKidProfile, isServerMode, refreshRemote } from '../data/auth';
import { isConfigured, subscribe } from '../data/config';
import { onDataEvent } from '../data/events';
import { recommend, tmdb, top10 } from '../data/lt';
import { userStore } from '../data/userStore';
import { keepVisible, onHomeChange } from '../data/homeFilters';
import { isPlayerOpen } from '../player/sessionLoader.js';
import { fillRow, ROW_PAGES_MAX, TOP_COUNT } from '../data/rows';
import { getDetail, listOf, register, toItem } from './catalog.js';
import { TABS } from './constants.js';
import { downloadsTabBadgeHTML } from './downloadBtn.js';
import { addDays, isFuture, todayStr } from './dates.js';
import { app } from './dom.js';
import { brand, row, section } from './fragments.js';
import { ICON } from './icons.js';
import { renderLibrary } from './library.js';
import { keepRowState } from './rows.js';
import { cancelDwell, setupPreviews, stopPreview } from './preview.js';
import { creditsLinkHTML } from './credits.js';
import { renderFeatured, renderHomeCollections } from './collections.js';
import { renderServices } from './services.js';
import { mainNavHTML, syncTopbar, topActionsHTML } from './topnav.js';
import { socialAvailable } from './socialButton.js';
import { getState as socialState } from '../data/socialStore';
import { state } from './state.js';
import { observeTiles, posterCard, topCard, upCard } from './tiles.js';
import { renderTvRows } from './shows.js';
import { renderLive } from './tv.js';
import { cut, esc } from './util.js';

/**
 * Complète une liste visible (`first`) avec les pages suivantes de `path` jusqu'à `want` titres retenus par `ok`.
 * Au plus ROW_PAGES_MAX pages : une liste dont les titres sont déjà vus reste courte plutôt que de charger sans fin.
 */
async function visibleMore(first, path, want, ok = () => true) {
  const out = [...first];
  const have = new Set(out.map((it) => it.key));
  for (let page = 2; page <= ROW_PAGES_MAX && out.length < want; page++) {
    const raw = ((listOf(await tmdb(path, { page }).catch(() => null)) || [])).filter((it) => isReleasedItem(it) && ok(it) && !have.has(it.key));
    if (!raw.length) break;
    raw.forEach((it) => have.add(it.key));
    keepVisible(await filterAvailable(raw)).forEach((it) => out.push(it));
  }
  return out.slice(0, want);
}

/** Données de l'accueil filtrées au moment du rendu (un titre vu ou masqué depuis le chargement disparaît). */
function visibleHome(d) {
  if (d.kids) return { ...d, hero: d.hero ? (keepVisible([d.hero])[0] ?? null) : null };
  const rowOf = (list) => (list == null ? list : keepVisible(list)); // null = rangée non chargée : on le garde
  return { ...d, heroes: keepVisible(d.heroes), rows: { ...d.rows, start: rowOf(d.rows.start), top: rowOf(d.rows.top) } };
}

export async function loadHome() {
  const settled = await Promise.allSettled([
    top10('all', 1, 'day'), // Top 10 aujourd'hui : films et séries disponibles, filtrés par lastAddon
    tmdb('trending/all/week'),
    tmdb('trending/movie/week'),
    tmdb('trending/tv/week'),
    top10('movie'), // Top 10 de la semaine (films, séries) : rangs des tuiles
    top10('tv'),
  ]);
  const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  // Top 10 aujourd'hui : titres vus ou masqués retirés (keepVisible), puis pages suivantes du serveur pour rester à 10.
  const dayRow = await fillRow(
    async (page) => {
      const json = page === 1 ? val(0) : await top10('all', page, 'day').catch(() => null);
      return json ? { title: '', raw: typeof json.raw === 'number' ? json.raw : 0, items: listOf(json) || [] } : null;
    },
    TOP_COUNT,
    async (fresh) => keepVisible(fresh),
  );
  const day = dayRow ? dayRow.items : [];
  // « Pour bien commencer » : tendances de la semaine, filtrées comme avant (disponibilité des films récents).
  const week = keepVisible(await filterAvailable((listOf(val(1)) || []).filter(isReleasedItem)));
  if ([0, 1, 2, 3].every((i) => settled[i].status === 'rejected')) throw new Error('catalogue indisponible');

  // Mise en avant : les tendances de la semaine ayant un fond (rang d'origine conservé pour le badge).
  const films = keepVisible((await filterAvailable((listOf(val(2), 'movie') || []).filter(isReleasedItem))).map((it, i) => Object.assign(it, { heroRank: i + 1, heroKind: 'Film' })));
  const series = keepVisible((listOf(val(3), 'tv') || []).filter(isReleasedItem).map((it, i) => Object.assign(it, { heroRank: i + 1, heroKind: 'Série' })));
  const heroes = [];
  const taken = new Set();
  for (let i = 0; i < Math.max(films.length, series.length) && heroes.length < HERO_MAX; i++) {
    [films[i], series[i]].forEach((it) => {
      if (it && it.backdropPath && !taken.has(it.key) && heroes.length < HERO_MAX) { taken.add(it.key); heroes.push(it); }
    });
  }
  if (!heroes.length) (week || []).map((it, i) => Object.assign(it, { heroRank: i + 1 })).filter((it) => it.backdropPath).slice(0, HERO_MAX).forEach((it) => heroes.push(it));
  await Promise.all(heroes.slice(0, 2).map(getDetail)); // le reste arrive pendant l'affichage (initHero)
  const hero = heroes[0] || null;

  // Rangs des listes serveur : le Top 10 du jour sert à l'accueil (state.top10) ; les badges des tuiles (state.topBadge)
  // reprennent d'abord la semaine (films, puis séries), puis le jour pour les autres titres.
  const ranked = (items) => (items || []).slice(0, TOP_COUNT).map((it, i) => [it.key, i + 1]);
  state.top10 = new Map(ranked(day));
  state.topBadge = new Map();
  [...ranked(listOf(val(4), 'movie')), ...ranked(listOf(val(5), 'tv')), ...ranked(day)].forEach(([key, rank]) => {
    if (!state.topBadge.has(key)) state.topBadge.set(key, rank);
  });
  const all = [...heroes, ...(day || []), ...(week || [])];
  all.forEach(register);
  return {
    hero,
    heroes,
    rows: {
      start: week ? await visibleMore(week.filter((it) => it.poster), 'trending/all/week', 20, (it) => !!it.poster) : null, // « Pour bien commencer » : tendances, sans IA
      top: cut(day, 10),
    },
  };
}

/** Remplit state.ai depuis une liste compacte (tous les titres ; la rangée d'accueil en montre une partie). */
/** « Parce que tu as noté X ★★★★★ » quand la raison de l'IA cite un titre que tu as noté. */
function ratedReason(text) {
  const hit = userStore.getRatings().find((r) => r.title && r.title.length > 2 && text.toLowerCase().includes(r.title.toLowerCase()));
  return hit ? 'Parce que tu as noté ' + hit.title + ' ' + starsText(hit.rating) : text;
}

function useRecs(recs) {
  const year = new Date().getFullYear();
  const items = recs.items.filter((r) => !r.y || Number(r.y) <= year).map((r) => {
    const c = register(toItem(rawOf(r)));
    c.reason = ratedReason(r.r); // affichée seulement dans l'aperçu au survol
    return c;
  });
  state.ai = { status: 'ready', items, date: recs.date };
}

/**
 * Recommandations : une seule liste par jour. Réutilisée tant que la date n'a pas changé (aucun appel IA,
 * même si la bibliothèque ou les notes bougent) ; sinon un seul appel à /lt/recommend avec 50 titres.
 */
export async function loadAI() {
  if (state.ai.status === 'loading' || state.ai.status === 'ready') return;
  if (isKidProfile()) { state.ai = { status: 'none', items: [] }; renderAI(); return; } // pas d'IA sur un profil enfant
  state.ai = { status: 'loading', items: [] };
  renderAI();
  let stored = null;
  try {
    stored = await readRecs();
    if (stored && stored.date === todayLocal() && stored.items.length) {
      useRecs(stored);
      renderAI();
      return;
    }
    const seed = recoSeed();
    if (!seed) {
      // Aucun signal (ni bibliothèque ni progression) : pas d'appel IA.
      state.ai = { status: 'none', items: [] };
      renderAI();
      return;
    }
    const json = await recommend(seed.history, seed.liked, { count: RECS_COUNT, exclude: excludeList(), ratings: seed.ratings });
    const fresh = { date: todayLocal(), items: compactItems(json.items || []) };
    if (!fresh.items.length) throw new Error('liste vide');
    await saveRecs(fresh);
    useRecs(fresh);
  } catch (_) {
    // Échec : la dernière liste connue (même ancienne) vaut mieux qu'une rangée vide.
    if (stored && stored.items.length) useRecs(stored);
    else state.ai = { status: 'error', items: [] };
  }
  renderAI();
}

export async function load() {
  state.status = 'loading';
  renderHome();
  try {
    state.data = isKidProfile() ? await loadKidsHome() : await loadHome();
    state.status = 'ready';
  } catch (err) {
    console.error('[laststream] catalogue indisponible');
    state.status = 'error';
  }
  renderHome();
  if (state.status === 'ready') loadAI();
}

// Réglages enregistrés (adresse et configuration) : un accueil resté en erreur « non configuré » recharge le catalogue
// tout de suite, sans attendre un rechargement de la page.
subscribe(() => { if (state.status === 'error' && isConfigured()) void load(); });
// ---------- Rangée « Prochainement » ----------
export async function loadUpcoming() {
  if (state.upcoming) return state.upcoming;
  const today = todayStr();
  const tomorrow = addDays(today, 1);
  const [mu, md, td, ota] = await Promise.allSettled([
    tmdb('movie/upcoming'),
    tmdb('discover/movie', { 'primary_release_date.gte': tomorrow, sort_by: 'popularity.desc' }),
    tmdb('discover/tv', { 'first_air_date.gte': tomorrow, sort_by: 'popularity.desc' }),
    tmdb('tv/on_the_air'),
  ]);
  const val = (r) => (r.status === 'fulfilled' && r.value && r.value.results ? r.value.results : []);
  const out = new Map();
  const add = (raw, type, date, label) => {
    if (!raw.poster_path || !date || !isFuture(date)) return;
    const c = register(toItem(raw, type));
    if (out.has(c.key)) return;
    c.upDate = date;
    c.upLabel = label || '';
    out.set(c.key, c);
  };
  val(mu).concat(val(md)).forEach((r) => add(r, 'movie', r.release_date));
  val(td).forEach((r) => add(r, 'tv', r.first_air_date));
  // Nouvelles saisons : séries en cours dont le prochain épisode est le 1er d'une saison à venir.
  const airing = val(ota).filter((r) => r.poster_path).slice(0, 12);
  const details = await Promise.allSettled(airing.map((r) => tmdb('tv/' + r.id)));
  details.forEach((d, i) => {
    if (d.status !== 'fulfilled') return;
    const n = d.value.next_episode_to_air;
    if (n && n.episode_number === 1 && n.season_number >= 2) add(airing[i], 'tv', n.air_date, 'Saison ' + n.season_number);
  });
  state.upcoming = Array.from(out.values()).sort((a, b) => String(a.upDate).localeCompare(String(b.upDate))).slice(0, 20);
  return state.upcoming;
}

export async function renderUpcoming() {
  try {
    const list = keepVisible(await loadUpcoming());
    const slot = document.getElementById('up-slot');
    if (!slot || !list.length || state.status !== 'ready') return;
    slot.innerHTML = '<section class="row-section" id="prochainement" aria-labelledby="h-prochainement"><h2 class="row-title" id="h-prochainement">Prochainement</h2>' +
      row(list.map(upCard).join('')) + '</section>';
    observeTiles(slot);
  } catch (_) { /* rangée absente */ }
}


// ---------- Recommandations IA ----------
export function aiSkeleton() {
  return '<section class="row-section" aria-busy="true"><h2 class="row-title">Recommandé pour toi par l’IA</h2>' +
    '<div class="row">' + '<span class="sk sk-card"></span>'.repeat(5) + '</div></section>';
}

export function renderAI() {
  const slot = document.getElementById('ai-slot');
  if (!slot) return;
  const ai = state.ai;
  if (ai.status === 'none') {
    const start = state.data && keepVisible(state.data.rows.start);
    slot.innerHTML = start && start.length
      ? section('commencer', 'Pour bien commencer', start, (l) => row(l.map((it) => posterCard(it)).join('')))
      : '';
    observeTiles(slot);
    return;
  }
  const items = ai.status === 'ready' ? keepVisible(ai.items) : [];
  if (ai.status === 'error' || (ai.status === 'ready' && !items.length)) {
    slot.innerHTML = '';
    return;
  }
  if (ai.status !== 'ready') {
    slot.innerHTML = aiSkeleton();
    return;
  }
  slot.innerHTML = '<section class="row-section" id="ai" aria-labelledby="h-ai"><h2 class="row-title" id="h-ai">Recommandé pour toi par l’IA ' +
    '<a class="row-link" href="#/browse/ai" data-browse="ai">Tout voir</a></h2>' +
    row(items.slice(0, HOME_ROW_COUNT).map((it) => posterCard(it)).join('')) + '</section>';
}

/** Amis et Ensemble : compte connecté seulement, jamais sur un profil enfant (voir socialButton.js). */
export const socialEnabled = socialAvailable;

// ---------- Accueil (style A · Cinéma) ----------
/** Barre du haut : logo (accueil), Séries, Films, Direct, Émissions TV, Documentaires, menu Explorer ; Ensemble (compte connecté) ; à droite recherche, Amis, profil. */
export function headerA() {
  return '<header class="topbar">' + brand() +
    '<nav class="nav" aria-label="Principale">' + mainNavHTML({ social: socialEnabled() }) + '</nav>' +
    topActionsHTML({ kid: isKidProfile(), social: socialEnabled(), server: isServerMode(), owner: canAdmin() }) + '</header>';
}

export function viewA(d) {
  const r = d.rows;
  return '<main id="main" class="page-a">' + headerA() + heroCarousel(d.heroes) +
    '<div class="rows">' +
    '<div id="cont-slot">' + continueSection() + '</div>' +
    '<div id="follow-slot"></div>' +
    '<div id="ai-slot"></div>' +
    section('top10', 'Top 10 aujourd’hui', r.top, (l) => row(l.map((it, i) => topCard(it, i + 1)).join(''))) +
    '<div id="feat-slot"></div>' +
    '<div id="up-slot"></div>' +
    '<div id="live-slot"></div>' +
    '<div id="tonight-slot"></div>' +
    '<div id="shows-slot"></div>' +
    '<div id="reg-slot"></div>' +
    '<div id="svc-slot"></div>' +
    '<div id="col-slot"></div>' +
    '<div id="lib-slot"></div>' +
    '</div></main>';
}

/**
 * Barre du bas (mobile). `current` : onglet de la page affichée ('home' par défaut, 'ensemble' sur la page Ensemble).
 * Compte connecté (hors profil enfant) : Accueil, Rechercher, Ensemble, Ma liste, Téléchargés. L'onglet Ensemble porte la pastille
 * des notifications sociales du store (demandes d'amis reçues + messages non lus, invitations de watch party comprises) ; l'accès aux Amis
 * passe par le bouton « Amis » de la page Ensemble. Sans compte connecté : onglets d'origine.
 */
export function tabbar(current = 'home') {
  if (socialEnabled()) {
    const n = socialState().badge;
    const tab = (cls, attrs, icon, label, extra = '') =>
      '<' + (attrs.href ? 'a' : 'button type="button"') + ' class="tab' + cls + '"' + attrs.html + '>' + ICON[icon] + '<span class="tab-label">' + label + '</span>' + extra +
      '</' + (attrs.href ? 'a' : 'button') + '>';
    const badge = '<span class="soc-badge tab-badge" data-ens-badge' + (n > 0 ? '' : ' hidden') + '>' + (n > 99 ? '99+' : n) + '</span>';
    const here = (id) => (current === id ? ' is-current' : '');
    const curAttr = (id) => (current === id ? ' aria-current="page"' : '');
    return '<nav class="tabbar" aria-label="Navigation principale">' +
      tab(here('home'), { href: true, html: ' href="#/" data-noop' + curAttr('home') }, 'home', 'Accueil') +
      tab('', { html: ' data-search aria-label="Rechercher"' }, 'search', 'Rechercher') +
      tab(here('ensemble'), { href: true, html: ' href="#/ensemble" data-go' + curAttr('ensemble') }, 'users', 'Ensemble', badge) +
      tab('', { href: true, html: ' href="#/library" data-libnav' }, 'list', 'Ma liste') +
      tab('', { href: true, html: ' href="#/downloads" data-go data-dl-nav' }, 'download', 'Téléchargés', downloadsTabBadgeHTML()) + '</nav>';
  }
  const items = TABS.map(([label, icon, current]) =>
    '<a href="' + tabHref(label) + '"' + tabData(label) + ' class="tab' + (current ? ' is-current' : '') + '"' + (current ? ' aria-current="page"' : '') + '>' +
    (icon ? ICON[icon] : '<span class="avatar avatar-tab" aria-hidden="true">' + esc(initialOf()) + '</span>') +
    '<span class="tab-label">' + label + '</span></a>').join('');
  return '<nav class="tabbar" aria-label="Navigation principale">' + items + '</nav>';
}

export const footer = () =>
  '<footer class="foot"><p>Données films et séries : TMDb. Ce produit utilise l’API TMDb mais n’est ni approuvé ni certifié par TMDb. ' +
  'Notes : MDBList. Recommandations : OpenRouter. ' + creditsLinkHTML() + '</p></footer>';

export function skeletonView() {
  const cards = '<div class="row">' + '<span class="sk sk-card"></span>'.repeat(6) + '</div>';
  return '<main id="main" class="sk-page"><p class="sr-only" role="status">Chargement du catalogue…</p>' +
    '<div class="sk sk-hero"></div><div class="rows"><div class="sk sk-line"></div>' + cards +
    '<div class="sk sk-line short"></div>' + cards + '</div></main>';
}

export function errorView() {
  return '<main id="main" class="state-page">' + brand() +
    '<div class="state" role="alert"><p>' + (isConfigured()
      ? 'Impossible de charger le catalogue. Vérifie la connexion à lastAddon, puis réessaie.'
      : 'lastAddon n’est pas configuré. Renseigne son adresse dans les réglages.') + '</p>' +
    '<button type="button" class="btn btn-primary" data-retry>Réessayer</button>' +
    '<button type="button" class="btn btn-ghost" data-settings>Réglages</button></div></main>';
}

export function renderHome() {
  stopHero();
  stopRegistry();
  stopPreview();
  cancelDwell();
  app.setAttribute('aria-busy', String(state.status === 'loading'));
  if (state.status === 'loading') {
    app.innerHTML = skeletonView();
    return;
  }
  if (state.status === 'error') {
    app.innerHTML = errorView();
    return;
  }
  const d = visibleHome(state.data);
  homeStale = false;
  startHomeLive();
  app.innerHTML = (d.kids ? viewKids(d) : viewA(d)) + footer() + tabbar();
  syncTopbar();
  hydrateContinue(document.getElementById('cont-slot'));
  void refreshHome(true); // ouverture de l'accueil : la rangée reflète le compte sans attendre le prochain tour (60 s)
  renderAI();
  renderUpcoming();
  if (!state.data.kids) renderFeatured();
  renderLive();
  if (!state.data.kids) { renderFollowRow(); renderTvRows(); }
  observeTiles(app);
  setupPreviews();
  if (state.data.kids) {
    prepareSingle(d.hero); // mise en avant simple (profil enfant) : détail à l'affichage, notes MDBList au survol
    renderLibrary();
    startRegistry({ seen: d.hero ? [d.hero.key] : [] });
  } else {
    initHero(d.heroes);
    // Services de streaming puis Ma bibliothèque terminent la page, une fois les rangées chargées.
    startRegistry({ seen: d.heroes.map((x) => x.key), onDone: () => { renderHomeCollections().then((ok) => { if (!ok && state.status === 'ready') renderServices(); }); renderLibrary(); } });
  }
}
export const initialOf = () => (userStore.currentProfile().name || '?').slice(0, 1).toUpperCase();
const statsTab = (label) => label === 'Stats' && !isKidProfile();
export const tabHref = (label) => (label === 'Bibliothèque' ? '#/library' : label === 'Amis' ? '#/friends' : label === 'Profil' ? '#/settings' : label === 'Découvrir' && !isKidProfile() ? '#/discover' : statsTab(label) ? '#/stats' : '#/');
export const tabData = (label) => (label === 'Bibliothèque' ? ' data-libnav' : label === 'Amis' ? ' data-go' : label === 'Profil' ? ' data-settings' : label === 'Découvrir' && !isKidProfile() ? ' data-go' : statsTab(label) ? ' data-go' : ' data-noop');

/**
 * Signaux envoyés à /recommend : bibliothèque et titres entamés, du plus récent au plus ancien.
 * Null s'il n'y en a aucun : la rangée « Pour bien commencer » remplace alors l'IA.
 */
export function recoSeed() {
  const seen = new Set();
  const history = [];
  const add = (e) => {
    const k = e.type + ':' + e.id;
    if (!e.title || seen.has(k)) return;
    seen.add(k);
    history.push({ title: e.title, year: Number(e.year) || null, type: e.type });
  };
  userStore.continueWatching(10).forEach(add);
  userStore.getLibrary().sort((a, b) => b.addedAt - a.addedAt).forEach(add);
  userStore.getRatings().forEach((r) => add({ ...r, type: r.type }));
  if (!history.length) return null;
  const ratings = userStore.getRatings().slice(0, 100).map((r) => ({ title: r.title, year: Number(r.year) || null, type: r.type, rating: r.rating })).filter((r) => r.title);
  return { history: history.slice(0, 10), liked: history.slice(0, 3), ratings };
}

/**
 * « Reprendre la lecture » : la progression réelle, sans les titres vus, masqués ou aux genres bannis (même filtre que
 * le reste de l'accueil) ni les séries dont la carte a été retirée. Rien tant qu'il n'y en a pas.
 */
function continueList() {
  return keepVisible(userStore.continueWatching()).filter((p) => !isSeriesEnded(p));
}

export function continueSection() {
  const real = continueList();
  if (!real.length) return '';
  return section('reprendre', 'Reprendre la lecture', real, (l) => row(l.map(continueCardHTML).join('')));
}

const cardOf = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.firstElementChild;
};

/**
 * Rafraîchit « Reprendre la lecture » sans rechargement : les cartes inchangées sont gardées (image, logo, focus), les
 * autres sont refaites, et l'ordre (récent d'abord) suit la progression. Sans effet si rien n'a changé.
 */
export function renderContinue() {
  const slot = document.getElementById('cont-slot');
  if (!slot) return;
  const list = continueList();
  if (!list.length) { slot.innerHTML = ''; return; }
  const rowEl = slot.querySelector('.row');
  if (!rowEl) {
    slot.innerHTML = continueSection();
    observeTiles(slot);
    hydrateContinue(slot);
    return;
  }
  const have = new Map(Array.from(rowEl.querySelectorAll('.cont-card')).map((c) => [c.dataset.resume, c]));
  const nodes = list.map((p) => {
    const old = have.get(p.key);
    return old && old.dataset.sig === continueSig(p) ? old : cardOf(continueCardHTML(p));
  });
  const cur = Array.from(rowEl.children);
  if (nodes.length === cur.length && nodes.every((n, i) => n === cur[i])) return;
  keepRowState(slot, () => rowEl.replaceChildren(...nodes), 'data-resume');
  observeTiles(slot);
  hydrateContinue(slot);
}

// ---------- Mise à jour à chaud (sans rechargement) ----------
/** Vrai quand l'accueil est affiché : ni fiche ni page de compte par-dessus. */
const homeOnScreen = () => !!document.getElementById('cont-slot') && !app.hidden && !state.inDetail;
/** Des changements attendent la fermeture du lecteur : il recouvre l'accueil et rend le focus à sa carte d'origine. */
let homeStale = false;

/** Redessine les rangées qui dépendent des données de l'utilisateur ; sans effet si rien n'a changé. */
function syncHomeData() {
  if (!homeOnScreen()) return;
  if (isPlayerOpen()) { homeStale = true; return; }
  homeStale = false;
  renderContinue();
  renderLibrary();
}

onDataEvent((e) => {
  // Lecteur fermé : la progression vient d'être écrite, l'accueil la relit aussitôt (sans attendre le prochain tour).
  if (e.kind === 'player') { if (homeStale) syncHomeData(); void refreshHome(true); return; }
  syncHomeData();
});
onHomeChange(syncHomeData);

/** Intervalle de resynchronisation avec le compte quand l'accueil est visible. */
const REMOTE_EVERY_MS = 60_000;
let remoteAt = 0;
let remoteBusy = false;
let remoteAgain = false;

/**
 * Relit le compte (changements faits sur un autre appareil ou profil, progression du lecteur natif). Une relecture à la fois ;
 * sans `force`, 5 s au moins entre deux. Une demande forcée pendant une relecture en lance une seule de plus, à la suite.
 */
async function refreshHome(force = false) {
  if (document.hidden || !homeOnScreen()) return;
  if (remoteBusy) { if (force) remoteAgain = true; return; }
  if (!force && Date.now() - remoteAt < 5000) return;
  remoteAt = Date.now();
  remoteBusy = true;
  try {
    await refreshRemote();
  } catch (_) {
    // Hors ligne : l'accueil garde ce qu'il affiche.
  } finally {
    remoteBusy = false;
    if (remoteAgain) { remoteAgain = false; void refreshHome(true); }
  }
}

let liveTimer = 0;
/** Écouteurs de retour dans l'app, groupés sous un AbortController : défaits en quittant l'accueil (stopHomeLive). */
let liveAc = null;

function attachLive() {
  liveAc = new AbortController();
  const { signal } = liveAc;
  // Retour dans l'app : l'accueil relit le compte aussitôt. Capacitor émet « resume » sur le document quand la WebView reprend
  // (p. ex. après le lecteur natif Android) ; « visibilitychange » et « focus » couvrent le navigateur et la coque Windows.
  document.addEventListener('resume', () => { void refreshHome(true); }, { signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshHome(); }, { signal });
  window.addEventListener('focus', () => { void refreshHome(); }, { signal });
}
attachLive();

/** Accueil affiché : resynchronisation toutes les ~60 s et retour dans l'app. Idempotent (renderHome, retour de la fiche). */
export function startHomeLive() {
  if (!liveAc) attachLive();
  if (!liveTimer) liveTimer = setInterval(() => { void refreshHome(); }, REMOTE_EVERY_MS);
}

/** Accueil quitté (fiche, page de compte, lecteur) : arrête la resynchronisation et retire les écouteurs. */
export function stopHomeLive() {
  clearInterval(liveTimer);
  liveTimer = 0;
  liveAc?.abort();
  liveAc = null;
}
