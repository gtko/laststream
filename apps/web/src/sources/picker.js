/* Sélecteur de sources détaillé : tiroir du prototype (qualité, audio, langues, taille, débit, copies, fichier),
 * filtres, tri, regroupement par résolution, source recommandée en tête. Navigable au clavier et à la télécommande. */
import { measureBandwidthKbps, notYetDigitalText, QUALITY_LABEL } from '../data/sources';
import { modalBody } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';
import { esc } from '../ui/util.js';
import { countByGroup, countOrigins, filtersActive, groupViews, NO_FILTERS, SORT_KEYS, SORT_LABELS, applyFilters, sortViews } from './rank';
import { knownBandwidthKbps, loadSources, recommendFor, watchSources } from './load';
import { bitDepthOf, codecBadges, fitBadge } from './badges';
import { describePending } from './rank';
import { isShellEnvironment } from '../player/shell';

// Apps Windows (mpv) et Android (libVLC) : tous les formats sont lus tels quels, jamais de transcodage.
const nativePlayer = () => isShellEnvironment() || !!globalThis.Capacitor?.isNativePlatform?.();

const RES_CHIPS = [['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['SD', 'SD']];
const LANG_CHIPS = [['fr', 'VF'], ['vo', 'VO'], ['multi', 'Multi']];

let session = null;
/** Éléments hôtes (panneau du lecteur) déjà équipés de leurs écouteurs. */
const bound = new WeakSet();

const chipHtml = (kind, value, label, on, count) =>
  '<button type="button" class="s-chip' + (on ? ' is-on' : '') + '" data-nav data-row="f-' + kind + '" data-chip="' + kind + ':' + value + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
  esc(label) + (count != null ? '<em>' + count + '</em>' : '') + '</button>';

/** Pastille d'origine : logo de l'addon ou icône générique, puis le nom. */
const originIcon = (o) => (o.logo ? '<img class="s-olg" src="' + esc(o.logo) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '<svg class="s-oic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.500v-9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.500" fill="currentColor"/></svg>');
const originChip = (o, on) => '<button type="button" class="s-chip' + (on ? ' is-on' : '') + '" data-nav data-row="f-origin" data-chip="origin:' + esc(o.name) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + originIcon(o) + esc(o.name) + '<em>' + o.count + '</em></button>';

function truncName(name) {
  if (name.length <= 56) return name;
  return name.slice(0, 40) + '…' + name.slice(-14);
}

/** Données des badges d'une carte : libellés du sélecteur, 10-bit détecté dans le nom de la release. */
const badgeInput = (v) => ({ source: v.sourceType, codec: v.codec, hdr: v.hdr, audio: v.audio, channels: v.info ? v.info.channels : undefined, bitDepth: bitDepthOf(v.codec + ' ' + v.filename) });

function itemHtml(v, opts) {
  const badges = badgeInput(v);
  const l1 = ['<span class="q q-' + v.group + '">' + esc(v.quality) + '</span>', codecBadges(badges, 'video')];
  const st = '<span class="s-status st-' + v.status + '">' + esc(v.statusLabel) + '</span>';
  // Pastille d'adéquation : débit de la source contre débit de la connexion (mesuré ou réglé), à chaque rendu.
  const fit = fitBadge(v.bitrateKbps, session ? session.bw : null);
  const web = v.web === 'direct' ? '<span class="s-web s-web-direct" title="Se lit dans le navigateur sans conversion">Lecture directe</span>'
    : v.appAudio === 'app' ? '<span class="s-web s-web-convert" title="Le navigateur ne lit pas ce son (AC-3 / E-AC-3) : l’app le décode elle-même, sans serveur de streaming, si l’hébergeur de la source l’autorise">Son décodé par l’app</span>'
    : v.appAudio === 'unsupported' ? '<span class="s-web s-web-video" title="Son DTS / TrueHD non pris en charge par le navigateur : la vidéo se lira sans son">Sans son (DTS)</span>'
    : v.convert === 'video' ? '<span class="s-web s-web-video" title="Le serveur de streaming réencode la vidéo (codec non pris en charge) : démarrage lent">Conversion vidéo</span>'
    : v.web === 'convert' ? '<span class="s-web s-web-convert" title="La vidéo est copiée, seul l’audio est converti">Conversion audio</span>' : '';

  const langs = v.langs.map((b) => '<span class="s-lang' + (b.verified ? ' is-verified' : '') + '" title="' + (b.verified ? 'Langue vérifiée dans le fichier' : 'Langue annoncée par le nom de la release') + '">' + esc(b.label) + (b.verified ? ' ✓' : '') + '</span>').join('');
  const l2 = codecBadges(badges, 'audio') + langs;

  const l3 = [];
  if (v.sizeLabel) l3.push(esc(v.sizeLabel));
  if (v.bitrateLabel) l3.push(esc(v.bitrateLabel));
  if (v.durationLabel) l3.push('≈ ' + esc(v.durationLabel));
  if (v.seeders != null) l3.push(v.seeders + ' seeders' + (v.peers != null ? ' / ' + v.peers + ' peers' : ''));
  if (v.copies > 1) l3.push(v.copies + ' copies');
  if (v.origins.length) l3.push('<span class="s-orig" title="' + esc(v.origins.map((o) => o.name).join(', ')) + '">' + v.origins.slice(0, 2).map((o) => '<span class="s-o">' + originIcon(o) + esc(o.name) + '</span>').join('') + (v.origins.length > 2 ? '<span class="s-o s-o-more">+' + (v.origins.length - 2) + '</span>' : '') + '</span>');
  if (v.viaDevice) l3.push('<span class="s-dev" title="Trouvée par cet appareil : l’addon refusait le serveur">via ton appareil</span>');

  const l4 = v.filename
    ? '<code class="s-file" title="' + esc(v.filename) + '">' + esc(truncName(v.filename)) + '</code>' + (v.releaseGroup ? '<span class="s-grp">' + esc(v.releaseGroup) + '</span>' : '')
    : v.releaseGroup ? '<span class="s-grp">' + esc(v.releaseGroup) + '</span>' : '';

  const warn = v.notWebReady && !nativePlayer() ? '<span class="s-warn">Transcodage probable</span>' : '';
  const cls = 'src2' + (opts.rec ? ' is-rec' : '') + (opts.current ? ' is-current' : '');
  return '<li><button type="button" class="' + cls + '" data-nav data-row="i-' + v.index + '" data-src="' + v.index + '"' + (v.playable ? '' : ' disabled') + '>' +
    (opts.rec ? '<span class="s-rec"><b>Recommandé</b><span class="s-why">' + esc(opts.reason) + '</span></span>' : '') +
    (opts.current ? '<span class="s-cur">En cours de lecture</span>' : '') +
    '<span class="s-l1">' + l1.join('') + web + st + fit + warn + '</span>' +
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
  const origins = countOrigins(views);
  const shown = applyFilters(views, filters);
  const rec = s.rec && shown.some((v) => v.index === s.rec.view.index) ? s.rec : null;
  const ordered = sortViews(shown, sort, rec ? rec.view.index : null);
  const rest = rec ? ordered.filter((v) => v.index !== rec.view.index) : ordered;
  const label = s.request.name + (s.request.season != null ? ' · S' + s.request.season + ' É' + s.request.episode : '');

  const toolbar =
    '<div class="s-bar" role="group" aria-label="Filtres">' +
      '<div class="s-chips" data-label="Résolution">' + RES_CHIPS.filter(([k]) => counts[k]).map(([k, l]) => chipHtml('res', k, l, filters.resolutions.has(k), counts[k])).join('') + '</div>' +
      '<div class="s-chips" data-label="Langue">' + LANG_CHIPS.map(([k, l]) => chipHtml('lang', k, l, filters.langs.has(k))).join('') + '</div>' +
      (origins.length > 1 ? '<div class="s-chips" data-label="Origine">' + origins.slice(0, 8).map((o) => originChip(o, filters.origins.has(o.name))).join('') + '</div>' : '') +
      '<div class="s-chips" data-label="Affichage">' + chipHtml('cache', 'on', 'Cache uniquement ⚡', filters.cachedOnly) + chipHtml('hdr', 'on', 'HDR', filters.hdrOnly) +
        (filtersActive(filters) ? '<button type="button" class="s-chip s-reset" data-nav data-row="f-reset" data-chip="reset:1">Réinitialiser</button>' : '') + '</div>' +
      (s.bw == null ? '<div class="s-chips" data-label="Connexion">' + measureChip(s) + '</div>' : '') +
      '<div class="s-chips" data-label="Trier par">' + SORT_KEYS.map((k) => chipHtml('sort', k, SORT_LABELS[k], sort === k)).join('') + '</div>' +
    '</div>';

  let body = '';
  // Sources essayées sans succès (lenteur, erreur) : une ligne par source avec la raison.
  if (s.serverNotice) body += '<p class="s-pending" role="status">' + esc(s.serverNotice) + '</p>';
  if (s.notice.length) body += '<div class="s-fail" role="alert"><b>Sources essayées sans succès</b><ul>' + s.notice.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
  // Recherche partielle : indication discrète (la liste se complète seule), puis « +N sources » un instant.
  if (s.pending.length) body += '<p class="s-pending" role="status"><i class="s-spin" aria-hidden="true"></i>' + esc(describePending(s.pending)) + '</p>';
  else if (s.added > 0) body += '<p class="s-pending is-done" role="status">+' + s.added + ' source' + (s.added > 1 ? 's' : '') + ' trouvée' + (s.added > 1 ? 's' : '') + '</p>';
  if (rec) body +='<ul class="src-list s-rec-list">' + itemHtml(rec.view, { rec: true, reason: rec.reason, current: s.currentIndex === rec.view.index }) + '</ul>';
  else if (s.bwPending) body += '<p class="s-note">Mesure de ta connexion pour choisir la meilleure source…</p>';
  const groups = groupViews(rest);
  body += groups.map((g) => '<h3 class="src-group">' + esc(QUALITY_LABEL[g.key]) + ' <span>' + g.views.length + '</span></h3><ul class="src-list">' +
    g.views.map((v) => itemHtml(v, { current: s.currentIndex === v.index })).join('') + '</ul>').join('');
  if (!shown.length && views.length) body += '<p class="drawer-text">Aucune source ne correspond à ces filtres.</p>';

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
  if (session && session.stop) session.stop();
  const token = Symbol('picker');
  const host = opts.host || modalBody;
  session = { token, host, notice: opts.notice || [], pending: opts.pending || [], added: 0, stop: null, request, views: opts.views || [], filters: { ...NO_FILTERS, resolutions: new Set(), langs: new Set() }, sort: 'recommended', rec: null, currentIndex: opts.currentIndex ?? null, onPick: opts.onPick, bw: null, bwPending: false };
  const skeleton = '<div class="drawer">' + (opts.host ? '' : '<h2 id="modal-title" class="drawer-title">Sources</h2>') + '<ul class="drawer-list" aria-hidden="true"><li class="sk sk-src"></li><li class="sk sk-src"></li><li class="sk sk-src"></li></ul></div>';
  if (opts.host) { host.innerHTML = skeleton; bindHost(host); } else openModal(skeleton, opener, 'is-drawer is-sources');
  const alive = () => session && session.token === token;
  // Liste chargée ici : son état complet (repli appareil, sources serveur) guide la surveillance.
  let loadedHere = null;
  try {
    if (!session.views.length) {
      const loaded = await loadSources(request);
      if (!alive()) return;
      loadedHere = loaded;
      request.imdb = loaded.imdb;
      session.views = loaded.views;
      session.pending = loaded.pending;
      session.serverNotice = loaded.notice || '';
      session.notYet = loaded.notYetDigital ? notYetDigitalText(loaded.digitalDate) : '';
    }
  } catch (e) {
    if (alive()) showMessage(e && e.message === 'no-imdb' ? 'Aucun identifiant IMDb pour ce titre : impossible de chercher des sources.' : 'Les sources n’ont pas pu être chargées. Vérifie que lastAddon répond, puis réessaie.');
    return;
  }
  if (!session.views.length && !session.pending.length) { showMessage(session.notYet || session.serverNotice || 'Aucune source trouvée pour le moment.'); return; }
  const known = knownBandwidthKbps();
  // La liste se complète toute seule tant que lastAddon interroge d'autres sources (2 s, 20 s au plus), sans toucher à la lecture.
  if (session.pending.length) {
    let clearAdded = null;
    session.stop = watchSources(request, loadedHere ?? { imdb: opts.imdb || request.imdb || '', views: session.views, pending: session.pending }, (next, added) => {
      if (!alive()) return;
      session.views = next.views;
      session.pending = next.pending;
      session.added = added;
      session.rec = recommendFor(session.views, session.bw);
      render();
      clearTimeout(clearAdded);
      if (!next.pending.length) clearAdded = setTimeout(() => { if (alive()) { session.added = 0; render(); } }, 4000);
    });
  }
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

/** Bouton de la barre : débit inconnu (pastilles « Débit inconnu »). Désactivé pendant la mesure. */
function measureChip(s) {
  return '<button type="button" class="s-chip" data-nav data-row="f-bw" data-chip="bw:measure"' + (s.bwPending ? ' disabled' : '') + '>' +
    (s.bwPending ? 'Mesure en cours…' : 'Mesurer ma connexion') + '</button>';
}

/** « Mesurer » : relance la mesure existante (valable 24 h) puis rafraîchit les pastilles et la recommandation. */
async function remeasure() {
  const s = session;
  if (!s || s.bwPending) return;
  const token = s.token;
  s.bwPending = true;
  render();
  const kbps = await measureBandwidthKbps().catch(() => null);
  if (!session || session.token !== token) return;
  session.bw = kbps;
  session.bwPending = false;
  session.rec = recommendFor(session.views, kbps);
  render();
}

export function closeSourcePicker() {
  const host = session && session.host;
  if (session && session.stop) session.stop();
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
    if (kind === 'bw') { remeasure(); return; }
    if (kind === 'res') s.filters = { ...s.filters, resolutions: toggleSet(s.filters.resolutions, value) };
    else if (kind === 'lang') s.filters = { ...s.filters, langs: toggleSet(s.filters.langs, value) };
    else if (kind === 'cache') s.filters = { ...s.filters, cachedOnly: !s.filters.cachedOnly };
    else if (kind === 'hdr') s.filters = { ...s.filters, hdrOnly: !s.filters.hdrOnly };
    else if (kind === 'origin') s.filters = { ...s.filters, origins: toggleSet(s.filters.origins, chip.dataset.chip.slice('origin:'.length)) };
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
