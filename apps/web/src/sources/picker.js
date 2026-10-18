/* Sélecteur de sources détaillé : tiroir du prototype (qualité, audio, langues, taille, débit, copies, fichier),
 * filtres, tri, regroupement par résolution, source recommandée en tête. Navigable au clavier et à la télécommande. */
import { measureBandwidthKbps, QUALITY_LABEL } from '../data/sources';
import { modalBody } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';
import { esc } from '../ui/util.js';
import { countByGroup, filtersActive, groupViews, NO_FILTERS, SORT_KEYS, SORT_LABELS, applyFilters, sortViews } from './rank';
import { knownBandwidthKbps, loadSources, recommendFor } from './load';

const RES_CHIPS = [['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['SD', 'SD']];
const LANG_CHIPS = [['fr', 'VF'], ['vo', 'VO'], ['multi', 'Multi']];

let session = null;
/** Éléments hôtes (panneau du lecteur) déjà équipés de leurs écouteurs. */
const bound = new WeakSet();

const chipHtml = (kind, value, label, on, count) =>
  '<button type="button" class="s-chip' + (on ? ' is-on' : '') + '" data-nav data-row="f-' + kind + '" data-chip="' + kind + ':' + value + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
  esc(label) + (count != null ? '<em>' + count + '</em>' : '') + '</button>';

function truncName(name) {
  if (name.length <= 56) return name;
  return name.slice(0, 40) + '…' + name.slice(-14);
}

function itemHtml(v, opts) {
  const l1 = ['<span class="q q-' + v.group + '">' + esc(v.quality) + '</span>'];
  if (v.sourceType) l1.push('<span class="s-type">' + esc(v.sourceType) + '</span>');
  v.hdr.forEach((c) => l1.push('<span class="s-hdr s-hdr-' + c.replace('+', 'p') + '">' + esc(c) + '</span>'));
  if (v.codec) l1.push('<span class="s-codec">' + esc(v.codec) + '</span>');
  const st = '<span class="s-status st-' + v.status + '">' + esc(v.statusLabel) + '</span>';
  const web = v.web === 'direct' ? '<span class="s-web s-web-direct" title="Se lit dans le navigateur sans conversion">Lecture directe</span>'
    : v.web === 'convert' ? '<span class="s-web s-web-convert" title="Le serveur de streaming convertit le flux (HEVC, DTS, REMUX…)">Conversion</span>' : '';

  const langs = v.langs.map((b) => '<span class="s-lang' + (b.verified ? ' is-verified' : '') + '" title="' + (b.verified ? 'Langue vérifiée dans le fichier' : 'Langue annoncée par le nom de la release') + '">' + esc(b.label) + (b.verified ? ' ✓' : '') + '</span>').join('');
  const l2 = (v.audio ? '<span class="s-audio">' + esc(v.audio) + '</span>' : '') + langs;

  const l3 = [];
  if (v.sizeLabel) l3.push(esc(v.sizeLabel));
  if (v.bitrateLabel) l3.push(esc(v.bitrateLabel));
  if (v.durationLabel) l3.push('≈ ' + esc(v.durationLabel));
  if (v.seeders != null) l3.push(v.seeders + ' seeders' + (v.peers != null ? ' / ' + v.peers + ' peers' : ''));
  if (v.copies > 1) l3.push(v.copies + ' copies');
  if (v.trackers.length) l3.push('<span class="s-trk" title="' + esc(v.trackers.join(', ')) + '">' + esc(v.trackers.slice(0, 3).join(', ')) + (v.trackers.length > 3 ? ' +' + (v.trackers.length - 3) : '') + '</span>');

  const l4 = v.filename
    ? '<code class="s-file" title="' + esc(v.filename) + '">' + esc(truncName(v.filename)) + '</code>' + (v.releaseGroup ? '<span class="s-grp">' + esc(v.releaseGroup) + '</span>' : '')
    : v.releaseGroup ? '<span class="s-grp">' + esc(v.releaseGroup) + '</span>' : '';

  const warn = v.notWebReady ? '<span class="s-warn">Transcodage probable</span>' : '';
  const cls = 'src2' + (opts.rec ? ' is-rec' : '') + (opts.current ? ' is-current' : '');
  return '<li><button type="button" class="' + cls + '" data-nav data-row="i-' + v.index + '" data-src="' + v.index + '"' + (v.playable ? '' : ' disabled') + '>' +
    (opts.rec ? '<span class="s-rec"><b>Recommandé</b><span class="s-why">' + esc(opts.reason) + '</span></span>' : '') +
    (opts.current ? '<span class="s-cur">En cours de lecture</span>' : '') +
    '<span class="s-l1">' + l1.join('') + web + st + warn + '</span>' +
    (l2 ? '<span class="s-l2">' + l2 + '</span>' : '') +
    (l3.length ? '<span class="s-l3">' + l3.join('<i aria-hidden="true">·</i>') + '</span>' : '') +
    (l4 ? '<span class="s-l4">' + l4 + '</span>' : '') +
    (v.playable ? '' : '<span class="s-l4">Aucun lien lisible.</span>') + '</button></li>';
}

function render() {
  const s = session;
  if (!s) return;
  const { views, filters, sort } = s;
  const counts = countByGroup(views);
  const shown = applyFilters(views, filters);
  const rec = s.rec && shown.some((v) => v.index === s.rec.view.index) ? s.rec : null;
  const ordered = sortViews(shown, sort, rec ? rec.view.index : null);
  const rest = rec ? ordered.filter((v) => v.index !== rec.view.index) : ordered;
  const label = s.request.name + (s.request.season != null ? ' · S' + s.request.season + ' É' + s.request.episode : '');

  const toolbar =
    '<div class="s-bar" role="group" aria-label="Filtres">' +
      '<div class="s-chips" data-label="Résolution">' + RES_CHIPS.filter(([k]) => counts[k]).map(([k, l]) => chipHtml('res', k, l, filters.resolutions.has(k), counts[k])).join('') + '</div>' +
      '<div class="s-chips" data-label="Langue">' + LANG_CHIPS.map(([k, l]) => chipHtml('lang', k, l, filters.langs.has(k))).join('') + '</div>' +
      '<div class="s-chips" data-label="Affichage">' + chipHtml('cache', 'on', 'Cache uniquement ⚡', filters.cachedOnly) + chipHtml('hdr', 'on', 'HDR', filters.hdrOnly) +
        (filtersActive(filters) ? '<button type="button" class="s-chip s-reset" data-nav data-row="f-reset" data-chip="reset:1">Réinitialiser</button>' : '') + '</div>' +
      '<div class="s-chips" data-label="Trier par">' + SORT_KEYS.map((k) => chipHtml('sort', k, SORT_LABELS[k], sort === k)).join('') + '</div>' +
    '</div>';

  let body = '';
  if (rec) body += '<ul class="src-list s-rec-list">' + itemHtml(rec.view, { rec: true, reason: rec.reason, current: s.currentIndex === rec.view.index }) + '</ul>';
  else if (s.bwPending) body += '<p class="s-note">Mesure de ta connexion pour choisir la meilleure source…</p>';
  const groups = groupViews(rest);
  body += groups.map((g) => '<h3 class="src-group">' + esc(QUALITY_LABEL[g.key]) + ' <span>' + g.views.length + '</span></h3><ul class="src-list">' +
    g.views.map((v) => itemHtml(v, { current: s.currentIndex === v.index })).join('') + '</ul>').join('');
  if (!shown.length) body += '<p class="drawer-text">Aucune source ne correspond à ces filtres.</p>';

  const host = s.host;
  const focusKey = document.activeElement && host.contains(document.activeElement) ? (document.activeElement.dataset.chip || document.activeElement.dataset.src) : null;
  const scroller = host === modalBody ? modalBody.closest('.modal') : host;
  const top = scroller ? scroller.scrollTop : 0;
  host.innerHTML = '<div class="drawer s-drawer">' + (host === modalBody ? '<h2 id="modal-title" class="drawer-title">Sources</h2>' : '') +
    '<p class="drawer-text"><strong>' + esc(label) + '</strong> · ' + views.length + ' source' + (views.length > 1 ? 's' : '') + (shown.length !== views.length ? ' (' + shown.length + ' affichées)' : '') + '</p>' +
    toolbar + body + '</div>';
  if (scroller) scroller.scrollTop = top;
  if (focusKey) {
    const again = host.querySelector('[data-chip="' + focusKey + '"], [data-src="' + focusKey + '"]');
    if (again) again.focus({ preventScroll: true });
  }
}

function showMessage(msg) {
  const host = session ? session.host : modalBody;
  host.innerHTML = '<div class="drawer">' + (host === modalBody ? '<h2 id="modal-title" class="drawer-title">Sources</h2>' : '') + '<p class="drawer-text">' + esc(msg) + '</p></div>';
}

/**
 * Ouvre le sélecteur. `opts.onPick(view)` est appelé au choix d'une source ; `opts.views` évite de recharger (changement de
 * source en cours de lecture) ; `opts.currentIndex` marque la source en cours.
 */
export async function openSourcePicker(request, opener, opts) {
  const token = Symbol('picker');
  const host = opts.host || modalBody;
  session = { token, host, request, views: opts.views || [], filters: { ...NO_FILTERS, resolutions: new Set(), langs: new Set() }, sort: 'recommended', rec: null, currentIndex: opts.currentIndex ?? null, onPick: opts.onPick, bw: null, bwPending: false };
  const skeleton = '<div class="drawer">' + (opts.host ? '' : '<h2 id="modal-title" class="drawer-title">Sources</h2>') + '<ul class="drawer-list" aria-hidden="true"><li class="sk sk-src"></li><li class="sk sk-src"></li><li class="sk sk-src"></li></ul></div>';
  if (opts.host) { host.innerHTML = skeleton; bindHost(host); } else openModal(skeleton, opener, 'is-drawer is-sources');
  const alive = () => session && session.token === token;
  try {
    if (!session.views.length) {
      const loaded = await loadSources(request);
      if (!alive()) return;
      request.imdb = loaded.imdb;
      session.views = loaded.views;
    }
  } catch (e) {
    if (alive()) showMessage(e && e.message === 'no-imdb' ? 'Aucun identifiant IMDb pour ce titre : impossible de chercher des sources.' : 'Les sources n’ont pas pu être chargées. Vérifie que lastAddon répond, puis réessaie.');
    return;
  }
  if (!session.views.length) { showMessage('Aucune source trouvée pour le moment.'); return; }
  const known = knownBandwidthKbps();
  session.bw = known;
  session.bwPending = known === null;
  session.rec = recommendFor(session.views, known);
  render();
  const first = host.querySelector('.is-rec') || host.querySelector('[data-src]:not([disabled])');
  if (first) first.focus({ preventScroll: true });
  if (known === null) {
    const kbps = await measureBandwidthKbps().catch(() => null);
    if (!alive()) return;
    session.bw = kbps;
    session.bwPending = false;
    session.rec = recommendFor(session.views, kbps);
    render();
  }
}

export function closeSourcePicker() {
  const host = session && session.host;
  session = null;
  if (!host || host === modalBody) closeModal(true);
}

function toggleSet(set, v) {
  const n = new Set(set);
  if (n.has(v)) n.delete(v); else n.add(v);
  return n;
}

function onClick(e) {
  const s = session;
  if (!s || !(e.target instanceof Element)) return;
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    e.preventDefault();
    const [kind, value] = chip.dataset.chip.split(':');
    if (kind === 'res') s.filters = { ...s.filters, resolutions: toggleSet(s.filters.resolutions, value) };
    else if (kind === 'lang') s.filters = { ...s.filters, langs: toggleSet(s.filters.langs, value) };
    else if (kind === 'cache') s.filters = { ...s.filters, cachedOnly: !s.filters.cachedOnly };
    else if (kind === 'hdr') s.filters = { ...s.filters, hdrOnly: !s.filters.hdrOnly };
    else if (kind === 'sort') s.sort = value;
    else if (kind === 'reset') s.filters = { ...NO_FILTERS, resolutions: new Set(), langs: new Set() };
    render();
    return;
  }
  const src = e.target.closest('[data-src]');
  if (src && !src.disabled) {
    e.preventDefault();
    const view = s.views.find((v) => v.index === Number(src.dataset.src));
    const cb = s.onPick;
    if (view && cb) { closeSourcePicker(); cb(view, s.views); }
  }
}

// Navigation au clavier / télécommande : gauche-droite dans une rangée de puces, haut-bas entre les rangées et les sources.
function onKeydown(e) {
  if (!session || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const items = Array.from(session.host.querySelectorAll('[data-nav]:not([disabled])'));
  const cur = items.indexOf(document.activeElement);
  if (cur < 0) return;
  const row = items[cur].dataset.row;
  let target = null;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const same = items.filter((x) => x.dataset.row === row);
    const k = same.indexOf(items[cur]) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (same.length > 1 && k >= 0 && k < same.length) target = same[k];
    else if (same.length > 1) target = same[e.key === 'ArrowLeft' ? 0 : same.length - 1];
  } else if (e.key === 'Home') target = items[0];
  else if (e.key === 'End') target = items[items.length - 1];
  else {
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    for (let i = cur + dir; i >= 0 && i < items.length; i += dir) {
      if (items[i].dataset.row !== row) {
        // En remontant vers une rangée de puces, on atterrit sur sa première puce.
        target = dir < 0 ? items.find((x) => x.dataset.row === items[i].dataset.row) : items[i];
        break;
      }
    }
  }
  if (target) { e.preventDefault(); e.stopPropagation(); target.focus(); target.scrollIntoView({ block: 'nearest' }); }
}

function bindHost(host) {
  if (bound.has(host)) return;
  bound.add(host);
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKeydown);
}

bindHost(modalBody);
