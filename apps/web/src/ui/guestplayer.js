/* Commandes de la page invitée d'une watch party : overlay posé sur le cadre vidéo `stage` (le plein écran s'applique au cadre).
 * Habillage repris du lecteur principal (classes `lp-*` de player-ui.css / player.css, icônes `LI` de player/icons.js).
 * Le composant ne parle ni au salon ni au lecteur : il affiche l'état qu'on lui donne (setState, setInfo…) et transmet les
 * actions de l'invité (handlers). Aucune URL ni jeton ici. */
import { LI } from '../player/icons.js';
import { formatClock } from '../player/progress';

/** Les commandes se masquent après ce délai sans mouvement (souris, doigt, clavier) ; la pause les garde affichées. */
export const IDLE_MS = 3000;
/** Deux clics sur la vidéo à moins de ce délai : plein écran (le premier clic a déjà basculé la lecture). */
export const DOUBLE_MS = 320;
/** Pas des flèches et des boutons de saut, en secondes. */
export const KEY_SEEK_S = 5;
export const BUTTON_SEEK_S = 10;

/** Lignes du panneau « i » : clé du champ, libellé. */
const INFO_ROWS = [
  ['rate', 'Débit'],
  ['bytesHost', 'Reçu de l’hôte'],
  ['bytesPeers', 'Reçu des pairs'],
  ['videoCodec', 'Vidéo'],
  ['audioCodec', 'Audio'],
  ['bufferAhead', 'Tampon'],
];
const DASH = '—';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const num = (n) => (isNum(n) ? n : 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const fmtMb = (bytes) => (isNum(bytes) ? (bytes / 1048576).toFixed(1).replace('.', ',') + ' Mo' : DASH);
const fmtRate = (bps) => (isNum(bps) ? fmtMb(bps) + '/s' : DASH);
const fmtCodec = (name) => (typeof name === 'string' && name.trim() ? name.trim().toUpperCase() : DASH);
const fmtSecs = (s) => (isNum(s) && s >= 0 ? Math.round(s) + ' s' : DASH);
const INFO_FMT = {
  rate: (i) => fmtRate(i.rate),
  bytesHost: (i) => fmtMb(i.bytesHost),
  bytesPeers: (i) => fmtMb(i.bytesPeers),
  videoCodec: (i) => fmtCodec(i.videoCodec),
  audioCodec: (i) => fmtCodec(i.audioCodec),
  bufferAhead: (i) => fmtSecs(i.bufferAhead),
};

/** Bouton icône du lecteur (même classes que le lecteur principal). Libellés fixes, icônes SVG fixes : rien d'externe. */
const iconBtn = (role, icon, label, cls = '', extra = '') =>
  '<button type="button" class="lp-btn lp-btn-s' + (cls ? ' ' + cls : '') + '" data-gp="' + role + '" aria-label="' + label + '" data-tip="' + label + '"' + extra + '>' + icon + '</button>';

function skeleton() {
  const infoDl = INFO_ROWS.map(([k, label]) => '<dt>' + label + '</dt><dd data-gp-info="' + k + '">' + DASH + '</dd>').join('');
  return '<div class="gp-subs" aria-hidden="true"></div>' +
    '<div class="gp-side"></div>' +
    '<div class="gp-wait" role="status" hidden><span class="lp-spin" aria-hidden="true"></span><span class="gp-wait-t"></span></div>' +
    '<span class="lp-spin gp-spin" aria-hidden="true" hidden></span>' +
    '<button type="button" class="lp-btn gp-center" data-gp="center" aria-label="Lecture (Espace)" hidden>' + LI.play + '</button>' +
    '<div class="gp-info" role="dialog" aria-label="Infos de lecture" hidden><h3>Infos de lecture</h3><dl>' + infoDl + '</dl></div>' +
    '<div class="gp-ui">' +
      '<div class="lp-seek" data-gp="seek" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-disabled="true">' +
        '<div class="lp-track"><span class="lp-buf"></span><span class="lp-played"></span></div><span class="lp-thumb"></span>' +
        '<span class="lp-hover" hidden></span>' +
      '</div>' +
      '<div class="lp-row">' +
        '<div class="lp-grp">' +
          iconBtn('play', LI.play, 'Lecture (Espace)') +
          iconBtn('back', LI.back10, 'Reculer de 10 s', 'gp-skip') +
          iconBtn('fwd', LI.fwd10, 'Avancer de 10 s', 'gp-skip') +
          '<span class="lp-vol" data-gp="vol" hidden>' + iconBtn('mute', LI.vol, 'Couper le son (M)') +
            '<input class="lp-vslider" data-gp="volume" type="range" min="0" max="100" step="5" value="100" aria-label="Volume"></span>' +
          '<span class="lp-time gp-time" data-gp="time">0:00 / 0:00</span>' +
        '</div>' +
        '<div class="lp-grp gp-grp-r"><span class="gp-menu"></span>' +
          iconBtn('info', LI.info, 'Infos de lecture', '', ' aria-expanded="false"') +
          iconBtn('full', LI.full, 'Plein écran (F)') +
        '</div>' +
      '</div>' +
    '</div>';
}

/**
 * Crée les commandes dans `stage` (conteneur vidéo). Retourne l'API ; `destroy()` retire l'overlay et les écouteurs.
 * handlers : { onPlay(), onPause(), onSeek(positionSeconds), onVolume(0..1), onMute(muted: boolean) }.
 * Volume et sourdine ne s'affichent que si `onVolume` ou `onMute` est fourni (sinon il n'y a rien à régler).
 */
export function createGuestControls(stage, handlers = {}) {
  const doc = stage.ownerDocument;
  const h = handlers || {};
  const canVolume = typeof h.onVolume === 'function' || typeof h.onMute === 'function';
  const fsSupported = typeof stage.requestFullscreen === 'function';
  const fsActive = () => doc.fullscreenElement === stage;

  /** État du lecteur (fourni par setState). */
  const st = { playing: false, position: 0, duration: 0, ready: false };
  const vol = { volume: 1, muted: false };
  let info = {};
  let infoOpen = false;
  let dragging = false;
  let destroyed = false;
  let idleTimer = null;
  let lastTap = 0;
  let lastPointer = 'mouse';
  const listeners = [];
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  const root = doc.createElement('div');
  root.className = 'gp';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Commandes du lecteur');
  root.innerHTML = skeleton();
  stage.appendChild(root);
  stage.classList.add('gp-host', 'is-ui');

  const $ = (sel) => root.querySelector(sel);
  const el = {
    subs: $('.gp-subs'), side: $('.gp-side'), wait: $('.gp-wait'), waitText: $('.gp-wait-t'), spin: $('.gp-spin'),
    center: $('[data-gp="center"]'), info: $('.gp-info'), infoBtn: $('[data-gp="info"]'), seek: $('[data-gp="seek"]'),
    played: $('.lp-played'), buffer: $('.lp-buf'), thumb: $('.lp-thumb'), hover: $('.lp-hover'), play: $('[data-gp="play"]'),
    back: $('[data-gp="back"]'), fwd: $('[data-gp="fwd"]'), volBox: $('[data-gp="vol"]'), mute: $('[data-gp="mute"]'),
    volume: $('[data-gp="volume"]'), time: $('[data-gp="time"]'), menu: $('.gp-menu'), full: $('[data-gp="full"]'),
  };
  const infoVals = {};
  for (const [k] of INFO_ROWS) infoVals[k] = root.querySelector('[data-gp-info="' + k + '"]');

  const canSeek = () => st.ready && st.duration > 0;

  // ---------- Affichage ----------
  function render() {
    const dur = st.duration;
    const frac = dur > 0 ? clamp(st.position / dur, 0, 1) : 0;
    el.played.style.width = frac * 100 + '%';
    el.thumb.style.left = frac * 100 + '%';
    const ahead = info.bufferAhead;
    const bufFrac = dur > 0 && isNum(ahead) ? clamp((st.position + Math.max(0, ahead)) / dur, 0, 1) : 0;
    el.buffer.style.width = bufFrac * 100 + '%';
    el.seek.setAttribute('aria-valuemax', String(Math.round(dur)));
    el.seek.setAttribute('aria-valuenow', String(Math.round(st.position)));
    el.seek.setAttribute('aria-valuetext', formatClock(st.position));
    el.seek.setAttribute('aria-disabled', String(!st.ready));
    el.time.textContent = formatClock(st.position) + ' / ' + formatClock(dur);
    const label = st.playing ? 'Pause (Espace)' : 'Lecture (Espace)';
    el.play.innerHTML = st.playing ? LI.pause : LI.play;
    el.play.setAttribute('aria-label', label);
    el.play.dataset.tip = label;
    el.center.hidden = st.playing || !st.ready;
    for (const b of [el.play, el.back, el.fwd, el.center]) b.disabled = !st.ready;
    el.full.innerHTML = fsActive() ? LI.fullExit : LI.full;
    el.full.setAttribute('aria-label', fsActive() ? 'Quitter le plein écran (F)' : 'Plein écran (F)');
    el.full.hidden = !fsSupported;
    el.mute.innerHTML = vol.muted || vol.volume === 0 ? LI.mute : LI.vol;
    el.mute.classList.toggle('is-active', vol.muted);
    el.volume.value = String(Math.round(vol.volume * 100));
  }

  function renderInfo() {
    for (const [k] of INFO_ROWS) infoVals[k].textContent = INFO_FMT[k](info);
  }

  // ---------- Masquage automatique ----------
  /** Réaffiche les commandes et relance le compte à rebours (sans effet sur la pause, qui les garde). */
  function show() {
    if (destroyed) return;
    stage.classList.add('is-ui');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idleHide, IDLE_MS);
  }

  function idleHide() {
    idleTimer = null;
    if (destroyed || !st.playing || dragging || infoOpen) return;
    // Un curseur ou un champ focalisé au clavier garde les commandes visibles.
    const a = doc.activeElement;
    if (a && (a === el.seek || a === el.volume)) return;
    stage.classList.remove('is-ui');
  }

  // ---------- Actions ----------
  function togglePlay() {
    if (!st.ready) return;
    if (st.playing) h.onPause?.();
    else h.onPlay?.();
  }

  function seekTo(t) {
    if (!canSeek()) return;
    const target = clamp(t, 0, st.duration);
    // Affichage immédiat ; le prochain état du salon le recale.
    st.position = target;
    render();
    h.onSeek?.(target);
  }

  function seekBy(delta) {
    if (!canSeek()) return;
    seekTo(st.position + delta);
  }

  function setMuted(muted) {
    if (!canVolume) return;
    vol.muted = muted;
    render();
    h.onMute?.(muted);
  }

  function toggleInfo(force) {
    infoOpen = typeof force === 'boolean' ? force : !infoOpen;
    el.info.hidden = !infoOpen;
    el.infoBtn.setAttribute('aria-expanded', String(infoOpen));
    if (infoOpen) show();
  }

  function toggleFullscreen() {
    if (!fsSupported && !fsActive()) return;
    try {
      const p = fsActive() ? doc.exitFullscreen?.() : stage.requestFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      // plein écran refusé par le navigateur : rien à faire
    }
  }

  // ---------- Écouteurs ----------
  on(stage, 'pointerdown', (e) => {
    lastPointer = e.pointerType || 'mouse';
    if (lastPointer !== 'touch') show();
  });
  on(stage, 'pointermove', (e) => {
    if (e.pointerType !== 'touch') show();
  });
  on(stage, 'focusin', () => show());

  // Clic sur la vidéo : bascule lecture (souris) ou commandes (doigt). Deux clics rapides : plein écran.
  on(stage, 'click', (e) => {
    if (destroyed) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('.gp-ui, .gp-info, .gp-side, .gp-center, button, input, [role="slider"]')) return;
    if (infoOpen) toggleInfo(false);
    const now = Date.now();
    const dbl = now - lastTap < DOUBLE_MS;
    lastTap = dbl ? 0 : now;
    if (dbl) {
      toggleFullscreen();
      return;
    }
    if (lastPointer === 'touch') {
      if (stage.classList.contains('is-ui') && st.playing) stage.classList.remove('is-ui');
      else show();
      return;
    }
    togglePlay();
  });

  on(el.play, 'click', togglePlay);
  on(el.center, 'click', togglePlay);
  on(el.back, 'click', () => seekBy(-BUTTON_SEEK_S));
  on(el.fwd, 'click', () => seekBy(BUTTON_SEEK_S));
  on(el.mute, 'click', () => setMuted(!vol.muted));
  on(el.volume, 'input', () => {
    vol.volume = Number(el.volume.value) / 100;
    render();
    h.onVolume?.(vol.volume);
  });
  on(el.infoBtn, 'click', () => toggleInfo());
  on(el.full, 'click', toggleFullscreen);

  // Barre de progression : clic ou glissé = saut à la position relevée au relâchement.
  const frac = (e) => {
    const r = el.seek.getBoundingClientRect();
    return clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
  };
  const previewAt = (f) => {
    el.played.style.width = f * 100 + '%';
    el.thumb.style.left = f * 100 + '%';
  };
  const hoverAt = (f) => {
    el.hover.hidden = false;
    el.hover.textContent = formatClock(f * st.duration);
    el.hover.style.left = f * 100 + '%';
  };
  on(el.seek, 'pointerdown', (e) => {
    if (!canSeek()) return;
    dragging = true;
    try {
      el.seek.setPointerCapture?.(e.pointerId);
    } catch {
      // capture indisponible : le glissé reste mesuré sur la barre
    }
    previewAt(frac(e));
    show();
  });
  on(el.seek, 'pointermove', (e) => {
    if (!canSeek()) return;
    const f = frac(e);
    hoverAt(f);
    if (dragging) previewAt(f);
  });
  on(el.seek, 'pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    seekTo(frac(e) * st.duration);
  });
  on(el.seek, 'pointercancel', () => {
    dragging = false;
    render();
  });
  on(el.seek, 'pointerleave', () => {
    if (!dragging) el.hover.hidden = true;
  });

  // Raccourcis : Espace / K lecture-pause, flèches ±5 s, F plein écran, M muet, Échap ferme « i ».
  // Ignorés pendant la saisie (pseudo, curseur de volume) et quand le cadre est masqué par la page.
  on(doc, 'keydown', (e) => {
    if (destroyed || e.ctrlKey || e.altKey || e.metaKey || stage.closest('[hidden]')) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onButton = !!(t && t.closest('button, a[href]'));
    let action = '';
    switch (e.key) {
      case ' ':
        if (onButton) return;
        action = 'toggle';
        break;
      case 'k': case 'K': action = 'toggle'; break;
      case 'ArrowLeft': action = 'left'; break;
      case 'ArrowRight': action = 'right'; break;
      case 'f': case 'F': action = 'full'; break;
      case 'm': case 'M': action = 'mute'; break;
      case 'Escape':
        if (!infoOpen) return;
        action = 'info';
        break;
      default:
        return;
    }
    e.preventDefault();
    show();
    if (action === 'toggle') togglePlay();
    else if (action === 'left') seekBy(-KEY_SEEK_S);
    else if (action === 'right') seekBy(KEY_SEEK_S);
    else if (action === 'full') toggleFullscreen();
    else if (action === 'mute') setMuted(!vol.muted);
    else if (action === 'info') toggleInfo(false);
  });

  on(doc, 'fullscreenchange', () => {
    show();
    render();
  });

  render();
  renderInfo();
  el.volBox.hidden = !canVolume;

  // ---------- API ----------
  /** Met à jour lecture, position, durée et disponibilité des commandes. Les champs absents gardent leur valeur. */
  function setState(patch = {}) {
    if (destroyed) return;
    const wasPlaying = st.playing;
    if ('playing' in patch) st.playing = !!patch.playing;
    if ('ready' in patch) st.ready = !!patch.ready;
    if ('position' in patch) st.position = num(patch.position);
    if ('duration' in patch) st.duration = num(patch.duration);
    if (!st.playing) {
      clearTimeout(idleTimer);
      idleTimer = null;
      stage.classList.add('is-ui');
    } else if (!wasPlaying) {
      show();
    }
    render();
  }

  /** Panneau « i » : débit, octets reçus de l'hôte et des pairs, codecs, tampon (s). Un champ absent s'affiche « — ». */
  function setInfo(next = {}) {
    if (destroyed) return;
    info = { ...info, ...next };
    renderInfo();
    render();
  }

  /** Bandeau central « En attente de… » ; `null` ou vide le retire. */
  function setWait(text) {
    el.wait.hidden = !text;
    el.waitText.textContent = text || '';
  }

  /** Spinner central pendant la mise en tampon. */
  function setBuffering(on) {
    el.spin.hidden = !on;
  }

  /** Volume et sourdine affichés (sans appel de handler). */
  function setVolume({ volume, muted } = {}) {
    if (isNum(volume)) vol.volume = clamp(volume, 0, 1);
    if (typeof muted === 'boolean') vol.muted = muted;
    render();
  }

  /** Bouton ajouté au groupe de droite (ex. Sous-titres). `icon` est un SVG fixe ; `label` sert d'infobulle et d'étiquette. */
  function addMenuButton({ id, icon, label, onClick } = {}) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'lp-btn lp-btn-s';
    b.dataset.gp = 'menu';
    b.dataset.id = String(id ?? '');
    b.setAttribute('aria-label', String(label ?? ''));
    b.dataset.tip = String(label ?? '');
    b.innerHTML = icon || '';
    b.addEventListener('click', () => {
      if (!destroyed) onClick?.();
    });
    el.menu.appendChild(b);
    return b;
  }

  /** Pastille de messages non lus sur le bouton d'identifiant « chat » (ajouté avec addMenuButton). 0 la retire. */
  function setChatBadge(n) {
    const b = el.menu.querySelector('[data-id="chat"]');
    if (!b) return;
    let badge = b.querySelector('.gp-badge');
    if (!badge) {
      badge = doc.createElement('span');
      badge.className = 'gp-badge';
      b.appendChild(badge);
    }
    const count = Math.max(0, Math.floor(Number(n) || 0));
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(idleTimer);
    idleTimer = null;
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners.length = 0;
    try {
      if (fsActive() && typeof doc.exitFullscreen === 'function') void doc.exitFullscreen()?.catch?.(() => undefined);
    } catch {
      // sortie du plein écran impossible : sans effet
    }
    root.remove();
    stage.classList.remove('gp-host', 'is-ui');
  }

  return {
    root,
    /** Calque des sous-titres (bas-centre, il remonte quand les commandes sont visibles). */
    subtitleLayer: el.subs,
    /** Emplacement d'un tiroir latéral (chat) à droite, au-dessus de la barre. */
    sideSlot: el.side,
    setState,
    setInfo,
    setWait,
    setBuffering,
    setVolume,
    addMenuButton,
    setChatBadge,
    show,
    destroy,
  };
}
