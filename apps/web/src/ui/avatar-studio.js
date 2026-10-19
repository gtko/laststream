/*
 * Studio d'avatars : overlay plein écran pour choisir un avatar par collections (Pokémon, Disney…). Navigation : accueil
 * (« Pour toi ») → famille (rail) → collection (« Tout voir ») → recherche (2 caractères et plus). Desktop, et mobile sous
 * 720 px (CSS). Variante enfant : seulement les collections `kid`, en sections. Données : data/avatar-catalog.ts ; vignettes :
 * avatar-art.js. L'ancien sélecteur DiceBear / Héros reste dans « Illustrés » > « Générés » (avatar-picker.js).
 */
import {
  avatarImageUrl, groupCollections, isKidAllowed, kidCollections, loadCatalog, loadCollection, normalizeText,
  pushRecentAvatar, recentAvatars, searchCatalog, searchCharacters, suggestFromWatching, watchingTitles,
} from '../data/avatar-catalog';
import { formatColAvatar, isValidAvatar, parseAvatar, parseColAvatar, parseHero } from '../data/avatars';
import { avatarAttrs, hydrateAvatars } from './avatar-art.js';
import { avatarPicker, avatarPickerHTML } from './avatar-picker.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

/** Fonds proposés pour la couleur du profil (pastilles de l'aperçu). */
const BACKGROUNDS = [['#ffd9cf', 'Corail clair'], ['#d6e4ff', 'Bleu clair'], ['#d9f2ea', 'Menthe'], ['#fff1c2', 'Jaune'], ['#e8dcff', 'Lavande'], ['#221f2b', 'Sombre']];
const DEFAULT_BG = '#ffd9cf';
const FALLBACK_TILE_BG = '#94a3b8';
const PAGE = 60;
const ROW_MAX = 8;
const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;
/** Famille des illustrés : elle héberge aussi les avatars générés (DiceBear, Héros). */
const FREE = 'free';
const UNAVAILABLE = "Les collections d'avatars ne sont pas disponibles pour le moment.";
const SEARCH_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
const EMPTY_CAT = { version: '', families: [], collections: [], featured: [] };

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const cap = (s) => s.replace(/-/g, ' ').replace(/^\p{L}/u, (c) => c.toUpperCase());
const initialOf = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

/** Nom affiché avant (ou sans) le chargement du fichier de la collection. */
function fallbackName(value) {
  if (!value) return 'Initiale';
  const col = parseColAvatar(value);
  if (col) return cap(col.charId);
  const hero = parseHero(value);
  if (hero) return cap(hero.seed);
  const gen = parseAvatar(value);
  return gen ? cap(gen.seed) : 'Avatar';
}

/** Nom et sous-titre d'un avatar, sans réseau. */
export function describeAvatarSync(value) {
  if (!value) return { name: 'Initiale', sub: 'Sur la couleur du profil' };
  if (parseColAvatar(value)) return { name: fallbackName(value), sub: '' };
  return { name: fallbackName(value), sub: parseHero(value) ? 'Héros' : 'Avatar généré' };
}

/** Nom du personnage et de sa collection (fichier de la collection chargé au besoin ; repli sans réseau). */
export async function describeAvatar(value) {
  const col = parseColAvatar(value);
  if (!col) return describeAvatarSync(value);
  try {
    const [cat, data] = await Promise.all([loadCatalog(), loadCollection(col.colId)]);
    const c = cat.collections.find((x) => x.id === col.colId);
    const ch = data.characters.find((x) => x.id === col.charId);
    return { name: ch ? ch.name : fallbackName(value), sub: c ? (c.style ? c.name + ' · ' + c.style : c.name) : '' };
  } catch {
    return describeAvatarSync(value);
  }
}

/** Studio ouvert (un seul à la fois). */
let active = null;

/** Ferme le studio s'il est ouvert, sans appeler onCancel. */
export function closeAvatarStudio() {
  if (active) active.close(true);
}

/**
 * Ouvre le studio d'avatars en overlay plein écran.
 * `profile` : { id, name } (ou l'identifiant seul) ; `kid` : variante profil enfant ; `current` : avatar actuel ;
 * `color` : couleur de fond actuelle. `onPick(value, color)` : value = `col:…`, DiceBear, Héros ou null (initiale).
 * `onCancel()` : fermeture sans choix (Annuler, ×, retour, Échap).
 */
export function openAvatarStudio(opts = {}) {
  closeAvatarStudio();
  const profile = typeof opts.profile === 'string' ? { id: opts.profile } : (opts.profile || {});
  const kid = opts.kid === true;
  const onPick = opts.onPick || (() => {});
  const onCancel = opts.onCancel || (() => {});
  const profileId = profile.id || '';
  const profileName = profile.name || '';
  const st = {
    status: 'loading', // loading | ready | error
    cat: null,
    scope: null, // catalogue visible (variante enfant : collections kid seulement)
    groups: [],
    watch: [],
    booting: null,
    names: new Map(),
    sel: isValidAvatar(opts.current) ? opts.current : null,
    bg: typeof opts.color === 'string' && opts.color !== '' ? opts.color : DEFAULT_BG,
    view: { kind: 'home' },
    stack: [],
    sub: 'col',
    query: '',
    shown: PAGE,
    colData: null,
    search: null,
    searchToken: 0,
    timer: 0,
  };
  const prevFocus = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  let closed = false;

  const overlay = document.createElement('div');
  overlay.className = 'as-overlay';
  overlay.innerHTML = '<div class="as-app' + (kid ? ' is-kid' : '') + '" role="dialog" aria-modal="true" aria-labelledby="as-title">' +
    '<header class="as-top">' +
    '<button type="button" class="as-round" data-as-back aria-label="Retour">' + ICON.back + '</button>' +
    '<h2 class="as-title" id="as-title">Choisir un avatar</h2>' +
    '<label class="as-search">' + SEARCH_ICON + '<input type="search" name="assearch" autocomplete="off" placeholder="Rechercher un personnage, une série, un jeu…" aria-label="Rechercher un avatar"></label>' +
    '<span class="as-count" data-as-count></span>' +
    '<button type="button" class="as-round as-close" data-as-close aria-label="Fermer">' + ICON.close + '</button>' +
    '</header>' +
    '<p class="as-banner" data-as-banner' + (kid ? '' : ' hidden') + '>Profil enfant : seulement les collections pour les enfants</p>' +
    '<div class="as-body">' +
    '<nav class="as-rail" aria-label="Familles" data-as-rail></nav>' +
    '<main class="as-main">' +
    '<section class="as-preview" data-as-preview aria-label="Aperçu"></section>' +
    '<div class="as-content" data-as-content></div>' +
    '</main>' +
    '</div>' +
    '</div>';
  const input = overlay.querySelector('input[name="assearch"]');
  const rail = overlay.querySelector('[data-as-rail]');
  const content = overlay.querySelector('[data-as-content]');
  const preview = overlay.querySelector('[data-as-preview]');
  const count = overlay.querySelector('[data-as-count]');

  const isKidOk = (value) => !kid || isKidAllowed(st.cat || EMPTY_CAT, value);
  const nameOf = (value) => st.names.get(value) || fallbackName(value);
  const recentList = () => (profileId ? recentAvatars(profileId) : []).filter(isKidOk);

  function familyLabel(id) {
    if (id === 'all') return 'Pour toi';
    if (id === FREE) return st.cat?.families.find((f) => f.id === FREE)?.label || 'Illustrés';
    return st.cat?.families.find((f) => f.id === id)?.label || id;
  }

  function activeFamily() {
    const v = st.view;
    if (v.kind === 'home') return 'all';
    if (v.kind === 'family') return v.fam;
    if (v.kind === 'collection') return st.cat?.collections.find((c) => c.id === v.colId)?.family ?? '';
    return '';
  }

  function subOf(value) {
    if (!value) return 'Sur la couleur du profil';
    const col = parseColAvatar(value);
    if (!col) return parseHero(value) ? 'Héros' : 'Avatar généré';
    const c = st.cat?.collections.find((x) => x.id === col.colId);
    return c ? (c.style ? c.name + ' · ' + c.style : c.name) : 'Collection';
  }

  // ---------- Vignettes et rangées ----------

  const tileHTML = (value, name) => '<button type="button" class="as-tile" data-as-pick="' + esc(value) + '" aria-pressed="' + (value === st.sel) + '" aria-label="' + esc(name) + '">' +
    '<span class="as-ring"><span class="as-art"' + avatarAttrs(value, FALLBACK_TILE_BG) + '></span></span>' +
    '<span class="as-tile-name">' + esc(name) + '</span></button>';

  const rowHTML = (title, sub, values) => {
    if (!values.length) return '';
    return '<section class="as-row"><div class="as-row-head"><h2 class="as-h2" tabindex="-1">' + esc(title) + '</h2>' +
      (sub ? '<span class="as-sub">' + esc(sub) + '</span>' : '') + '</div>' +
      '<div class="as-row-items">' + values.map((v) => tileHTML(v, nameOf(v))).join('') + '</div></section>';
  };

  const mosaicHTML = (col) => '<span class="as-mosaic">' + [0, 1, 2, 3].map((i) => {
    const ch = col.previews[i];
    const url = ch ? avatarImageUrl(col.id, ch) : '';
    return url ? '<img src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' : '<span class="as-cell"></span>';
  }).join('') + '</span>';

  const countLabel = (n) => (n ? fmt(n) + ' personnages' : '');

  /** Carte d'une collection (ou d'un univers : le premier style ouvre la collection). */
  const cardHTML = (name, col) => '<button type="button" class="as-card" data-as-col="' + esc(col.id) + '" aria-label="' + esc(name + (col.total ? ', ' + fmt(col.total) + ' personnages' : '')) + '">' +
    mosaicHTML(col) + '<span class="as-card-name">' + esc(name) + '</span><span class="as-card-n">' + esc(countLabel(col.total)) + '</span></button>';

  const cardsSectionHTML = (title, sub, groups) => '<section class="as-section"><div class="as-row-head"><h2 class="as-h2" tabindex="-1">' + esc(title) + '</h2>' +
    '<span class="as-sub">' + esc(sub) + '</span></div>' +
    (groups.length ? '<div class="as-cards">' + groups.map((g) => cardHTML(g.name, g.styles[0])).join('') + '</div>' : '<p class="as-empty">Aucune collection à afficher.</p>') + '</section>';

  /** Variante enfant : une section par collection, tuiles en 3 colonnes. */
  function kidSectionsHTML(groups) {
    if (!groups.length) return '<p class="as-empty">Aucune collection pour les enfants pour le moment.</p>';
    return groups.map((g) => {
      const first = g.styles[0];
      const values = first.previews.slice(0, 6).map((ch) => formatColAvatar(first.id, ch));
      return '<section class="as-kid-sec"><div class="as-row-head"><h2 class="as-h2" tabindex="-1">' + esc(g.name) + '</h2>' +
        '<button type="button" class="as-link" data-as-col="' + esc(first.id) + '">Tout voir</button></div>' +
        '<div class="as-grid as-grid-kid">' + values.map((v) => tileHTML(v, nameOf(v))).join('') + '</div></section>';
    }).join('');
  }

  /** Une tuile par collection à tour de rôle (aperçus), sans doublon : la rangée d'une famille. */
  function interleave(cols) {
    const out = [];
    for (let i = 0; i < ROW_MAX && out.length < ROW_MAX; i += 1) {
      for (const c of cols) {
        const ch = c.previews[i];
        if (ch && out.length < ROW_MAX) out.push(formatColAvatar(c.id, ch));
      }
    }
    return out;
  }

  // ---------- Vues ----------

  function homeHTML() {
    if (kid) return kidSectionsHTML(st.groups);
    const watchSub = [...new Set(st.watch.map((r) => st.cat.collections.find((c) => c.id === r.colId)?.name).filter(Boolean))].slice(0, 3).join(', ');
    const featured = (st.cat.featured || []).filter((v) => {
      const c = parseColAvatar(v);
      return c && st.scope.collections.some((x) => x.id === c.colId);
    });
    return rowHTML("D'après ce que tu regardes", watchSub ? watchSub + '…' : '', st.watch.slice(0, ROW_MAX).map((r) => formatColAvatar(r.colId, r.charId))) +
      rowHTML('Les plus choisis', 'Sur tous les profils Laststream', featured.slice(0, ROW_MAX)) +
      cardsSectionHTML('Toutes les collections', 'Ouvre une collection pour voir tous ses personnages', st.groups);
  }

  function initialHTML() {
    return '<section class="as-initial"><span class="as-initial-art" style="background:' + esc(st.bg) + '">' + esc(initialOf(profileName)) + '</span>' +
      '<div class="as-initial-text"><h2 class="as-h2" tabindex="-1">Initiale et couleur</h2>' +
      '<p>Le profil affiche son initiale sur la couleur choisie. Choisis la couleur du fond ci-dessous, puis « Utiliser l\'initiale ».</p>' +
      '<div><button type="button" class="as-btn as-btn-primary" data-as-use-initial>Utiliser l\'initiale</button></div></div></section>';
  }

  /** « Illustrés » : collections illustrées, et l'ancien sélecteur DiceBear / Héros sous « Générés ». */
  function freeHTML() {
    const tabs = '<div class="as-subtabs" role="group" aria-label="Type d\'illustrés">' +
      '<button type="button" class="as-chip" data-as-sub="col" aria-pressed="' + (st.sub === 'col') + '">Collections</button>' +
      '<button type="button" class="as-chip" data-as-sub="gen" aria-pressed="' + (st.sub === 'gen') + '">Générés</button></div>';
    if (st.sub === 'gen') return tabs + '<div class="as-gen" data-as-gen></div>';
    const groups = st.groups.filter((g) => g.family === FREE);
    return tabs + (groups.length ? cardsSectionHTML(familyLabel(FREE), 'Ouvre une collection pour voir tous ses personnages', groups)
      : '<p class="as-empty">Pas encore de collection illustrée. Les avatars générés sont dans l\'onglet « Générés ».</p>');
  }

  function familyHTML(fam) {
    if (fam === 'recent') {
      const list = recentList();
      return list.length ? rowHTML('Récents', 'Tes derniers choix sur ce profil', list)
        : '<p class="as-empty">Pas encore de choix récent sur ce profil.</p>';
    }
    if (fam === 'initial') return initialHTML();
    if (fam === FREE) return freeHTML();
    const groups = st.groups.filter((g) => g.family === fam);
    if (kid) return kidSectionsHTML(groups);
    return rowHTML(familyLabel(fam), 'Personnages populaires', interleave(groups.map((g) => g.styles[0]))) +
      cardsSectionHTML('Collections · ' + familyLabel(fam), 'Ouvre une collection pour voir tous ses personnages', groups);
  }

  function collectionHTML(colId) {
    const col = st.cat.collections.find((c) => c.id === colId);
    const group = st.groups.find((g) => g.styles.some((s) => s.id === colId));
    const styles = group ? group.styles : [];
    const name = col ? col.name : colId;
    const famId = col && col.family ? col.family : 'all';
    const crumbs = '<nav class="as-crumbs" aria-label="Fil d\'Ariane">' +
      '<button type="button" class="as-link" data-as-fam="' + esc(famId) + '">' + esc(familyLabel(famId)) + '</button>' +
      '<span aria-hidden="true">›</span><h2 class="as-h2 as-crumb-h" tabindex="-1">' + esc(name) + '</h2></nav>';
    const chips = styles.length > 1 ? '<div class="as-chips" role="group" aria-label="Style">' + styles.map((s) =>
      '<button type="button" class="as-chip" data-as-style="' + esc(s.id) + '" aria-pressed="' + (s.id === colId) + '">' + esc(s.style || s.name) + '</button>').join('') + '</div>' : '';
    return crumbs + chips + '<div class="as-grid" data-as-grid></div><button type="button" class="as-more" data-as-more hidden>Voir plus</button>';
  }

  function searchHTML() {
    const q = st.query.trim();
    const head = '<h2 class="as-h2" tabindex="-1">Résultats pour « ' + esc(q) + ' »</h2>';
    const r = st.search;
    if (!r) return head + '<p class="as-empty">Recherche…</p>';
    if (r.error) return head + '<p class="as-empty">' + esc(UNAVAILABLE) + '</p>';
    if (!r.cols.length && !r.chars.length) return head + '<p class="as-empty">Aucun résultat.</p>';
    let html = head;
    if (r.cols.length) {
      html += '<section class="as-section"><h3 class="as-h3">Collections</h3><div class="as-cards">' + r.cols.map((c) =>
        cardHTML(c.style ? c.name + ' · ' + c.style : c.name, c)).join('') + '</div></section>';
    }
    if (r.chars.length) {
      html += '<section class="as-section"><h3 class="as-h3">Personnages</h3><div class="as-grid">' + r.chars.map((h) =>
        tileHTML(formatColAvatar(h.colId, h.charId), h.name)).join('') + '</div></section>';
    }
    return html;
  }

  function renderHeader() {
    const v = st.view;
    const col = v.kind === 'collection' && st.cat ? st.cat.collections.find((c) => c.id === v.colId) : null;
    input.placeholder = col ? 'Chercher dans ' + col.name + (col.total ? ' (' + fmt(col.total) + ')' : '') : 'Rechercher un personnage, une série, un jeu…';
    input.setAttribute('aria-label', col ? 'Chercher dans la collection' : 'Rechercher un avatar');
    count.textContent = st.scope ? st.scope.collections.length + ' collections' : '';
  }

  function renderRail() {
    const items = [];
    if (st.status !== 'error') items.push({ id: 'all', label: 'Pour toi', count: 0 });
    const recents = recentList().length;
    items.push({ id: 'recent', label: 'Récents', count: recents });
    if (st.cat) {
      for (const f of st.cat.families) {
        if (f.id === FREE || f.id === 'initial') continue;
        const n = st.scope.collections.filter((c) => c.family === f.id).length;
        if (n) items.push({ id: f.id, label: f.label, count: n });
      }
    }
    items.push({ id: FREE, label: familyLabel(FREE), count: 0 });
    items.push({ id: 'initial', label: 'Initiale et couleur', count: 0 });
    const current = activeFamily();
    rail.innerHTML = items.map((it) => '<button type="button" class="as-rail-item" data-as-fam="' + esc(it.id) + '" aria-pressed="' + (it.id === current) + '">' +
      '<span>' + esc(it.label) + '</span>' + (it.count ? '<span class="as-rail-n">' + it.count + '</span>' : '') + '</button>').join('');
  }

  /** Pastilles « Fond » : les 6 pastels, plus la couleur courante si elle n'en fait pas partie (sélectionnée). */
  function swatches() {
    const list = BACKGROUNDS.map(([c, l]) => [c, l]);
    if (!BACKGROUNDS.some(([c]) => c.toLowerCase() === st.bg.toLowerCase())) list.push([st.bg, 'Couleur du profil']);
    return list;
  }

  function renderPreview() {
    const v = st.sel;
    const init = initialOf(profileName);
    preview.innerHTML = '<div class="as-prev-main"><span class="as-prev-art as-art"' + avatarAttrs(v, st.bg) + '>' + (v ? '' : esc(init)) + '</span>' +
      '<div class="as-prev-text"><span class="as-prev-name" data-as-prev-name>' + esc(v ? nameOf(v) : 'Initiale') + '</span>' +
      '<span class="as-prev-sub">' + esc(subOf(v)) + '</span></div></div>' +
      '<div class="as-bgs" role="group" aria-label="Couleur du fond">' + swatches().map(([c, l]) =>
        '<button type="button" class="as-swatch" data-as-bg="' + c + '" aria-label="Fond : ' + esc(l) + '" aria-pressed="' + (c.toLowerCase() === st.bg.toLowerCase()) + '" style="background:' + c + '"></button>').join('') + '</div>' +
      '<div class="as-prev-actions"><button type="button" class="as-btn" data-as-cancel>Annuler</button>' +
      '<button type="button" class="as-btn as-btn-primary" data-as-use>' + (kid ? "C'est moi !" : 'Utiliser cet avatar') + '</button></div>';
    hydrateAvatars(preview);
  }

  function renderGrid() {
    const grid = content.querySelector('[data-as-grid]');
    if (!grid || st.view.kind !== 'collection') return;
    const more = content.querySelector('[data-as-more]');
    const colId = st.view.colId;
    const d = st.colData;
    if (!d || d.colId !== colId || d.status === 'loading') {
      grid.innerHTML = Array.from({ length: 40 }, () => '<span class="as-skel"></span>').join('');
      if (more) more.hidden = true;
      return;
    }
    if (d.status === 'error') {
      grid.innerHTML = '<p class="as-empty">Cette collection n\'est pas disponible pour le moment.</p>';
      if (more) more.hidden = true;
      return;
    }
    const q = normalizeText(st.query);
    const list = q ? d.chars.filter((ch) => normalizeText(ch.name).includes(q)) : d.chars;
    if (!list.length) {
      grid.innerHTML = '<p class="as-empty">Aucun personnage ne correspond à « ' + esc(st.query.trim()) + ' ».</p>';
      if (more) more.hidden = true;
      return;
    }
    grid.innerHTML = list.slice(0, st.shown).map((ch) => tileHTML(formatColAvatar(colId, ch.id), ch.name)).join('');
    if (more) more.hidden = list.length <= st.shown;
    hydrateAvatars(grid);
  }

  function loadColData(colId) {
    st.colData = { colId, status: 'loading', chars: [] };
    const current = () => st.view.kind === 'collection' && st.view.colId === colId && st.colData?.colId === colId;
    loadCollection(colId).then((data) => {
      if (!current()) return;
      st.colData = { colId, status: 'ready', chars: data.characters };
      for (const ch of data.characters) st.names.set(formatColAvatar(colId, ch.id), ch.name);
      renderGrid();
    }).catch(() => {
      if (!current()) return;
      st.colData = { colId, status: 'error', chars: [] };
      renderGrid();
    });
  }

  /** Remplit le sélecteur DiceBear / Héros (onglet « Générés ») ; son choix alimente l'aperçu. */
  function mountGenerated() {
    const node = content.querySelector('[data-as-gen]');
    if (!node) return;
    node.innerHTML = avatarPickerHTML();
    avatarPicker(node, { avatar: st.sel, isKid: kid }, (value) => choose(value ?? null));
  }

  function renderContent() {
    if (closed) return;
    if (st.status === 'loading') {
      content.innerHTML = '<p class="as-empty">Chargement des avatars…</p>';
      return;
    }
    const v = st.view;
    const notice = st.status === 'error' ? '<p class="as-notice" role="status">' + esc(UNAVAILABLE) + '</p>' : '';
    let html;
    if (v.kind === 'home') html = homeHTML();
    else if (v.kind === 'family') html = familyHTML(v.fam);
    else if (v.kind === 'collection') html = collectionHTML(v.colId);
    else html = searchHTML();
    content.innerHTML = notice + html;
    if (v.kind === 'family' && v.fam === FREE && st.sub === 'gen') mountGenerated();
    if (v.kind === 'collection') {
      if (!st.colData || st.colData.colId !== v.colId) loadColData(v.colId);
      else renderGrid();
    }
    hydrateAvatars(content);
  }

  function renderAll() {
    renderRail();
    renderHeader();
    renderContent();
    renderPreview();
  }

  function focusContent() {
    const h = content.querySelector('h2');
    if (h) h.focus();
  }

  const sameView = (a, b) => a.kind === b.kind && a.fam === b.fam && a.colId === b.colId;

  /** Change de vue ; `push` garde la vue précédente pour « Retour ». */
  function setView(view, { push = true, focus = true, keepQuery = false } = {}) {
    if (push && !sameView(st.view, view)) st.stack.push(st.view);
    st.view = view;
    st.shown = PAGE;
    st.searchToken += 1;
    clearTimeout(st.timer);
    if (!keepQuery) st.query = '';
    if (input.value !== st.query) input.value = st.query;
    renderAll();
    if (focus) focusContent();
  }

  function back() {
    const prev = st.stack.pop();
    if (!prev) {
      if (st.view.kind !== 'home' && st.status !== 'error') setView({ kind: 'home' }, { push: false });
      else close(false);
      return;
    }
    if (prev.kind === 'search') st.query = prev.q;
    setView(prev, { push: false, keepQuery: true });
    if (prev.kind === 'search' && !st.search) void runSearch();
  }

  function openFamily(fam) {
    if (fam === 'all') { setView({ kind: 'home' }); return; }
    setView({ kind: 'family', fam });
  }

  function choose(value) {
    st.sel = value;
    renderPreview();
    overlay.querySelectorAll('[data-as-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.asPick === value)));
  }

  function use() {
    const sel = st.sel;
    const bg = st.bg;
    if (sel && profileId) pushRecentAvatar(profileId, sel);
    close(true);
    onPick(sel, bg);
  }

  /**
   * Recherche globale. Chaque lancement prend un numéro (`searchToken`) : un résultat qui arrive après une nouvelle frappe
   * ou un changement de vue est jeté.
   */
  async function runSearch() {
    const raw = st.query;
    if (st.view.kind !== 'search' || normalizeText(raw).length < MIN_QUERY) return;
    const tok = ++st.searchToken;
    st.search = null;
    renderContent();
    await st.booting;
    if (tok !== st.searchToken || st.view.kind !== 'search') return;
    if (!st.cat) {
      st.search = { error: true };
      renderContent();
      return;
    }
    const cols = searchCatalog(st.scope, raw, { limit: 30 });
    const chars = await searchCharacters(st.scope, raw, 60).catch(() => []);
    if (tok !== st.searchToken || st.view.kind !== 'search') return;
    st.search = { cols, chars };
    renderContent();
  }

  /** Saisie dans la recherche : filtre la collection ouverte, ou lance une recherche globale (2 caractères et plus). */
  function onQuery(raw) {
    st.query = raw;
    const v = st.view;
    if (v.kind === 'collection') {
      st.shown = PAGE;
      renderGrid();
      return;
    }
    if (normalizeText(raw).length >= MIN_QUERY) {
      st.search = null; // chaque frappe repart d'un état « recherche en cours »
      if (v.kind === 'search') {
        v.q = raw;
        renderContent();
      } else {
        setView({ kind: 'search', q: raw }, { keepQuery: true, focus: false });
      }
      clearTimeout(st.timer);
      st.timer = setTimeout(() => { void runSearch(); }, DEBOUNCE_MS);
      return;
    }
    if (v.kind === 'search') {
      clearTimeout(st.timer);
      st.searchToken += 1;
      let prev = st.stack.pop() || { kind: 'home' };
      while (prev.kind === 'search') prev = st.stack.pop() || { kind: 'home' };
      setView(prev, { push: false, keepQuery: true, focus: false });
    }
  }

  // ---------- Fermeture, clavier, événements ----------

  function close(silent) {
    if (closed) return;
    closed = true;
    clearTimeout(st.timer);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.style.overflow = prevOverflow;
    if (active === handle) active = null;
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    if (!silent) onCancel();
  }

  /** Échap ferme ; Tab reste dans le studio (focus piégé). */
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...overlay.querySelectorAll('button, input, a[href]')].filter((el) => !el.disabled && !el.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || !overlay.contains(a))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (a === last || !overlay.contains(a))) {
      e.preventDefault();
      first.focus();
    }
  }

  overlay.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-as-close]')) { close(false); return; }
    if (t.closest('[data-as-back]')) { back(); return; }
    if (t.closest('[data-as-cancel]')) { close(false); return; }
    if (t.closest('[data-as-use-initial]')) { const bg = st.bg; close(true); onPick(null, bg); return; }
    if (t.closest('[data-as-use]')) { use(); return; }
    if (t.closest('[data-as-more]')) { st.shown += PAGE; renderGrid(); return; }
    const fam = t.closest('[data-as-fam]');
    if (fam) { openFamily(fam.dataset.asFam); return; }
    const col = t.closest('[data-as-col]');
    if (col) { setView({ kind: 'collection', colId: col.dataset.asCol }); return; }
    const style = t.closest('[data-as-style]');
    if (style) { setView({ kind: 'collection', colId: style.dataset.asStyle }, { push: false }); return; }
    const pick = t.closest('[data-as-pick]');
    if (pick) { choose(pick.dataset.asPick); return; }
    const bg = t.closest('[data-as-bg]');
    if (bg) { st.bg = bg.dataset.asBg; renderPreview(); return; }
    const sub = t.closest('[data-as-sub]');
    if (sub) { st.sub = sub.dataset.asSub; renderContent(); }
  });

  overlay.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.name === 'assearch') onQuery(e.target.value);
  });

  const handle = { close: (silent) => close(silent) };
  active = handle;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey, true);
  renderAll();
  overlay.querySelector('[data-as-back]')?.focus();

  st.booting = (async () => {
    try {
      const [cat, titles] = await Promise.all([loadCatalog(), watchingTitles().catch(() => [])]);
      st.cat = cat;
      st.scope = kid ? { ...cat, collections: kidCollections(cat) } : cat;
      st.groups = groupCollections(st.scope);
      st.watch = kid ? [] : suggestFromWatching(cat, titles).filter((r) => st.scope.collections.some((c) => c.id === r.colId));
      // Variante enfant : l'avatar courant n'est gardé que s'il est autorisé ; sinon l'aperçu repasse à l'initiale.
      if (kid && st.sel && !isKidAllowed(cat, st.sel)) st.sel = null;
      st.status = 'ready';
    } catch {
      st.status = 'error';
      st.scope = { ...EMPTY_CAT };
      st.groups = [];
      st.view = { kind: 'family', fam: FREE };
      st.sub = 'gen';
    }
    if (!closed) renderAll();
  })();

  return handle;
}
