/* HTML des panneaux du lecteur (verre sombre, accent corail). Les données viennent de session.js (panelData) ;
 * les interactions passent par les attributs data-act, traités par session.js. */
import { esc } from '../ui/util.js';
import { LI } from './icons.js';
import { SPEEDS } from './keys';
import { offsetLabel } from './subs';
import { RATE_CHOICES } from './subsync';
import { isEpFolded } from './epfold.js';
import { localDay } from './episodes';
import '../ui/epStill.js'; // repli des vignettes cassées (écouteur global)

export const head = (title, sub) => '<div class="lp-panel-head"><div><h2>' + esc(title) + '</h2>' + (sub ? '<p class="lp-panel-sub">' + esc(sub) + '</p>' : '') + '</div>' +
  '<button type="button" class="lp-btn lp-btn-s" data-act="panel-close" aria-label="Fermer le panneau">' + LI.close + '</button></div>';

const attrs = (data) => Object.entries(data).map(([k, v]) => ' data-' + k + '="' + esc(String(v)) + '"').join('');

const chip = (act, data, label, on, aria) => '<button type="button" class="lp-chip' + (on ? ' is-on' : '') + '" data-act="' + act + '"' + attrs(data) +
  (aria ? ' aria-label="' + esc(aria) + '"' : '') + (on !== undefined ? ' aria-pressed="' + !!on + '"' : '') + '>' + label + '</button>';

/** Ligne d'option : coche, libellé, détail, pastilles. */
const opt = (act, data, label, detail, on, extra = '', badges = []) =>
  '<button type="button" class="lp-opt' + (on ? ' is-on' : '') + '" role="menuitemradio" aria-checked="' + (on ? 'true' : 'false') + '" data-act="' + act + '"' + attrs(data) + extra + '>' +
  '<span class="lp-opt-check">' + (on ? LI.check : '') + '</span><span class="lp-opt-text"><span class="lp-opt-label">' + esc(label) + '</span>' +
  (detail ? '<span class="lp-opt-detail">' + detail + '</span>' : '') + '</span>' +
  (badges.length ? '<span class="lp-badges">' + badges.map((b) => '<i>' + esc(b) + '</i>').join('') + '</span>' : '') + '</button>';

const seg = (act, key, opts, cur) => '<span class="lp-seg" role="group">' + opts.map(([v, l]) => chip(act, { key, val: v }, esc(l), cur === v)).join('') + '</span>';
const field = (label, body) => '<div class="lp-field"><span class="lp-field-l">' + esc(label) + '</span>' + body + '</div>';

// ---------- Audio et sous-titres ----------

function syncBlock(s) {
  const sync = s.sync;
  let auto;
  if (!sync.canAuto) auto = '<p class="lp-hint">' + esc(sync.reason || 'Synchronisation automatique indisponible pour ce flux.') + '</p>';
  else if (sync.state === 'collecting') {
    auto = '<p class="lp-hint">Analyse de la parole… ' + sync.seconds + ' / ' + sync.target + ' s de lecture</p><div class="lp-bar"><i style="width:' + Math.min(100, Math.round((sync.seconds / sync.target) * 100)) + '%"></i></div>' +
      '<div class="lp-row-btns">' + chip('autosync-now', {}, 'Terminer maintenant') + chip('autosync-cancel', {}, 'Annuler') + '</div>';
  } else auto = chip('autosync', {}, 'Synchroniser automatiquement') + (sync.message ? '<p class="lp-hint">' + esc(sync.message) + '</p>' : '<p class="lp-hint">Lance la lecture : le décalage est cherché en comparant la parole aux sous-titres.</p>');
  return '<div class="lp-sync">' +
    field('Synchronisation', '<span class="lp-step">' + chip('suboffset', { by: -1 }, '−1 s', undefined, 'Avancer de 1 s') + chip('suboffset', { by: -0.1 }, '−0,1', undefined, 'Avancer de 0,1 s') +
      '<output class="lp-val" aria-live="polite">' + esc(offsetLabel(s.offset)) + '</output>' + chip('suboffset', { by: 0.1 }, '+0,1', undefined, 'Retarder de 0,1 s') + chip('suboffset', { by: 1 }, '+1 s', undefined, 'Retarder de 1 s') +
      chip('suboffset-reset', {}, 'Réinitialiser') + '</span>') +
    field('Corriger la vitesse (PAL)', '<span class="lp-seg" role="group">' + RATE_CHOICES.map((r) => chip('subrate', { id: r.id }, esc(r.label), s.rate === r.id)).join('') + '</span>') +
    (s.rateHint ? '<p class="lp-hint">' + esc(s.rateHint) + '</p>' : '') +
    '<div class="lp-auto">' + auto + '</div></div>';
}

export function tracksHtml(d) {
  const a = d.audio;
  const s = d.subs;
  const audioCol = '<section class="lp-col" data-col="audio"><h3>Audio</h3><div class="lp-list" role="menu">' +
    (a.groups.length ? a.groups.map((g) => (g.items.length > 1 ? '<h4 class="lp-grp-h">' + esc(g.name) + '</h4>' : '') +
      g.items.map((it) => opt('audio', { id: it.track.id }, it.label, esc(it.detail), it.track.selected, '', it.badges)).join('')).join('')
      : '<p class="lp-empty">' + esc(a.note) + '</p>') +
    (a.canTranscode ? '<button type="button" class="btn btn-ghost lp-wide" data-act="force-hls">Lire en transcodage (toutes les pistes)</button>' : '') + '</div></section>';

  const subRows = (sec) => '<h4 class="lp-sec-h">' + esc(sec.title) + '</h4>' + sec.groups.map((g) =>
    (sec.groups.length > 1 ? '<h5 class="lp-grp-h">' + esc(g.name) + '</h5>' : '') +
    g.items.map((it) => opt('sub', { id: it.track.id }, it.label,
      (it.unsupported ? '<em>' + esc(it.unsupported) + '</em>' : it.chips.map((c) => '<b class="lp-tag' + (c.startsWith('Synchronisé') ? ' is-sync' : '') + '">' + esc(c) + '</b>').join('')),
      it.track.id === s.selectedId, it.track.renderable ? '' : ' disabled')).join('')).join('');

  const st = s.style;
  const style = '<details class="lp-det"' + (s.styleOpen ? ' open' : '') + '><summary>Style des sous-titres</summary><div class="lp-opts">' +
    field('Taille', seg('substyle', 'size', [[80, 'S'], [100, 'M'], [130, 'L'], [170, 'XL']].map(([v, l]) => [String(v), l]), String(st.size))) +
    field('Couleur', seg('substyle', 'color', [['white', 'Blanc'], ['yellow', 'Jaune']], st.color)) +
    field('Fond', seg('substyle', 'background', [['none', 'Aucun'], ['shadow', 'Ombre'], ['box', 'Boîte']], st.background)) +
    field('Police', seg('substyle', 'font', [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], st.font)) +
    field('Position', seg('substyle', 'edge', [['bottom', 'Bas'], ['top', 'Haut']], st.edge) + '<span class="lp-step">' + chip('substep', { key: 'position', by: 2 }, '↑', undefined, 'Éloigner du bord') + '<output class="lp-val">' + st.position + ' %</output>' + chip('substep', { key: 'position', by: -2 }, '↓', undefined, 'Rapprocher du bord') + '</span>') +
    field('Par défaut', seg('substyle', 'mode', [['auto', 'Auto'], ['always', 'Toujours'], ['off', 'Jamais']], st.mode)) +
    field('Langues', '<button type="button" class="lp-more" data-act="langsettings">Régler dans Audio et sous-titres</button>') +
    '</div></details>';

  const subCol = '<section class="lp-col" data-col="subs"><h3>Sous-titres</h3><div class="lp-list" role="menu">' +
    opt('sub', { id: '' }, 'Désactivés', '', s.selectedId === null) +
    s.sections.map(subRows).join('') +
    (s.loading ? '<p class="lp-empty">Recherche de sous-titres…</p>' : '') +
    (!s.sections.length && !s.loading ? '<p class="lp-empty">Aucun sous-titre trouvé.</p>' : '') +
    '<button type="button" class="lp-more" data-act="subsearch">' + LI.info + 'Rechercher d’autres sous-titres</button></div>' +
    '<div class="lp-below">' + syncBlock(s) + style + '</div></section>';
  return head('Audio et sous-titres') + '<div class="lp-cols">' + audioCol + subCol + '</div>';
}

// ---------- Épisodes ----------

export function episodesHtml(d) {
  const cur = d.current;
  const fmtDate = (iso) => { try { return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return iso; } };
  const fmtShort = (iso) => { try { return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); } catch (_) { return iso; } };
  const today = localDay(new Date());
  const rows = d.loading ? '<p class="lp-empty">Chargement…</p>' : d.episodes.map((ep) => {
    const on = d.season === cur.season && ep.episode === cur.episode;
    // Diffusé, ou diffusion dans les 14 prochains jours : lisible (la recherche de sources décide), sinon « Bientôt ».
    const open = ep.aired || !!ep.playable;
    const meta = [ep.runtime ? ep.runtime + ' min' : '', ep.airDate ? fmtDate(ep.airDate) : ''].filter(Boolean).join(' · ');
    // Pastille discrète : « Aujourd’hui » pour l’épisode du jour ; « À venir · 21 oct. » pour une diffusion dans la fenêtre
    // (« peut-être déjà en ligne » dans l’infobulle) ; « Bientôt » au-delà ; rien pour un épisode déjà diffusé.
    const pill = ep.airDate === today ? { text: 'Aujourd’hui', tip: 'Diffusé aujourd’hui', now: true }
      : ep.aired ? null
        : open ? { text: 'À venir · ' + fmtShort(ep.airDate), tip: 'Diffusion TV le ' + fmtDate(ep.airDate) + ' · peut-être déjà en ligne', now: false }
          : { text: 'Bientôt', tip: 'Diffusion TV le ' + fmtDate(ep.airDate), now: false };
    // Repli si la vignette est absente ou ne charge pas : fond de la série (flouté, assombri), sinon dégradé ; numéro en surimpression.
    const fb = !ep.still;
    const src = ep.still || d.backdrop || '';
    const still = '<span class="lp-ep-still' + (fb ? ' is-fb' : '') + '">' +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" data-still' + (ep.still && d.backdrop ? ' data-fb="' + esc(d.backdrop) + '"' : '') + '>' : '') +
      '<span class="lp-ep-num" aria-hidden="true">É' + ep.episode + '</span>' +
      (on ? '<span class="lp-ep-now">En cours</span>' : '') +
      (pill ? '<span class="lp-ep-soon' + (pill.now ? ' is-today' : '') + '" title="' + esc(pill.tip) + '">' + esc(pill.text) + '</span>' : '') +
      (ep.progress > 0 && !ep.watched ? '<span class="lp-ep-prog"><i style="width:' + Math.round(ep.progress * 100) + '%"></i></span>' : '') + '</span>';
    // Bouton « vu » : frère (et non enfant) du bouton de lecture, pour ne pas imbriquer des boutons.
    const seenLabel = ep.watched ? 'Marquer comme non vu' : 'Marquer comme vu';
    const seen = ep.aired || ep.watched ? '<button type="button" class="lp-ep-seen' + (ep.watched ? ' is-on' : '') + '" data-act="ep-seen" data-season="' + d.season + '" data-episode="' + ep.episode + '" data-seen="' + (ep.watched ? '0' : '1') + '" title="' + seenLabel + '" aria-label="' + seenLabel + '">' + LI.check + '</button>' : '';
    const folded = !!ep.overview && isEpFolded(d.season, ep.episode);
    const more = ep.overview ? '<button type="button" class="lp-ep-more" data-season="' + d.season + '" data-episode="' + ep.episode + '" aria-expanded="' + (folded ? 'true' : 'false') + '" aria-label="Afficher le synopsis complet" title="Plus">' + LI.mini + '</button>' : '';
    return '<div class="lp-ep-row' + (on ? ' is-on' : '') + (open ? '' : ' is-soon') + (ep.overview ? ' has-more' : '') + (folded ? ' is-open' : '') + '" data-ep="' + ep.episode + '">' +
      '<button type="button" class="lp-ep" role="menuitem" data-act="episode" data-season="' + d.season + '" data-episode="' + ep.episode + '"' + (open ? '' : ' disabled') + '>' + still +
        '<span class="lp-ep-text"><span class="lp-ep-name"><b>É' + ep.episode + '</b> · ' + esc(ep.name || 'Épisode ' + ep.episode) + '</span>' +
        '<span class="lp-ep-meta">' + esc(meta) + '</span>' + (ep.overview ? '<span class="lp-ep-syn">' + esc(ep.overview) + '</span>' : '') + '</span></button>' +
      seen + more +
      '</div>';
  }).join('') + (!d.loading && !d.episodes.length && d.error ? '<p class="lp-empty">Impossible de charger les épisodes. Change de saison ou rouvre le panneau pour réessayer.</p>' : '') + (!d.loading && !d.episodes.length && !d.error ? '<p class="lp-empty">Aucun épisode' + (d.query ? ' ne correspond à « ' + esc(d.query) + ' »' : '') + '.</p>' : '');
  const seasons = d.seasons.map((s) => s.season);
  const i = seasons.indexOf(d.season);
  return head('Épisodes') +
    '<div class="lp-eps-head">' + (d.logo ? '<img class="lp-eps-logo" src="' + esc(d.logo) + '" alt="' + esc(d.title) + '">' : '<p class="lp-eps-title">' + esc(d.title) + '</p>') +
      '<div class="lp-eps-bar">' +
        (d.seasons.length ? '<label class="lp-sel"><span class="sr-only">Saison</span><select class="lp-select" aria-label="Saison">' + d.seasons.map((s) => '<option value="' + s.season + '"' + (s.season === d.season ? ' selected' : '') + '>Saison ' + s.season + '</option>').join('') + '</select></label>' : '') +
        '<span class="lp-eps-sum">Saison ' + d.season + ' · ' + d.total + ' épisode' + (d.total > 1 ? 's' : '') + ' · ' + d.watchedCount + ' vu' + (d.watchedCount > 1 ? 's' : '') + '</span></div>' +
      '<div class="lp-eps-tools"><input class="lp-search" type="text" inputmode="search" placeholder="Chercher un épisode" aria-label="Chercher un épisode" value="' + esc(d.query || '') + '" data-input="epsearch">' +
        chip('ep-next-unseen', {}, 'Prochain non vu') + '</div></div>' +
    '<div class="lp-list lp-eps" role="menu">' + rows + '</div>' +
    '<div class="lp-eps-foot">' + chip('ep-season-seen', { season: d.season }, 'Marquer la saison comme vue') +
      '<span class="lp-step">' + (i > 0 ? chip('season', { season: seasons[i - 1] }, '← Saison ' + seasons[i - 1]) : '') + (i >= 0 && i < seasons.length - 1 ? chip('season', { season: seasons[i + 1] }, 'Saison ' + seasons[i + 1] + ' →') : '') + '</span></div>';
}

// ---------- Réglages et qualité ----------

export function settingsHtml(d) {
  const row = ([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + (typeof v === 'object' ? v.html : esc(v)) + '</dd></div>';
  const mark = d.mark;
  const markBody = mark.state === 'idle'
    ? seg('mark-kind', 'kind', [['intro', 'Intro'], ['recap', 'Récap'], ['credits', 'Générique']], mark.kind) + chip('mark-start', {}, 'Marquer le début ici (' + mark.at + ')')
    : '<p class="lp-hint">Début : <b>' + esc(mark.startLabel) + '</b>. Avance jusqu’à la fin du segment puis valide.</p><div class="lp-row-btns">' + chip('mark-end', {}, 'Marquer la fin ici (' + mark.at + ')') + chip('mark-cancel', {}, 'Annuler') + '</div>';
  return head('Réglages') + '<div class="lp-scroll">' +
    '<section class="lp-sec"><h3>Source</h3><dl class="lp-kv">' + d.source.map(row).join('') + '</dl>' +
      '<button type="button" class="lp-more" data-act="source">' + LI.source + 'Changer de source</button></section>' +
    '<section class="lp-sec"><h3>Vitesse de lecture</h3><div class="lp-speeds">' + SPEEDS.map((r) => chip('rate', { rate: r }, r === 1 ? 'Normale' : r + '×', Math.abs(d.rate - r) < 0.01)).join('') + '</div></section>' +
    '<section class="lp-sec"><h3>Image</h3>' + seg('aspect', 'mode', [['contain', 'Ajuster'], ['cover', 'Remplir'], ['fill', '16:9']], d.aspect) +
      (d.thumbsAvailable === false ? '' : field('Aperçu sur la barre', chip('thumbs', {}, d.thumbs ? 'Activé' : 'Désactivé', d.thumbs))) +
      (d.autoPipAvailable ? field('Image dans l’image automatique', chip('autopip', {}, d.autoPip ? 'Activée' : 'Désactivée', d.autoPip)) : '') + '</section>' +
    (d.canMark ? '<section class="lp-sec"><h3>Marquer un segment</h3><p class="lp-hint">Aide la communauté : signale où commencent et finissent l’intro, le récap ou le générique de cet épisode.</p>' + markBody + '</section>' : '') +
    '</div>';
}

// ---------- Infos ----------

export function infoHtml(d) {
  return head('Infos') + '<div class="lp-scroll"><section class="lp-sec"><h3 class="lp-info-t">' + esc(d.title) + '</h3>' +
    (d.episode ? '<p class="lp-info-ep">' + esc(d.episode) + '</p>' : '') +
    (d.rating ? '<p class="lp-info-rate">★ ' + esc(d.rating) + '</p>' : '') +
    (d.synopsis ? '<p class="lp-info-syn">' + esc(d.synopsis) + '</p>' : '') + '</section>' +
    (d.cast.length ? '<section class="lp-sec"><h3>Distribution</h3><div class="lp-cast">' + d.cast.map((p) => '<span class="lp-cast-i">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="" loading="lazy">' : '<i></i>') + '<b>' + esc(p.name) + '</b><em>' + esc(p.role) + '</em></span>').join('') + '</div></section>' : '') +
    '<section class="lp-sec"><h3>Lecture</h3><dl class="lp-kv">' + d.rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl></section></div>';
}
