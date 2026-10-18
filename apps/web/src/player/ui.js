/* Interface du lecteur plein écran, dans l'esprit Netflix / Nuvio : barre haute (retour, titre, icônes), boutons centraux,
 * barre de position fine qui s'épaissit au survol, pastilles de saut, carte « épisode suivant » avec compte à rebours,
 * panneaux latéraux (épisodes ; audio et sous-titres sur deux colonnes ; vitesse ; infos), écran de pause.
 * Aucune logique de lecture ici : tout passe par les gestionnaires `h` fournis par session.js. */
import { esc } from '../ui/util.js';
import { SPEEDS } from './keys';
import { formatClock } from './progress';
import { SKIP_LABEL } from './skip';
import { offsetLabel } from './subs';

const svg = (d, extra = '') => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + extra + '>' + d + '</svg>';
export const LI = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  back10: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M9.5 15.5v-4.2l-1 .6M13 11.3h2.2a.9.9 0 0 1 .9.9v2.4a.9.9 0 0 1-.9.9H13z"/>'),
  fwd10: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><path d="M9.5 15.5v-4.2l-1 .6M13 11.3h2.2a.9.9 0 0 1 .9.9v2.4a.9.9 0 0 1-.9.9H13z"/>'),
  vol: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  tracks: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h3M12.5 12H17M7 15.5h5M14 15.5h3"/>'),
  source: svg('<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  fullExit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  next: svg('<path d="M5 5l9 7-9 7zM18 5v14"/>'),
  skip: svg('<path d="M5 5l9 7-9 7zM16 5l5 7-5 7"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

const btn = (act, icon, label, extra = '', cls = '') => '<button type="button" class="lp-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" aria-label="' + esc(label) + '" data-tip="' + esc(label) + '"' + extra + '>' + icon + '</button>';
const tbtn = (act, icon, label, extra = '') => '<button type="button" class="lp-tbtn" data-act="' + act + '"' + extra + '>' + icon + '<span>' + esc(label) + '</span></button>';
const PANEL_ALIAS = { audio: 'tracks', subtitles: 'tracks' };
const REMAIN_KEY = 'laststream.player.remaining';

function skeleton() {
  return '<video class="lp-video" playsinline></video>' +
    '<div class="lp-subs" aria-hidden="true"></div>' +
    '<div class="lp-pause" hidden><div class="lp-pause-in"><p class="lp-pause-k">Vous regardez</p><div class="lp-pause-logo"></div><p class="lp-pause-ep"></p><p class="lp-pause-syn"></p></div></div>' +
    '<div class="lp-loading" role="status"><div class="lp-spin" aria-hidden="true"></div><div class="lp-load-logo"></div><p class="lp-load-msg"></p><p class="lp-load-src"></p></div>' +
    '<div class="lp-error" role="alert" hidden><p class="lp-err-title"></p><p class="lp-err-msg"></p><div class="lp-err-actions"></div></div>' +
    '<div class="lp-top">' +
      btn('close', LI.back, 'Retour (Échap)', '', 'lp-close') +
      '<div class="lp-heading"><p class="lp-title"></p><p class="lp-sub"></p></div>' +
      '<div class="lp-top-r">' + btn('info', LI.info, 'Infos (I)') + btn('pip', LI.pip, 'Image dans l’image (P)', ' data-role="pip"') + btn('panel:speed', LI.gear, 'Réglages (vitesse, options)', ' data-role="speed"') + '</div>' +
    '</div>' +
    '<div class="lp-center">' +
      btn('back10', LI.back10, 'Reculer de 10 s', '', 'lp-big') + btn('toggle-play', LI.play, 'Lecture / pause (Espace)', ' data-role="bigplay"', 'lp-big lp-huge') + btn('fwd10', LI.fwd10, 'Avancer de 10 s', '', 'lp-big') +
    '</div>' +
    '<div class="lp-ripple lp-ripple-l" hidden>−10 s</div><div class="lp-ripple lp-ripple-r" hidden>+10 s</div>' +
    '<button type="button" class="lp-skip" data-act="skip" hidden></button>' +
    '<div class="lp-next" hidden></div>' +
    '<div class="lp-endrow" hidden></div>' +
    '<div class="lp-resume" role="dialog" aria-label="Reprise" hidden></div>' +
    '<div class="lp-bottom">' +
      '<div class="lp-seek" data-seek role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
        '<div class="lp-track"><span class="lp-buf"></span><span class="lp-played"></span><span class="lp-marks"></span></div>' +
        '<span class="lp-thumb"></span><span class="lp-hover" hidden></span>' +
      '</div>' +
      '<div class="lp-row">' +
        '<div class="lp-grp">' +
          btn('toggle-play', LI.play, 'Lecture / pause (Espace)', ' data-role="play"') +
          btn('back10', LI.back10, 'Reculer de 10 s') + btn('fwd10', LI.fwd10, 'Avancer de 10 s') +
          '<span class="lp-vol">' + btn('mute', LI.vol, 'Couper le son (M)', ' data-role="mute"') +
          '<input class="lp-vslider" type="range" min="0" max="100" step="5" value="100" aria-label="Volume"></span>' +
          '<button type="button" class="lp-time" data-act="toggle-remaining" aria-label="Afficher le temps restant" data-tip="Temps écoulé / restant">0:00 / 0:00</button>' +
        '</div>' +
        '<div class="lp-grp lp-grp-r">' +
          tbtn('next', LI.next, 'Épisode suivant', ' data-role="next" hidden') +
          tbtn('panel:episodes', LI.list, 'Épisodes', ' data-role="episodes" hidden') +
          tbtn('panel:tracks', LI.tracks, 'Audio et sous-titres') +
          tbtn('source', LI.source, 'Sources') +
          btn('fullscreen', LI.full, 'Plein écran (F)', ' data-role="full"') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<aside class="lp-panel" hidden aria-label="Panneau"></aside>' +
    '<div class="lp-toast" role="status" aria-live="polite"><span class="lp-toast-t"></span><button type="button" class="lp-toast-a" hidden></button></div>';
}

export function createPlayerUI(h) {
  const root = document.createElement('div');
  root.className = 'lp is-ui';
  root.id = 'lsplayer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Lecteur vidéo');
  root.hidden = true;
  root.innerHTML = skeleton();
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  const video = q('.lp-video');
  const panel = q('.lp-panel');
  const seek = q('[data-seek]');
  const vs = q('.lp-vslider');
  let panelName = null;
  let focusCol = 'audio';
  let hideTimer = null;
  let toastTimer = null;
  let dragging = false;
  let last = null;
  let remaining = false;
  try { remaining = globalThis.localStorage.getItem(REMAIN_KEY) === '1'; } catch (_) { /* ignoré */ }
  let lastTap = { t: 0, side: '' };
  let pauseTimer = null;
  let pauseInfo = null;

  // ---------- Contrôles : masquage après 3 s d'inactivité ----------
  function wake() {
    root.classList.add('is-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (panelName || !last || last.paused || dragging || document.activeElement === vs || !q('.lp-resume').hidden || !q('.lp-error').hidden) return;
      root.classList.remove('is-ui');
    }, 3000);
  }
  root.addEventListener('mousemove', wake);
  root.addEventListener('pointerdown', wake);
  root.addEventListener('touchstart', wake, { passive: true });

  // ---------- Clics, double-touche ----------
  const side = (e) => {
    const r = root.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    return f < 0.35 ? 'l' : f > 0.65 ? 'r' : 'c';
  };
  function ripple(s) {
    const el = q(s === 'l' ? '.lp-ripple-l' : '.lp-ripple-r');
    el.hidden = false;
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
    setTimeout(() => { el.hidden = true; }, 600);
  }
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    wake();
    const a = t.closest('[data-act]');
    if (a && !a.disabled) {
      const act = a.dataset.act;
      if (act.startsWith('panel:')) { api.togglePanel(act.slice(6)); return; }
      if (act === 'toggle-remaining') { remaining = !remaining; try { globalThis.localStorage.setItem(REMAIN_KEY, remaining ? '1' : '0'); } catch (_) { /* ignoré */ } if (last) api.update(last); return; }
      h.action(act, a.dataset);
      return;
    }
    if (t !== video && !t.classList.contains('lp-subs') && !t.classList.contains('lp-pause') && !t.classList.contains('lp-pause-in') && !t.classList.contains('lp-center')) return;
    if (panelName) { api.closePanel(); return; }
    const s = side(e);
    const touch = e.pointerType === 'touch';
    const now = Date.now();
    const dbl = now - lastTap.t < 320 && lastTap.side === s;
    lastTap = { t: now, side: s };
    if (touch) {
      if (dbl && s !== 'c') { h.action(s === 'l' ? 'back10' : 'fwd10'); ripple(s); lastTap = { t: 0, side: '' }; }
      else if (dbl) { h.action('toggle-play'); lastTap = { t: 0, side: '' }; }
      else if (root.classList.contains('is-ui') && last && !last.paused) root.classList.remove('is-ui');
      return;
    }
    if (dbl) { h.action('fullscreen'); lastTap = { t: 0, side: '' }; return; }
    h.action('toggle-play');
  });

  // ---------- Barre de position ----------
  const frac = (e) => {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const hover = q('.lp-hover');
  function previewSeek(f) {
    q('.lp-played').style.width = f * 100 + '%';
    q('.lp-thumb').style.left = f * 100 + '%';
  }
  seek.addEventListener('pointermove', (e) => {
    if (!last || !last.duration) return;
    const f = frac(e);
    hover.hidden = false;
    hover.style.left = f * 100 + '%';
    hover.textContent = formatClock(f * last.duration);
    if (dragging) previewSeek(f);
  });
  seek.addEventListener('pointerleave', () => { hover.hidden = true; });
  seek.addEventListener('pointerdown', (e) => {
    if (!last || !last.duration) return;
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    previewSeek(frac(e));
  });
  seek.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (last && last.duration) h.seekTo(frac(e) * last.duration);
  });
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.stopPropagation(); h.action(e.key === 'ArrowLeft' ? 'back10' : 'fwd10'); e.preventDefault(); }
  });
  vs.addEventListener('input', () => h.setVolume(Number(vs.value) / 100));
  vs.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); });

  // ---------- Panneaux ----------
  const optRow = (act, data, label, detail, on, extra = '') => '<button type="button" class="lp-opt' + (on ? ' is-on' : '') + '" role="menuitemradio" aria-checked="' + (on ? 'true' : 'false') + '" data-act="' + act + '"' +
    Object.entries(data).map(([k, v]) => ' data-' + k + '="' + esc(String(v)) + '"').join('') + extra + '><span class="lp-opt-check">' + (on ? LI.check : '') + '</span><span class="lp-opt-text"><span class="lp-opt-label">' + esc(label) + '</span>' +
    (detail ? '<span class="lp-opt-detail">' + esc(detail) + '</span>' : '') + '</span></button>';
  const head = (title) => '<div class="lp-panel-head"><h2>' + esc(title) + '</h2><button type="button" class="lp-btn lp-btn-s" data-act="panel-close" aria-label="Fermer le panneau">' + LI.close + '</button></div>';
  const chip = (act, attrs, label, on, aria) => '<button type="button" class="lp-chip' + (on ? ' is-on' : '') + '" data-act="' + act + '"' + attrs + (aria ? ' aria-label="' + esc(aria) + '"' : '') + (on !== undefined ? ' aria-pressed="' + !!on + '"' : '') + '>' + label + '</button>';

  function tracksHtml(d) {
    const a = d.audio;
    const s = d.subs;
    const seg = (key, opts, cur) => '<span class="lp-seg" role="group">' + opts.map(([v, l]) => chip('substyle', ' data-key="' + key + '" data-val="' + v + '"', esc(l), cur === v)).join('') + '</span>';
    const audioCol = '<section class="lp-col" data-col="audio"><h3>Audio</h3><div class="lp-list" role="menu">' +
      (a.tracks.length ? a.tracks.map((t) => optRow('audio', { id: t.id }, t.label, '', t.selected)).join('') : '<p class="lp-empty">' + esc(a.note) + '</p>') +
      (a.canTranscode ? '<button type="button" class="btn btn-ghost lp-wide" data-act="force-hls">Lire en transcodage (toutes les pistes)</button>' : '') + '</div></section>';
    const subCol = '<section class="lp-col" data-col="subs"><h3>Sous-titres</h3><div class="lp-list" role="menu">' +
      optRow('sub', { id: '' }, 'Désactivés', '', s.selectedId === null) +
      s.tracks.map((t) => optRow('sub', { id: t.id }, t.label, t.origin === 'external' ? (t.source || 'Externe') : 'Dans le fichier' + (t.renderable ? '' : ' · image, non affichable'), t.id === s.selectedId, t.renderable ? '' : ' disabled')).join('') +
      (s.loading ? '<p class="lp-empty">Recherche de sous-titres…</p>' : '') +
      (!s.tracks.length && !s.loading ? '<p class="lp-empty">Aucun sous-titre trouvé.</p>' : '') + '</div>' +
      '<div class="lp-opts">' +
        '<div class="lp-field"><span>Synchronisation</span><span class="lp-step">' + chip('suboffset', ' data-by="-0.5"', '−0,5', undefined, 'Avancer de 0,5 s') + chip('suboffset', ' data-by="-0.1"', '−0,1', undefined, 'Avancer de 0,1 s') + '<output class="lp-val">' + esc(offsetLabel(s.offset)) + '</output>' + chip('suboffset', ' data-by="0.1"', '+0,1', undefined, 'Retarder de 0,1 s') + chip('suboffset', ' data-by="0.5"', '+0,5', undefined, 'Retarder de 0,5 s') + '</span></div>' +
        '<div class="lp-field"><span>Taille</span><span class="lp-step">' + chip('substep', ' data-key="size" data-by="-10"', 'A−', undefined, 'Plus petit') + '<output class="lp-val">' + s.style.size + ' %</output>' + chip('substep', ' data-key="size" data-by="10"', 'A+', undefined, 'Plus grand') + '</span></div>' +
        '<div class="lp-field"><span>Position</span><span class="lp-step">' + chip('substep', ' data-key="position" data-by="2"', '↑', undefined, 'Monter') + '<output class="lp-val">' + s.style.position + ' %</output>' + chip('substep', ' data-key="position" data-by="-2"', '↓', undefined, 'Descendre') + '</span></div>' +
        '<div class="lp-field"><span>Fond</span>' + seg('background', [['none', 'Aucun'], ['shadow', 'Ombre'], ['box', 'Boîte']], s.style.background) + '</div>' +
        '<div class="lp-field"><span>Couleur</span>' + seg('color', [['white', 'Blanc'], ['yellow', 'Jaune']], s.style.color) + '</div>' +
        '<div class="lp-field"><span>Par défaut</span>' + seg('mode', [['auto', 'Auto'], ['always', 'Toujours'], ['off', 'Jamais']], s.style.mode) + '</div>' +
      '</div></section>';
    return head('Audio et sous-titres') + '<div class="lp-cols">' + audioCol + subCol + '</div>';
  }

  function episodesHtml(d) {
    const cur = d.current;
    return head('Épisodes') + '<div class="lp-eps-bar">' +
      (d.seasons.length ? '<label class="lp-sel"><span class="sr-only">Saison</span><select class="lp-select" aria-label="Saison">' + d.seasons.map((s) => '<option value="' + s.season + '"' + (s.season === d.season ? ' selected' : '') + '>Saison ' + s.season + '</option>').join('') + '</select></label>' : '') + '</div>' +
      '<div class="lp-list lp-eps" role="menu">' +
      (d.loading ? '<p class="lp-empty">Chargement…</p>' : d.episodes.map((ep) => {
        const on = d.season === cur.season && ep.episode === cur.episode;
        return '<button type="button" class="lp-ep' + (on ? ' is-on' : '') + '" role="menuitem" data-act="episode" data-season="' + d.season + '" data-episode="' + ep.episode + '">' +
          '<span class="lp-ep-still">' + (ep.still ? '<img src="' + esc(ep.still) + '" alt="" loading="lazy" decoding="async">' : '') +
            (ep.progress > 0 && !ep.watched ? '<span class="lp-ep-prog"><i style="width:' + Math.round(ep.progress * 100) + '%"></i></span>' : '') +
            (ep.watched ? '<span class="lp-ep-seen" title="Vu">' + LI.check + '</span>' : '') + '</span>' +
          '<span class="lp-ep-text"><span class="lp-ep-name">' + ep.episode + '. ' + esc(ep.name || 'Épisode ' + ep.episode) + (on ? ' <em>En cours</em>' : '') + '</span>' +
          '<span class="lp-ep-meta">' + (ep.runtime ? ep.runtime + ' min' : '') + '</span>' +
          (ep.overview ? '<span class="lp-ep-syn">' + esc(ep.overview) + '</span>' : '') + '</span></button>';
      }).join('')) +
      (!d.loading && !d.episodes.length ? '<p class="lp-empty">Aucun épisode.</p>' : '') + '</div>';
  }

  const focusKeyOf = (el) => (el.dataset ? [el.dataset.act, el.dataset.id, el.dataset.key, el.dataset.val, el.dataset.by, el.dataset.rate, el.dataset.season, el.dataset.episode, el.tagName === 'SELECT' ? 'sel' : ''].join('|') : '');

  function renderPanel() {
    if (!panelName) return;
    const d = h.panelData(panelName);
    let html = '';
    if (panelName === 'tracks') html = tracksHtml(d);
    else if (panelName === 'speed') {
      html = head('Réglages') + '<div class="lp-list" role="menu"><h3 class="lp-h3">Vitesse de lecture</h3>' + SPEEDS.map((r) => optRow('rate', { rate: r }, r === 1 ? 'Normale' : r + '×', '', Math.abs(d.rate - r) < 0.01)).join('') + '</div>' +
        (d.pipAvailable ? '<div class="lp-opts"><div class="lp-field"><span>Image dans l’image automatique</span>' + chip('autopip', '', d.autoPip ? 'Activée' : 'Désactivée', d.autoPip) + '</div><p class="lp-empty">Quand tu quittes l’onglet, la vidéo passe en fenêtre flottante.</p></div>' : '');
    } else if (panelName === 'episodes') html = episodesHtml(d);
    else if (panelName === 'info') {
      html = head('Infos') + '<div class="lp-info"><dl>' + d.rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl></div>';
    }
    const keep = Array.from(panel.querySelectorAll('.lp-list')).map((l) => l.scrollTop);
    const focusKey = document.activeElement && panel.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null;
    panel.innerHTML = html;
    panel.classList.toggle('is-wide', panelName === 'tracks');
    panel.classList.toggle('is-eps', panelName === 'episodes');
    panel.querySelectorAll('.lp-list').forEach((l, i) => { if (keep[i]) l.scrollTop = keep[i]; });
    if (focusKey) {
      const again = Array.from(panel.querySelectorAll('button:not([disabled]), select')).find((b) => focusKeyOf(b) === focusKey);
      if (again) again.focus({ preventScroll: true });
    }
  }
  panel.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement) h.action('season', { season: e.target.value });
  });

  const api = {
    root,
    video,
    get panel() { return panelName; },
    show() { root.hidden = false; root.classList.add('is-ui'); wake(); },
    hide() { root.hidden = true; api.closePanel(true); api.setPauseScreen(null); },
    isOpen: () => !root.hidden,
    wake,
    focusFirst() { const c = q('[data-role="play"]'); if (c) c.focus({ preventScroll: true }); },
    setHeading(title, sub) { q('.lp-title').textContent = title || ''; q('.lp-sub').textContent = sub || ''; },
    /** `extra` : { logo, source } pour le logo du titre et la ligne « 1080p · VFF · AllDebrid ». */
    setLoading(title, msg, extra) {
      const el = q('.lp-loading');
      el.hidden = !title && !msg;
      const e = extra || {};
      q('.lp-load-logo').innerHTML = e.logo ? '<img src="' + esc(e.logo) + '" alt="' + esc(title || '') + '">' : title ? '<span>' + esc(title) + '</span>' : '';
      q('.lp-load-msg').textContent = msg || '';
      q('.lp-load-src').textContent = e.source || '';
    },
    setError(title, msg, actions) {
      const el = q('.lp-error');
      el.hidden = !title;
      if (!title) return;
      q('.lp-err-title').textContent = title;
      q('.lp-err-msg').textContent = msg || '';
      q('.lp-err-actions').innerHTML = actions.map((a, i) => '<button type="button" class="btn ' + (i === 0 ? 'btn-primary' : 'btn-ghost') + '" data-act="' + esc(a.act) + '">' + esc(a.label) + '</button>').join('');
      root.classList.add('is-ui');
      const f = q('.lp-err-actions button');
      if (f) f.focus({ preventScroll: true });
    },
    /** `st` : état du moteur (voir engines.js). */
    update(st, marks) {
      last = st;
      const dur = st.duration || 0;
      const pct = dur ? Math.min(100, (st.time / dur) * 100) : 0;
      if (!dragging) {
        q('.lp-played').style.width = pct + '%';
        q('.lp-thumb').style.left = pct + '%';
      }
      let bufEnd = st.time;
      for (const [s, e] of st.buffered) if (st.time >= s - 0.3 && st.time <= e) bufEnd = e;
      q('.lp-buf').style.width = dur ? Math.min(100, (bufEnd / dur) * 100) + '%' : '0%';
      q('.lp-time').textContent = remaining && dur ? '−' + formatClock(Math.max(0, dur - st.time)) + ' / ' + formatClock(dur) : formatClock(st.time) + ' / ' + formatClock(dur);
      seek.setAttribute('aria-valuemax', String(Math.round(dur)));
      seek.setAttribute('aria-valuenow', String(Math.round(st.time)));
      seek.setAttribute('aria-valuetext', formatClock(st.time) + ' sur ' + formatClock(dur));
      for (const sel of ['[data-role="play"]', '[data-role="bigplay"]']) {
        const b = q(sel);
        const stt = st.paused ? 'paused' : 'playing';
        if (b.dataset.state !== stt) { b.dataset.state = stt; b.innerHTML = st.paused ? LI.play : LI.pause; }
      }
      q('[data-role="mute"]').innerHTML = st.muted || st.volume === 0 ? LI.mute : LI.vol;
      if (document.activeElement !== vs) vs.value = String(Math.round((st.muted ? 0 : st.volume) * 100));
      root.classList.toggle('is-buffering', !!st.buffering);
      root.classList.toggle('is-paused', !!st.paused);
      q('[data-role="full"]').innerHTML = document.fullscreenElement === root ? LI.fullExit : LI.full;
      q('[data-role="pip"]').classList.toggle('is-active', !!st.pip);
      if (st.paused) root.classList.add('is-ui');
      // Écran de pause : après 8 s à l'arrêt (hors panneau ouvert).
      if (st.paused && pauseInfo && !panelName) {
        if (!pauseTimer) pauseTimer = setTimeout(() => { if (last && last.paused && !panelName) q('.lp-pause').hidden = false; }, 8000);
      } else {
        clearTimeout(pauseTimer);
        pauseTimer = null;
        q('.lp-pause').hidden = true;
      }
      if (marks) api.setMarks(marks);
    },
    /** Informations de l'écran de pause : { logo, title, episode, synopsis, backdrop } ou null. */
    setPauseScreen(info) {
      pauseInfo = info;
      const el = q('.lp-pause');
      if (!info) { clearTimeout(pauseTimer); pauseTimer = null; el.hidden = true; return; }
      el.style.backgroundImage = info.backdrop ? 'linear-gradient(90deg, rgba(0,0,0,.88) 0%, rgba(0,0,0,.55) 60%, rgba(0,0,0,.35) 100%), url("' + info.backdrop + '")' : '';
      q('.lp-pause-logo').innerHTML = info.logo ? '<img src="' + esc(info.logo) + '" alt="' + esc(info.title) + '">' : '<span>' + esc(info.title) + '</span>';
      q('.lp-pause-ep').textContent = info.episode || '';
      q('.lp-pause-syn').textContent = info.synopsis || '';
    },
    setMarks(marks) {
      const el = q('.lp-marks');
      const key = JSON.stringify(marks);
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.innerHTML = marks.map((m) => '<i class="lp-mark lp-mark-' + m.kind + '" style="left:' + m.from * 100 + '%;width:' + Math.max(0.4, (m.to - m.from) * 100) + '%"></i>').join('');
    },
    setSeries(isSeries, hasNext) {
      q('[data-role="episodes"]').hidden = !isSeries;
      q('[data-role="next"]').hidden = !hasNext;
    },
    setPipAvailable(ok) { q('[data-role="pip"]').hidden = !ok; },
    setSkip(seg) {
      const b = q('.lp-skip');
      if (!seg) { b.hidden = true; return; }
      const wasHidden = b.hidden;
      if (wasHidden || b.dataset.kind !== seg.kind) { b.dataset.kind = seg.kind; b.innerHTML = LI.skip + '<span>' + esc(SKIP_LABEL[seg.kind]) + '</span>'; }
      b.hidden = false;
      // Focus prêt pour la télécommande (Entrée) dès l'apparition, sans voler le focus d'un panneau ou d'une fenêtre ouverts.
      if (wasHidden && !panelName && !document.querySelector('#modal:not([hidden])')) b.focus({ preventScroll: true });
    },
    /** Carte « épisode suivant » : { title, still, countdown, ratio }. */
    setNextCard(card) {
      const el = q('.lp-next');
      if (!card) { el.hidden = true; el.dataset.key = ''; return; }
      const key = [card.title, card.still, card.countdown].join('|');
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        const r = 20;
        const c = 2 * Math.PI * r;
        const ring = card.countdown !== null
          ? '<span class="lp-ring" aria-label="Lancement dans ' + card.countdown + ' secondes"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="' + r + '" class="lp-ring-bg"/><circle cx="24" cy="24" r="' + r + '" class="lp-ring-fg" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - card.ratio)).toFixed(1) + '" transform="rotate(-90 24 24)"/></svg><b>' + card.countdown + '</b></span>'
          : '';
        el.innerHTML = '<span class="lp-next-still">' + (card.still ? '<img src="' + esc(card.still) + '" alt="">' : '') + ring + '</span>' +
          '<div class="lp-next-body"><p class="lp-next-k">Épisode suivant</p><p class="lp-next-t">' + esc(card.title) + '</p>' +
          '<div class="lp-next-actions"><button type="button" class="btn btn-primary" data-act="next">' + LI.next + 'Lire maintenant</button><button type="button" class="btn btn-ghost" data-act="next-dismiss">Regarder le générique</button></div></div>';
      }
      el.hidden = false;
    },
    /** Films, au générique : « Plus d'infos » et « Recommandés ». */
    setEndRow(show) {
      const el = q('.lp-endrow');
      if (!show) { el.hidden = true; return; }
      if (el.hidden) el.innerHTML = '<p class="lp-next-k">Terminé ?</p><div><button type="button" class="btn btn-primary" data-act="more-info">Plus d’infos</button><button type="button" class="btn btn-ghost" data-act="recs">Recommandés</button><button type="button" class="btn btn-ghost" data-act="end-dismiss">Regarder le générique</button></div>';
      el.hidden = false;
    },
    setResume(pos) {
      const el = q('.lp-resume');
      if (pos === null) { el.hidden = true; return; }
      el.innerHTML = '<p>Tu en étais à <strong>' + formatClock(pos) + '</strong></p><div><button type="button" class="btn btn-primary" data-act="resume">Reprendre à ' + formatClock(pos) + '</button><button type="button" class="btn btn-ghost" data-act="restart">Recommencer</button></div>';
      el.hidden = false;
      const b = el.querySelector('[data-act="resume"]');
      if (b) b.focus({ preventScroll: true });
    },
    setCue(htmlText, style) {
      const el = q('.lp-subs');
      el.className = 'lp-subs bg-' + style.background + ' c-' + style.color;
      el.style.bottom = style.position + '%';
      el.style.setProperty('--subsize', String(style.size / 100));
      if (el.dataset.html !== htmlText) { el.dataset.html = htmlText; el.innerHTML = htmlText ? '<span>' + htmlText + '</span>' : ''; }
    },
    /** Message bref ; `action` { label, run } ajoute un bouton (ex. « Annuler »). */
    toast(msg, ms = 3200, action) {
      const t = q('.lp-toast');
      q('.lp-toast-t').textContent = msg;
      const a = q('.lp-toast-a');
      a.hidden = !action;
      a.onclick = action ? () => { t.classList.remove('is-on'); action.run(); } : null;
      if (action) a.textContent = action.label;
      t.classList.add('is-on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
    },
    togglePanel(name) {
      const real = PANEL_ALIAS[name] || name;
      const explicit = name === 'audio' || name === 'subtitles';
      if (explicit) focusCol = name === 'audio' ? 'audio' : 'subs';
      if (panelName === real) { if (explicit) api.focusColumn(focusCol); else api.closePanel(); } else api.openPanel(name);
    },
    openPanel(name) {
      const real = PANEL_ALIAS[name] || name;
      if (name === 'audio' || name === 'subtitles') focusCol = name === 'audio' ? 'audio' : 'subs';
      panelName = real;
      panel.hidden = false;
      root.classList.add('has-panel', 'is-ui');
      h.panelOpened(real);
      renderPanel();
      if (real === 'tracks') api.focusColumn(focusCol);
      else {
        const first = panel.querySelector('.is-on') || panel.querySelector('button:not([disabled])');
        if (first) first.focus({ preventScroll: true });
      }
    },
    focusColumn(col) {
      const c = panel.querySelector('[data-col="' + col + '"]');
      const t = c && (c.querySelector('.lp-opt.is-on') || c.querySelector('button:not([disabled])'));
      if (t) t.focus({ preventScroll: true });
    },
    refreshPanel() { if (panelName) renderPanel(); },
    closePanel(silent) {
      if (!panelName) return;
      panelName = null;
      panel.hidden = true;
      panel.innerHTML = '';
      root.classList.remove('has-panel');
      if (!silent) api.focusFirst();
    },
    /** Déplacement au clavier / à la télécommande dans le panneau ouvert. */
    navPanel(dir) {
      const items = Array.from(panel.querySelectorAll('button:not([disabled]), select'));
      if (!items.length) return;
      const cur = document.activeElement;
      const i = items.indexOf(cur);
      const step = dir === 'up' || dir === 'left' ? -1 : 1;
      const horizontal = cur && (cur.classList.contains('lp-chip') || cur.tagName === 'SELECT');
      if (horizontal && (dir === 'left' || dir === 'right')) {
        const sib = items[i + step];
        if (sib && sib.classList.contains('lp-chip')) sib.focus();
        return;
      }
      if (dir === 'left' || dir === 'right') {
        if (panelName === 'tracks' && cur) {
          const col = cur.closest('[data-col]');
          const want = dir === 'left' ? 'audio' : 'subs';
          if (col && col.dataset.col !== want) { api.focusColumn(want); return; }
          if (dir === 'right') return;
        }
        if (dir === 'left') api.closePanel();
        return;
      }
      // Haut / bas : reste dans la colonne courante pour le panneau à deux colonnes.
      const colEl = panelName === 'tracks' && cur ? cur.closest('[data-col]') : null;
      const scope = colEl ? Array.from(colEl.querySelectorAll('button:not([disabled])')) : items;
      const j = scope.indexOf(cur);
      scope[(j + step + scope.length) % scope.length].focus();
    },
  };
  panel.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (b && b.dataset.act === 'panel-close') { e.stopPropagation(); api.closePanel(); }
  });
  return api;
}
