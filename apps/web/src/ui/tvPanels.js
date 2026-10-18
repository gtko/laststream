/* Panneaux du lecteur TV, même langage visuel que ceux du lecteur des films : tiroir latéral translucide, titres de section,
 * lignes de 48 px, coche accent. « Audio et sous-titres » (tracksPanel) et « Chaînes » (channelsPanel : recherche, puces,
 * favoris, liste fenêtrée pour des centaines de chaînes, clavier et télécommande). Le DOM est dessiné ici ; les données
 * (chaînes, programmes, favoris, lecture) arrivent par `deps`, ce qui permet de l'essayer hors du lecteur. */
import { centerScroll, chipList, filterChannels, windowRange } from '../data/tvChannelList';
import { ICON } from './icons.js';
import { LI } from '../player/icons.js';
import { tracksModel } from './tvControls.js';
import { esc } from './util.js';

/** Hauteur d'une ligne de la liste des chaînes (px à 15 px de police) : fixe, pour fenêtrer. */
export const ROW_H = 68;

const shellHead = (title, sub, extra) => '<div class="pn-top"><div class="pn-ttl"><h2 id="pn-title">' + esc(title) + '</h2>' +
  (sub ? '<p class="pn-sub">' + esc(sub) + '</p>' : '') + '</div>' + (extra || '') +
  '<button type="button" class="lp-btn pn-x" data-pclose-panel aria-label="Fermer">' + LI.close + '</button></div>';

// ---------- Audio et sous-titres ----------

function optHTML(r, kind) {
  return '<li><button type="button" class="tp-opt' + (r.selected ? ' is-on' : '') + '" role="radio" aria-checked="' + (r.selected ? 'true' : 'false') +
    '" data-pitem="' + kind + '" data-pid="' + esc(r.id) + '" tabindex="' + (r.selected ? '0' : '-1') + '">' +
    '<span class="tp-chk" aria-hidden="true">' + (r.selected ? LI.check : '') + '</span>' +
    '<span class="tp-txt"><span class="tp-lbl">' + esc(r.text) + '</span>' + (r.detail ? '<span class="tp-det">' + esc(r.detail) + '</span>' : '') + '</span></button></li>';
}

function colHTML(id, title, rows, kind, empty) {
  const list = rows.length
    ? '<ul class="tp-list" role="radiogroup" aria-labelledby="tp-h-' + id + '">' + rows.map((r) => optHTML(r, kind)).join('') + '</ul>'
    : '<p class="tp-empty">' + esc(empty) + '</p>';
  return '<section class="tp-col" data-col="' + id + '"><h3 id="tp-h-' + id + '">' + esc(title) + '</h3>' + list + '</section>';
}

/** Contenu du panneau « Audio et sous-titres » : deux colonnes, puis la ligne « Qualité » s'il y a plusieurs niveaux. */
export function tracksHTML(model, channelName) {
  const q = model.quality.length
    ? '<section class="tp-quality" data-col="quality"><h3 id="tp-h-quality">Qualité</h3><div class="tp-chips" role="radiogroup" aria-labelledby="tp-h-quality">' +
      model.quality.map((r) => '<button type="button" class="tp-chip' + (r.selected ? ' is-on' : '') + '" role="radio" aria-checked="' + (r.selected ? 'true' : 'false') +
        '" data-pitem="quality" data-pid="' + esc(r.id) + '" tabindex="' + (r.selected ? '0' : '-1') + '">' + (r.selected ? '<span class="tp-chk" aria-hidden="true">' + LI.check + '</span>' : '') +
        '<span class="tp-lbl">' + esc(r.text) + '</span>' + (r.detail ? '<span class="tp-det">' + esc(r.detail) + '</span>' : '') + '</button>').join('') +
      '</div></section>'
    : '';
  return shellHead('Audio et sous-titres', channelName) + '<div class="pn-body"><div class="tp-cols">' +
    colHTML('audio', 'Audio', model.audio, 'audio', 'Une seule piste audio sur cette chaîne.') +
    colHTML('sub', 'Sous-titres', model.subs, 'sub', 'Aucun sous-titre sur cette chaîne.') + '</div>' + q + '</div>';
}

/**
 * Dessine le panneau « Audio et sous-titres » dans `el` d'après les pistes lues ({audio, subs, levels} : options
 * `{id, label, selected}`). Conserve le focus sur l'entrée choisie quand le panneau est redessiné.
 */
export function renderTracksPanel(el, { audio, subs, levels, channelName }) {
  const focusedId = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.pitem + '|' + document.activeElement.dataset.pid : '';
  const model = tracksModel(audio, subs, levels);
  const html = tracksHTML(model, channelName);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
  if (focusedId) {
    const [kind, id] = focusedId.split('|');
    const again = Array.from(el.querySelectorAll('[data-pitem]')).find((b) => b.dataset.pitem === kind && b.dataset.pid === id);
    if (again && document.activeElement !== again) again.focus({ preventScroll: true });
  }
  return model;
}

/** Donne le focus à la piste choisie de la colonne demandée (`audio`, `sub`, `quality`), sinon à la première entrée. */
export function focusTracks(el, col) {
  const scope = el.querySelector('[data-col="' + (col || 'audio') + '"]') || el;
  const b = scope.querySelector('[aria-checked="true"]') || scope.querySelector('[data-pitem]') || el.querySelector('[data-pitem]');
  if (b) b.focus({ preventScroll: true });
}

/**
 * Clavier du panneau des pistes : haut et bas dans la colonne (puis vers la ligne Qualité), gauche et droite d'une colonne
 * à l'autre au même rang, ou entre niveaux de qualité. Renvoie true si la touche est traitée.
 */
export function tracksKey(el, e) {
  const t = e.target instanceof Element ? e.target.closest('[data-pitem]') : null;
  if (!t || !el.contains(t)) return false;
  const col = t.closest('[data-col]');
  if (!col) return false;
  const items = (c) => (c ? Array.from(c.querySelectorAll('[data-pitem]')) : []);
  const mine = items(col);
  const i = mine.indexOf(t);
  const quality = col.dataset.col === 'quality';
  const go = (b) => { if (b) b.focus(); return true; };
  const sideways = (dir) => {
    const other = dir > 0 ? col.nextElementSibling : col.previousElementSibling;
    const list = other && other.dataset.col ? items(other) : [];
    return go(list.length ? list[Math.min(i, list.length - 1)] : null);
  };
  switch (e.key) {
    case 'ArrowDown':
      if (quality) return true;
      return go(i < mine.length - 1 ? mine[i + 1] : items(el.querySelector('[data-col="quality"]')).find((b) => b.getAttribute('aria-checked') === 'true') || items(el.querySelector('[data-col="quality"]'))[0] || null);
    case 'ArrowUp':
      if (quality) return go(items(el.querySelector('[data-col="audio"]')).pop() || null);
      return go(i > 0 ? mine[i - 1] : null);
    case 'ArrowRight': return quality ? go(mine[Math.min(mine.length - 1, i + 1)]) : sideways(1);
    case 'ArrowLeft': return quality ? go(mine[Math.max(0, i - 1)]) : sideways(-1);
    case 'Home': return go(mine[0]);
    case 'End': return go(mine[mine.length - 1]);
    default: return false;
  }
}

// ---------- Chaînes ----------

const progressOf = (nn, now) => (nn && nn.cur ? Math.max(0, Math.min(100, Math.round(((now - nn.cur.start) / Math.max(1, nn.cur.stop - nn.cur.start)) * 100))) : 0);

/**
 * Monte le panneau « Chaînes » dans `el`. `deps` :
 *  - channels() : chaînes zappables, dans l'ordre ; currentId() : id de la chaîne en cours ;
 *  - favs() : ids favoris ; toggleFav(id) ; logoHTML(c, cls) ; nowNext(c, nowSec) ; ensureEpg(list) -> Promise ;
 *  - onPick(channel) : l'utilisateur choisit une chaîne.
 * Renvoie { focusCurrent, key(e), refresh, dispose }.
 */
export function mountChannelsPanel(el, deps) {
  let chip = 'all';
  let q = '';
  let shown = [];
  let active = 0;
  let alive = true;
  let raf = 0;
  const all = deps.channels();
  const favSet = () => new Set(deps.favs());

  el.dataset.html = '';
  el.innerHTML = shellHead('Chaînes', '', '<span class="cp-count" id="cp-count" aria-live="polite"></span>') +
    '<div class="cp-tools"><label class="cp-search"><span class="sr-only">Rechercher une chaîne</span>' + ICON.search +
    '<input type="search" class="cp-q" placeholder="Chaîne, numéro ou programme" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-controls="cp-list"></label>' +
    '<div class="cp-chips" role="group" aria-label="Catégories"></div></div>' +
    '<div class="cp-list" id="cp-list" role="list" aria-label="Chaînes"><div class="cp-spacer"></div></div>' +
    '<p class="cp-empty" role="status" hidden></p>';
  const input = el.querySelector('.cp-q');
  const chipsEl = el.querySelector('.cp-chips');
  const listEl = el.querySelector('.cp-list');
  const spacer = el.querySelector('.cp-spacer');
  const emptyEl = el.querySelector('.cp-empty');
  const countEl = el.querySelector('#cp-count');

  // La police du panneau grandit sur très grand écran : la hauteur des lignes suit.
  const rowH = () => {
    const fs = parseFloat(getComputedStyle(el).fontSize);
    return Math.round(ROW_H * (fs > 0 ? fs / 15 : 1));
  };

  function drawChips() {
    const favs = favSet();
    const list = chipList(all, favs);
    if (!list.some((k) => k.id === chip)) chip = 'all';
    chipsEl.innerHTML = list.map((k) => '<button type="button" class="cp-chip" data-chip="' + k.id + '" aria-pressed="' + (k.id === chip) + '">' + esc(k.label) +
      (k.id === 'all' || k.id === 'fav' || k.count ? '<span>' + k.count + '</span>' : '') + '</button>').join('');
  }

  function rowHTML(c, i, h, now, favs, curId) {
    const nn = deps.nowNext(c, now);
    const cur = c.id === curId;
    const fav = favs.has(c.id);
    const num = c.num || (c.box && c.box.num) || '';
    const title = nn && nn.cur ? nn.cur.title : '';
    const label = (num ? 'Chaîne ' + num + ', ' : '') + c.name + (title ? ', en cours : ' + title : '') + (cur ? ', chaîne actuelle' : '');
    return '<div class="cp-row' + (cur ? ' is-cur' : '') + (i === active ? ' is-active' : '') + '" role="listitem" aria-setsize="' + shown.length + '" aria-posinset="' + (i + 1) +
      '" style="top:' + i * h + 'px;height:' + h + 'px" data-i="' + i + '">' +
      '<button type="button" class="cp-main" data-pitem="chan" data-pid="' + esc(c.id) + '" data-i="' + i + '" tabindex="' + (i === active ? '0' : '-1') + '"' +
      (cur ? ' aria-current="true"' : '') + ' aria-label="' + esc(label) + '">' +
      deps.logoHTML(c, 'cp-logo') + '<span class="cp-num" aria-hidden="true">' + esc(num) + '</span>' +
      '<span class="cp-t" aria-hidden="true"><span class="cp-name">' + esc(c.name) + (cur ? '<em>En cours</em>' : '') + '</span>' +
      '<span class="cp-prog">' + (title ? esc(title) : '<i>Programme non communiqué</i>') + '</span>' +
      (nn && nn.cur ? '<span class="cp-bar"><i style="width:' + progressOf(nn, now) + '%"></i></span>' : '') + '</span></button>' +
      '<button type="button" class="cp-fav" data-pfav="' + esc(c.id) + '" aria-pressed="' + fav + '" tabindex="-1" aria-label="' + (fav ? 'Retirer des favoris : ' : 'Ajouter aux favoris : ') + esc(c.name) + '">' +
      (fav ? ICON.starOn : ICON.star) + '</button></div>';
  }

  let lastKey = '';
  const asked = new Set();
  function drawRows(force) {
    raf = 0;
    if (!alive) return;
    const h = rowH();
    const { start, end } = windowRange(listEl.scrollTop, listEl.clientHeight, h, shown.length);
    const now = Math.floor(Date.now() / 1000);
    const favs = favSet();
    const curId = deps.currentId();
    const key = [start, end, active, shown.length, curId, Array.from(favs).join(','), Math.floor(now / 30), h].join('|');
    if (!force && key === lastKey) return;
    lastKey = key;
    const hadFocus = listEl.contains(document.activeElement);
    const focusI = hadFocus && document.activeElement.dataset ? document.activeElement.dataset.i : null;
    const focusFav = hadFocus && document.activeElement.matches('.cp-fav') ? document.activeElement.closest('.cp-row').dataset.i : null;
    spacer.style.height = shown.length * h + 'px';
    let html = '';
    for (let i = start; i < end; i += 1) html += rowHTML(shown[i], i, h, now, favs, curId);
    spacer.innerHTML = html;
    if (focusFav != null) {
      const f = spacer.querySelector('.cp-row[data-i="' + focusFav + '"] .cp-fav');
      if (f) f.focus({ preventScroll: true });
    } else if (focusI != null) {
      const f = spacer.querySelector('.cp-main[data-i="' + focusI + '"]');
      if (f) f.focus({ preventScroll: true });
    }
    // Programmes des lignes visibles : demandés une fois par chaîne, la liste est redessinée à leur arrivée.
    const need = shown.slice(start, end).filter((c) => !asked.has(c.id));
    if (need.length) {
      need.forEach((c) => asked.add(c.id));
      Promise.resolve(deps.ensureEpg(need)).then(() => { if (alive) { lastKey = ''; schedule(); } }).catch(() => {});
    }
  }
  const schedule = () => { if (!raf && alive) raf = requestAnimationFrame(() => drawRows(false)); };

  function refresh(keepActive) {
    const favs = favSet();
    shown = filterChannels(all, { chip, q, favs });
    if (!keepActive) active = Math.min(active, Math.max(0, shown.length - 1));
    countEl.textContent = shown.length + (shown.length > 1 ? ' chaînes' : ' chaîne');
    emptyEl.hidden = shown.length > 0;
    if (!shown.length) {
      emptyEl.textContent = chip === 'fav' && !q ? 'Aucun favori pour le moment : touche l’étoile d’une chaîne pour la garder ici.' : 'Aucune chaîne ne correspond' + (q ? ' à « ' + q + ' »' : '') + '.';
    }
    lastKey = '';
    drawRows(true);
  }

  function scrollTo(i, center) {
    const h = rowH();
    const view = listEl.clientHeight;
    if (center) listEl.scrollTop = centerScroll(i, h, view, shown.length);
    else if (i * h < listEl.scrollTop) listEl.scrollTop = i * h;
    else if ((i + 1) * h > listEl.scrollTop + view) listEl.scrollTop = (i + 1) * h - view;
  }

  function focusRow(i, fav) {
    if (!shown.length) return;
    active = Math.max(0, Math.min(shown.length - 1, i));
    scrollTo(active, false);
    lastKey = '';
    drawRows(true);
    const b = spacer.querySelector('.cp-row[data-i="' + active + '"] ' + (fav ? '.cp-fav' : '.cp-main'));
    if (b) b.focus({ preventScroll: true });
  }

  function focusCurrent() {
    const curId = deps.currentId();
    const i = Math.max(0, shown.findIndex((c) => c.id === curId));
    active = i;
    scrollTo(i, true);
    lastKey = '';
    drawRows(true);
    const b = spacer.querySelector('.cp-main[data-i="' + i + '"]');
    if (b) b.focus({ preventScroll: true });
  }

  const onScroll = () => schedule();
  listEl.addEventListener('scroll', onScroll, { passive: true });
  input.addEventListener('input', () => { q = input.value; active = 0; listEl.scrollTop = 0; refresh(true); });
  chipsEl.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-chip]') : null;
    if (!b) return;
    chip = b.dataset.chip;
    active = 0;
    listEl.scrollTop = 0;
    drawChips();
    refresh(true);
  });
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const f = t.closest('[data-pfav]');
    if (f && el.contains(f)) {
      e.preventDefault();
      e.stopPropagation();
      const row = f.closest('.cp-row');
      const idx = row ? Number(row.dataset.i) : active;
      deps.toggleFav(f.dataset.pfav);
      drawChips();
      refresh(true);
      active = Math.min(idx, Math.max(0, shown.length - 1));
      lastKey = '';
      drawRows(true);
      const again = spacer.querySelector('.cp-row[data-i="' + active + '"] .cp-fav') || spacer.querySelector('.cp-row .cp-main');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const m = t.closest('.cp-main');
    if (m && el.contains(m)) {
      e.preventDefault();
      e.stopPropagation();
      const c = shown[Number(m.dataset.i)];
      if (c) deps.onPick(c);
    }
  }, true);

  drawChips();
  refresh(false);

  return {
    focusCurrent,
    refresh: () => { drawChips(); refresh(true); },
    /** Clavier : true = traité ici, false = laissé au navigateur (saisie, activation d'un bouton), null = au lecteur. */
    key(e) {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !el.contains(t)) return null;
      if (t === input) {
        if (e.key === 'Escape') { if (input.value) { input.value = ''; q = ''; refresh(true); return true; } return null; }
        if (e.key === 'ArrowDown') { focusRow(active, false); return true; }
        if (e.key === 'Enter') { if (q && shown[0]) deps.onPick(shown[0]); return true; }
        return false;
      }
      const row = t.closest('.cp-row');
      if (!row) return e.key === 'Escape' ? null : false;
      const i = Number(row.dataset.i);
      const onFav = t.matches('.cp-fav');
      switch (e.key) {
        case 'ArrowDown': focusRow(i + 1, onFav); return true;
        case 'ArrowUp': if (i === 0) { input.focus(); return true; } focusRow(i - 1, onFav); return true;
        case 'PageDown': focusRow(i + 8, onFav); return true;
        case 'PageUp': focusRow(i - 8, onFav); return true;
        case 'Home': focusRow(0, onFav); return true;
        case 'End': focusRow(shown.length - 1, onFav); return true;
        case 'ArrowRight': if (!onFav) { focusRow(i, true); } return true;
        case 'ArrowLeft': if (onFav) { focusRow(i, false); } return true;
        case 'Escape': return null;
        case 'Enter':
        case ' ': return false;
        default: return null;
      }
    },
    dispose() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      listEl.removeEventListener('scroll', onScroll);
    },
    /** Pour les essais : effectif et ids affichés. */
    ids: () => shown.map((c) => c.id),
  };
}

