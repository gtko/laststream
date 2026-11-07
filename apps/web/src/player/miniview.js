/* Vue du mini-lecteur : le même élément #lsplayer (donc le même <video>, sans rechargement) devient une vignette fixe 16:9
 * en bas à droite (barre pleine largeur sous 640 px). Ici : boîte et position, glissement avec aimantation aux 4 coins,
 * contrôles de la vignette (lecture/pause, agrandir, fermer, progression) et accessibilité. La géométrie est dans mini.ts. */
import { LI } from './icons.js';
import { clampBox, holeClipFor, isBarLayout, miniLayout, snapCorner } from './mini';

const DRAG_THRESHOLD = 6;

const PLAIN_ROLE = { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lecteur vidéo' };

/**
 * `h` : { state: MiniState, action(act), layout(video | null, layout) }. `layout` reçoit le rectangle de l'image (px de la
 * fenêtre) à chaque changement de position ou de taille, `null` quand le mini-lecteur est quitté.
 */
export function createMiniView(root, h) {
  const bar = document.createElement('div');
  bar.className = 'lp-mini';
  bar.hidden = true;
  bar.innerHTML =
    '<button type="button" class="lp-mini-btn lp-mini-expand" data-act="expand" aria-label="Agrandir le lecteur (I)" title="Agrandir (I)">' + LI.expand + '</button>' +
    '<button type="button" class="lp-mini-btn lp-mini-close" data-act="close" aria-label="Fermer le lecteur" title="Fermer">' + LI.close + '</button>' +
    '<button type="button" class="lp-mini-btn lp-mini-play" data-act="toggle-play" aria-label="Lecture" title="Lecture / pause">' + LI.play + '</button>' +
    '<div class="lp-mini-info"><p class="lp-mini-title"></p><p class="lp-mini-sub"></p></div>' +
    '<div class="lp-mini-prog" role="progressbar" aria-label="Progression de la lecture" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>';
  root.appendChild(bar);
  const q = (s) => bar.querySelector(s);
  const playBtn = q('.lp-mini-play');
  const prog = q('.lp-mini-prog');
  let active = false;
  let title = '';
  let paused = null;
  let drag = null;
  let justDragged = false;
  let rafId = 0;
  let current = null;

  const win = () => ({ width: window.innerWidth || document.documentElement.clientWidth || 0, height: window.innerHeight || document.documentElement.clientHeight || 0 });

  function place(box, layout) {
    const s = root.style;
    s.left = box.left + 'px';
    s.top = box.top + 'px';
    s.width = box.width + 'px';
    s.height = box.height + 'px';
    s.setProperty('--mini-h', box.height + 'px');
    root.classList.toggle('is-bar', layout.bar);
    // Barre mobile + mpv : la barre est pleine, sauf le trou de l'image (mpv est dessous, la vignette doit rester transparente).
    s.clipPath = layout.bar && root.classList.contains('is-mpv') ? holeClipFor(layout.box, layout.video, 8) : '';
  }

  /** Recalcule la boîte pour le coin choisi (ou la barre) et prévient le moteur. */
  function layout() {
    if (!active) return;
    const w = win();
    current = miniLayout(w, h.state.corner);
    place(current.box, current);
    h.layout(current.video, current);
  }

  function moveTo(box) {
    const w = win();
    const bx = clampBox(box, w);
    const l = { box: bx, video: { ...bx }, bar: false };
    current = l;
    place(bx, l);
    if (rafId) return;
    const run = () => { rafId = 0; if (active && current) h.layout(current.video, current); };
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(run); else run();
  }

  function onPointerDown(e) {
    if (!active || e.button > 0 || isBarLayout(win().width)) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    const r = root.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, box: { left: r.left, top: r.top, width: r.width, height: r.height }, moved: false, id: e.pointerId };
    try { if (e.pointerId !== undefined) root.setPointerCapture(e.pointerId); } catch (_) { /* ignoré */ }
  }
  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    root.classList.add('is-dragging');
    moveTo({ ...drag.box, left: drag.box.left + dx, top: drag.box.top + dy });
  }
  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { if (d.id !== undefined) root.releasePointerCapture(d.id); } catch (_) { /* ignoré */ }
    root.classList.remove('is-dragging');
    if (!d.moved) return;
    // Aimantation : le coin le plus proche du centre de la vignette.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    const b = current ? current.box : d.box;
    h.state.setCorner(snapCorner({ x: b.left + b.width / 2, y: b.top + b.height / 2 }, win()));
    layout();
  }
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  // Un glissement ne doit pas se terminer en « clic = agrandir ».
  root.addEventListener('click', (e) => {
    if (!justDragged) return;
    justDragged = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  root.addEventListener('keydown', (e) => {
    if (!active || e.target !== root || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    h.action('expand');
  });
  window.addEventListener('resize', () => { if (active && !drag) layout(); });

  function setLabel() { root.setAttribute('aria-label', 'Mini-lecteur' + (title ? ' : ' + title : '')); }

  return {
    get active() { return active; },
    get dragging() { return !!drag && drag.moved; },
    enter() {
      active = true;
      root.classList.add('is-mini');
      root.setAttribute('role', 'region');
      root.removeAttribute('aria-modal');
      root.setAttribute('tabindex', '0');
      setLabel();
      bar.hidden = false;
      layout();
    },
    leave() {
      if (!active) return;
      active = false;
      drag = null;
      root.classList.remove('is-mini', 'is-bar', 'is-dragging');
      for (const k of ['left', 'top', 'width', 'height', 'clip-path']) root.style.removeProperty(k);
      root.style.removeProperty('--mini-h');
      Object.entries(PLAIN_ROLE).forEach(([k, v]) => root.setAttribute(k, v));
      root.removeAttribute('tabindex');
      bar.hidden = true;
      current = null;
      h.layout(null, null);
    },
    /** Moteur mpv choisi ou quitté pendant le mini-lecteur : la découpe de la barre dépend de la classe `is-mpv`. */
    relayout: layout,
    setTitle(t, sub) {
      title = t || '';
      q('.lp-mini-title').textContent = title;
      q('.lp-mini-sub').textContent = sub || '';
      if (active) setLabel();
    },
    /** État du moteur : progression et icône lecture/pause. */
    update(st) {
      if (!active || !st) return;
      const pct = st.duration ? Math.min(100, Math.max(0, (st.time / st.duration) * 100)) : 0;
      prog.firstElementChild.style.width = pct + '%';
      prog.setAttribute('aria-valuenow', String(Math.round(pct)));
      if (paused !== !!st.paused) {
        paused = !!st.paused;
        playBtn.innerHTML = paused ? LI.play : LI.pause;
        playBtn.setAttribute('aria-label', paused ? 'Lecture' : 'Pause');
      }
    },
  };
}
