/* Interface du lecteur plein écran, dans l'esprit Netflix / Nuvio : barre haute (retour, titre, icônes), boutons centraux,
 * barre de position fine qui s'épaissit au survol, pastilles de saut, carte « épisode suivant » avec compte à rebours,
 * panneaux latéraux (épisodes ; audio et sous-titres sur deux colonnes ; vitesse ; infos), écran de pause.
 * Aucune logique de lecture ici : tout passe par les gestionnaires `h` fournis par session.js. */
import { esc } from '../ui/util.js';
import { LI } from './icons.js';
import { clampTooltip } from './thumbs';
import { episodesHtml, head, infoHtml, settingsHtml, tracksHtml } from './panels.js';
import { bindEpisodeFold } from './epfold.js';
import { formatClock } from './progress';
import { skipLabel } from './skip';
import { createMiniView } from './miniview.js';

const btn = (act, icon, label, extra = '', cls = '') => '<button type="button" class="lp-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" aria-label="' + esc(label) + '" data-tip="' + esc(label) + '"' + extra + '>' + icon + '</button>';
const tbtn = (act, icon, label, extra = '') => '<button type="button" class="lp-tbtn" data-act="' + act + '"' + extra + '>' + icon + '<span>' + esc(label) + '</span></button>';
const PANEL_ALIAS = { audio: 'tracks', subtitles: 'tracks', speed: 'settings' };
const REMAIN_KEY = 'laststream.player.remaining';
const MARK_LABEL = { intro: 'Intro', recap: 'Récap', credits: 'Générique', postcredits: 'Scène post-générique', preview: 'Aperçu' };

function skeleton() {
  return '<video class="lp-video" playsinline></video>' +
    '<div class="lp-subs" aria-hidden="true"></div>' +
    '<div class="lp-pause" hidden><div class="lp-pause-in"><p class="lp-pause-k">Vous regardez</p><div class="lp-pause-logo"></div><p class="lp-pause-ep"></p><p class="lp-pause-syn"></p></div></div>' +
    '<div class="lp-bspin" aria-hidden="true"></div>' +
    '<div class="lp-loading" role="status"><div class="lp-load-bg"></div><div class="lp-load-in">' +
      '<div class="lp-lring" aria-hidden="true"><svg viewBox="0 0 64 64"><circle class="lp-lring-bg" cx="32" cy="32" r="28"/><circle class="lp-lring-fg" cx="32" cy="32" r="28" stroke-dasharray="175.9" stroke-dashoffset="132"/></svg></div>' +
      '<div class="lp-load-logo"></div><p class="lp-load-ep"></p><p class="lp-load-msg"></p><p class="lp-load-src"></p><ol class="lp-steps"></ol>' +
      '<button type="button" class="btn btn-primary lp-self" data-act="choose-myself" hidden>Choisir moi-même</button>' +
      '<button type="button" class="btn btn-ghost lp-cancel" data-act="close">Annuler</button></div></div>' +
    '<div class="lp-error" role="alert" hidden><p class="lp-err-title"></p><p class="lp-err-msg"></p><div class="lp-err-actions"></div></div>' +
    '<div class="lp-top">' +
      btn('close', LI.back, 'Retour (Échap)', ' data-role="back"', 'lp-close') +
      '<div class="lp-heading"><p class="lp-title"></p><p class="lp-sub"></p></div>' +
      '<div class="lp-top-r">' + btn('party', LI.people, 'Watch party', ' data-role="party" hidden') + btn('minimize', LI.mini, 'Réduire le lecteur (I)', ' data-role="mini" hidden') + btn('info', LI.info, 'Infos') + btn('pip', LI.pip, 'Image dans l’image (P)', ' data-role="pip"') + btn('panel:settings', LI.gear, 'Réglages (vitesse, options)', ' data-role="speed"') + '</div>' +
    '</div>' +
    '<div class="lp-center">' +
      btn('back10', LI.back10, 'Reculer de 10 s', '', 'lp-big') + btn('toggle-play', LI.play, 'Lecture / pause (Espace)', ' data-role="bigplay"', 'lp-big lp-huge') + btn('fwd10', LI.fwd10, 'Avancer de 10 s', '', 'lp-big') +
    '</div>' +
    '<div class="lp-ripple lp-ripple-l" hidden>−10 s</div><div class="lp-ripple lp-ripple-r" hidden>+10 s</div>' +
    '<button type="button" class="lp-skip" data-act="skip" hidden></button><button type="button" class="lp-skipno" data-act="skip-wrong" hidden></button>' +
    '<div class="lp-next" hidden></div>' +
    '<div class="lp-endrow" hidden></div>' +
    '<div class="lp-resume" role="dialog" aria-label="Reprise" hidden></div>' +
    '<div class="lp-bottom">' +
      '<div class="lp-seek" data-seek role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
        '<div class="lp-track"><span class="lp-buf"></span><span class="lp-played"></span><span class="lp-marks"></span></div>' +
        '<span class="lp-thumb"></span><span class="lp-hover" hidden><canvas class="lp-hover-c" width="240" height="135" hidden></canvas><img class="lp-hover-i" alt="" hidden><b class="lp-hover-t"></b><i class="lp-hover-s"></i></span>' +
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
  const mini = createMiniView(root, { state: h.miniState, action: (act, d) => h.action(act, d), layout: (video, lay) => h.miniLayout(video, lay) });
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
  let markList = [];

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
    // Mini-lecteur : un contrôle de la vignette agit, le reste de la vignette ramène au plein lecteur.
    if (root.classList.contains('is-mini')) {
      const m = t.closest('[data-act]');
      if (m && !m.disabled) h.action(m.dataset.act, m.dataset); else h.action('expand');
      return;
    }
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
  const hoverT = q('.lp-hover-t');
  const hoverS = q('.lp-hover-s');
  let previewTimer = null;
  let loadTimer = null;
  /** Cadre d'aperçu au-dessus de la barre, à la fraction `f` : image (si disponible), heure et nom du segment. */
  function showHover(f, time) {
    if (!last || !last.duration) return;
    const r = seek.getBoundingClientRect();
    const seg = markList.find((m) => f >= m.from && f <= m.to);
    hover.hidden = false;
    hoverT.textContent = formatClock(time);
    hoverS.textContent = seg ? MARK_LABEL[seg.kind] : '';
    hover.style.left = clampTooltip(f * r.width, r.width, hover.offsetWidth || 120) + 'px';
    if (h.thumb) h.thumb(time);
  }
  function hideHover() {
    hover.hidden = true;
    if (h.thumbCancel) h.thumbCancel();
  }
  function previewSeek(f) {
    q('.lp-played').style.width = f * 100 + '%';
    q('.lp-thumb').style.left = f * 100 + '%';
  }
  seek.addEventListener('pointermove', (e) => {
    if (!last || !last.duration) return;
    const f = frac(e);
    showHover(f, f * last.duration);
    if (dragging) previewSeek(f);
  });
  seek.addEventListener('pointerleave', () => { if (!dragging) hideHover(); });
  seek.addEventListener('pointerdown', (e) => {
    if (!last || !last.duration) return;
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    previewSeek(frac(e));
  });
  seek.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    hideHover();
    if (last && last.duration) h.seekTo(frac(e) * last.duration);
  });
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.stopPropagation(); h.action(e.key === 'ArrowLeft' ? 'back10' : 'fwd10'); e.preventDefault(); }
  });
  vs.addEventListener('input', () => h.setVolume(Number(vs.value) / 100));
  vs.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); });

  // ---------- Panneaux (HTML dans panels.js) ----------
  const focusKeyOf = (el) => (el.dataset ? [el.dataset.act, el.dataset.id, el.dataset.key, el.dataset.val, el.dataset.by, el.dataset.rate, el.dataset.season, el.dataset.episode, el.tagName === 'SELECT' || el.tagName === 'INPUT' ? el.tagName : '', el.dataset.kind, el.dataset.seen].join('|') : '');

  function renderPanel() {
    if (!panelName || panelName === 'sources') return;
    const d = h.panelData(panelName);
    const html = panelName === 'tracks' ? tracksHtml(d) : panelName === 'episodes' ? episodesHtml(d) : panelName === 'settings' ? settingsHtml(d) : infoHtml(d);
    const keep = Array.from(panel.querySelectorAll('.lp-list, .lp-scroll, .lp-col')).map((l) => l.scrollTop);
    const act = document.activeElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = act ? focusKeyOf(act) : null;
    const caret = act && act.matches('.lp-search') ? act.selectionStart : null;
    panel.innerHTML = html;
    panel.className = 'lp-panel' + (panelName === 'tracks' ? ' is-wide' : panelName === 'episodes' ? ' is-eps' : '');
    panel.querySelectorAll('.lp-list, .lp-scroll, .lp-col').forEach((l, i) => { if (keep[i]) l.scrollTop = keep[i]; });
    if (focusKey) {
      const again = Array.from(panel.querySelectorAll('button:not([disabled]), select, input')).find((b) => focusKeyOf(b) === focusKey);
      if (again) {
        again.focus({ preventScroll: true });
        if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret);
      }
    }
  }
  panel.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement) h.action('season', { season: e.target.value });
  });
  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.dataset.input) h.action(t.dataset.input, { q: t.value });
  });
  panel.addEventListener('toggle', (e) => {
    if (e.target instanceof HTMLDetailsElement) h.action('style-open', { open: e.target.open ? '1' : '0' });
  }, true);

  const api = {
    root,
    video,
    thumbCanvas: q('.lp-hover-c'),
    thumbImg: q('.lp-hover-i'),
    /** Aperçu au clavier : montre le cadre à `time` un instant (saut de 10 s, flèches sur la barre). */
    previewTime(time, ms = 1300) {
      if (!last || !last.duration) return;
      showHover(Math.min(1, Math.max(0, time / last.duration)), time);
      clearTimeout(previewTimer);
      previewTimer = setTimeout(hideHover, ms);
    },
    get panel() { return panelName; },
    show() { root.hidden = false; root.classList.add('is-ui'); wake(); },
    hide() { root.hidden = true; api.closePanel(true); api.setPauseScreen(null); },
    isOpen: () => !root.hidden,
    wake,
    focusFirst() { const c = q('[data-role="play"]'); if (c) c.focus({ preventScroll: true }); },
    setHeading(title, sub) { q('.lp-title').textContent = title || ''; q('.lp-sub').textContent = sub || ''; mini.setTitle(title, sub); },
    /** Mini-lecteur : vignette en bas à droite (ou barre mobile) à la place du plein écran. */
    setMini(on) {
      if (on) { api.closePanel(true); mini.enter(); } else mini.leave();
    },
    /** Reprend la géométrie du mini-lecteur (moteur mpv choisi ou quitté pendant la réduction). */
    relayoutMini() { mini.relayout(); },
    isMini: () => mini.active,
    /** « Watch party » : compte connecté seulement (la visibilité des salons publics se règle dans le panneau). */
    setPartyAvailable(ok) { q('[data-role="party"]').hidden = !ok; },
    /** Le bouton « Réduire » n'existe pas partout (lecteur natif Android : le PiP système suffit). */
    setMiniAvailable(ok) {
      q('[data-role="mini"]').hidden = !ok;
      const back = q('[data-role="back"]');
      back.dataset.act = ok ? 'minimize' : 'close';
      const label = ok ? 'Réduire le lecteur' : 'Retour (Échap)';
      back.setAttribute('aria-label', label);
      back.dataset.tip = label;
    },
    /**
     * Chargeur. `extra` : { logo, backdrop, episode, source, steps, step, cancel }. Avec `steps`, l'anneau se remplit à chaque
     * étape (sources trouvées, choix, préparation du lien) ; sans, il tourne.
     */
    setLoading(title, msg, extra) {
      const el = q('.lp-loading');
      clearTimeout(loadTimer);
      if (!title && !msg) {
        // Sortie en fondu : la carte disparaît, puis les contrôles prennent la place.
        if (!el.hidden) {
          el.classList.add('is-out');
          loadTimer = setTimeout(() => { el.hidden = true; el.classList.remove('is-out'); }, 380);
        }
        return;
      }
      el.classList.remove('is-out');
      el.hidden = false;
      const e = extra || {};
      // Le titre en texte est déjà dans la barre haute : la carte n'affiche que le logo, s'il y en a un.
      q('.lp-load-logo').innerHTML = e.logo ? '<img src="' + esc(e.logo) + '" alt="' + esc(title || '') + '">' : '';
      q('.lp-load-ep').textContent = e.episode || '';
      q('.lp-load-msg').textContent = msg || '';
      q('.lp-load-src').textContent = e.source || '';
      q('.lp-load-bg').style.backgroundImage = e.backdrop ? 'url("' + e.backdrop + '")' : '';
      const steps = e.steps || [];
      q('.lp-steps').innerHTML = steps.map((t, i) => '<li class="' + (i < e.step ? 'is-done' : i === e.step ? 'is-active' : '') + '">' + (i < e.step ? LI.check : '<i></i>') + '<span>' + esc(t) + '</span></li>').join('');
      el.classList.toggle('is-det', steps.length > 0);
      q('.lp-lring-fg').style.strokeDashoffset = String(steps.length ? 175.9 * (1 - (e.step + 0.6) / steps.length) : 132);
      q('.lp-cancel').hidden = !e.cancel;
      q('.lp-self').hidden = !e.slow;
    },
    /** Fait défiler la liste d'épisodes jusqu'à l'épisode donné (0 : aucun) et lui donne le focus. */
    revealEpisode(n) {
      const row = n ? panel.querySelector('.lp-ep-row[data-ep="' + n + '"] .lp-ep') : null;
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.focus({ preventScroll: true });
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
      mini.update(st);
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
      q('[data-role="full"]').innerHTML = (st.fullscreen !== undefined ? st.fullscreen : document.fullscreenElement === root) ? LI.fullExit : LI.full;
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
    /** `loading` : seuls retour, titre et « Sources » restent visibles ; `ready` : les contrôles apparaissent puis se masquent seuls. */
    setPhase(phase) {
      root.classList.toggle('is-loading', phase === 'loading');
      root.classList.toggle('is-ready', phase === 'ready');
      if (phase === 'ready') wake();
      else { root.classList.add('is-ui'); clearTimeout(hideTimer); }
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
      markList = marks;
      el.innerHTML = marks.map((m) => '<i class="lp-mark lp-mark-' + m.kind + '" title="' + MARK_LABEL[m.kind] + '" style="left:' + m.from * 100 + '%;width:' + Math.max(0.4, (m.to - m.from) * 100) + '%"></i>').join('');
    },
    setSeries(isSeries, hasNext) {
      q('[data-role="episodes"]').hidden = !isSeries;
      q('[data-role="next"]').hidden = !hasNext;
    },
    setPipAvailable(ok) { q('[data-role="pip"]').hidden = !ok; },
    setSkip(seg) {
      const b = q('.lp-skip');
      if (!seg) { b.hidden = true; q('.lp-skipno').hidden = true; return; }
      const wasHidden = b.hidden;
      const key = seg.kind + (seg.inferred ? '?' : '');
      if (wasHidden || b.dataset.kind !== key) { b.dataset.kind = key; b.innerHTML = LI.skip + '<span>' + esc(skipLabel(seg)) + '</span>'; }
      const no = q('.lp-skipno');
      no.hidden = !seg.inferred;
      no.textContent = seg.kind === 'intro' ? 'Ce n’est pas l’intro' : seg.kind === 'recap' ? 'Ce n’est pas le récap' : 'Ce n’est pas ça';
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
          '<div class="lp-next-actions"><button type="button" class="btn btn-primary" data-act="next" aria-label="Lire maintenant l’épisode suivant">' + LI.next + 'Lire maintenant</button><button type="button" class="btn btn-ghost" data-act="next-dismiss" aria-label="Regarder le générique">Générique</button></div></div>';
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
    /** Sous-titre à l'écran. `bottomHtml` : second sous-titre (mode apprentissage) : la langue apprise (`htmlText`) en haut,
     * plus petite et en italique, la langue principale dessous. */
    setCue(htmlText, style, bottomHtml = '') {
      const el = q('.lp-subs');
      const dual = !!(htmlText && bottomHtml);
      el.className = 'lp-subs bg-' + style.background + ' c-' + style.color + (dual ? ' is-dual' : '');
      el.style.bottom = style.position + '%';
      el.style.setProperty('--subsize', String(style.size / 100));
      const key = htmlText + '\u0000' + bottomHtml;
      if (el.dataset.html === key) return;
      el.dataset.html = key;
      if (dual) el.innerHTML = '<span class="lp-sub-top">' + htmlText + '</span><span class="lp-sub-bot">' + bottomHtml + '</span>';
      else { const one = htmlText || bottomHtml; el.innerHTML = one ? '<span>' + one + '</span>' : ''; }
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
    /** Panneau dont le contenu est fourni par l'appelant (sélecteur de sources) ; renvoie l'élément hôte. */
    mountPanel(name, title) {
      panelName = name;
      panel.hidden = false;
      panel.className = 'lp-panel is-wide is-host';
      root.classList.add('has-panel', 'is-ui');
      panel.innerHTML = head(title) + '<div class="lp-host"></div>';
      return panel.querySelector('.lp-host');
    },
    refreshPanel() { if (panelName) renderPanel(); },
    closePanel(silent) {
      if (!panelName) return;
      const was = panelName;
      panelName = null;
      panel.hidden = true;
      panel.innerHTML = '';
      panel.className = 'lp-panel';
      root.classList.remove('has-panel');
      if (!silent) { api.focusFirst(); if (h.panelClosed) h.panelClosed(was); }
    },
    /** Déplacement au clavier / à la télécommande dans le panneau ouvert. */
    navPanel(dir) {
      if (panelName === 'sources') return;
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
  bindEpisodeFold(panel);
  return api;
}
