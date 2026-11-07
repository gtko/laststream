import { formatClock } from './progress';
import { guessKind, initialRange, MARK_MIN, moveHandle, rangeValid, type MarkRange } from './segmentMark';
import type { MarkKind } from './skip';

/* Marquage d'un segment sur la barre de progression : deux poignées à glisser (souris, tactile ou flèches) et un petit
 * popover (type, début / fin = lecture, Envoyer). Aucune logique réseau ici : l'envoi passe par `onSend`. */

export interface MarkBarOpts {
  getTime: () => number;
  getDuration: () => number;
  /** Envoie le segment ; résout à `true` quand il est enregistré (la barre se ferme). */
  onSend: (kind: MarkKind, start: number, end: number) => Promise<boolean>;
  /** Pendant le glissement d'une poignée : cadre d'aperçu à l'instant `t`. */
  onScrub: (t: number) => void;
  /** Poignée lâchée : la lecture saute à l'instant `t` pour montrer l'image. */
  onScrubEnd: (t: number) => void;
  /** Fermeture (annulation, envoi réussi) ; `back` : redonner le focus au bouton d'ouverture. */
  onClose: (back: boolean) => void;
}

export interface MarkBar {
  /** À placer à côté de `.lp-seek` (dans un parent positionné) : plage et poignées. */
  layer: HTMLElement;
  /** À placer dans le lecteur : popover au-dessus de la barre. */
  pop: HTMLElement;
  open(time: number): void;
  close(back: boolean): void;
  isOpen(): boolean;
}

const KINDS: ReadonlyArray<[MarkKind, string]> = [['intro', 'Intro'], ['recap', 'Récap'], ['credits', 'Générique']];
const STEP = 1;
const BIG_STEP = 5;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(cls: string, text: string, label?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

export function createMarkBar(opts: MarkBarOpts): MarkBar {
  const layer = el('span', 'lp-mk-layer');
  layer.hidden = true;
  const fill = el('i', 'lp-mk-fill');
  const hs = button('lp-mk-h lp-mk-h-s', '', 'Début du segment');
  const he = button('lp-mk-h lp-mk-h-e', '', 'Fin du segment');
  for (const h of [hs, he]) h.setAttribute('role', 'slider');
  layer.append(fill, hs, he);

  const pop = el('div', 'lp-mk');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Marquer un segment');
  pop.hidden = true;
  const title = el('p', 'lp-mk-t');
  const range$ = el('b', 'lp-mk-range');
  const len$ = el('span', 'lp-mk-len');
  title.append(el('span', '', 'Segment'), range$, len$);
  const hint = el('p', 'lp-mk-hint', 'Glisse les poignées sur la barre pour régler le début et la fin.');
  const kindsBox = el('div', 'lp-mk-kinds');
  kindsBox.setAttribute('role', 'radiogroup');
  kindsBox.setAttribute('aria-label', 'Type de segment');
  const kindBtns = KINDS.map(([k, label]) => {
    const b = button('lp-mk-k', label);
    b.setAttribute('role', 'radio');
    b.dataset.kind = k;
    return b;
  });
  kindsBox.append(...kindBtns);
  const setHere = el('div', 'lp-mk-set');
  const startHere = button('lp-mk-here', 'Début = ici');
  const endHere = button('lp-mk-here', 'Fin = ici');
  setHere.append(startHere, endHere);
  const actions = el('div', 'lp-mk-act');
  const cancel = button('lp-mk-cancel', 'Annuler');
  const send = button('lp-mk-send', 'Envoyer');
  actions.append(cancel, send);
  pop.append(title, hint, kindsBox, setHere, actions);

  let open = false;
  let busy = false;
  let kind: MarkKind = 'intro';
  let userKind = false;
  let range: MarkRange = { start: 0, end: MARK_MIN };

  const dur = (): number => opts.getDuration();

  function render(): void {
    const d = dur();
    const pct = (t: number): number => (d > 0 ? Math.min(100, Math.max(0, (t / d) * 100)) : 0);
    fill.style.left = pct(range.start) + '%';
    fill.style.width = Math.max(0.3, pct(range.end) - pct(range.start)) + '%';
    hs.style.left = pct(range.start) + '%';
    he.style.left = pct(range.end) + '%';
    // Bornes réelles : le début s'arrête 3 s avant la fin, et inversement.
    for (const [h, t, lo, hi] of [[hs, range.start, 0, range.end - MARK_MIN], [he, range.end, range.start + MARK_MIN, d]] as const) {
      h.setAttribute('aria-valuemin', String(Math.round(lo)));
      h.setAttribute('aria-valuemax', String(Math.round(hi)));
      h.setAttribute('aria-valuenow', String(Math.round(t)));
      h.setAttribute('aria-valuetext', formatClock(t));
    }
    range$.textContent = formatClock(range.start) + ' → ' + formatClock(range.end);
    const secs = Math.round(range.end - range.start);
    len$.textContent = secs >= 60 ? Math.floor(secs / 60) + ' min ' + String(secs % 60).padStart(2, '0') + ' s' : secs + ' s';
    kindBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === kind)));
    kindBtns.forEach((b) => b.classList.toggle('is-on', b.dataset.kind === kind));
    send.disabled = busy || !rangeValid(range);
    send.textContent = busy ? 'Envoi…' : 'Envoyer';
  }

  function setRange(next: MarkRange): void {
    range = next;
    if (!userKind) kind = guessKind(range, dur());
    render();
  }

  const timeAt = (e: PointerEvent): number => {
    const r = layer.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur();
  };

  function bindHandle(h: HTMLElement, which: 'start' | 'end'): void {
    let drag = false;
    h.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      drag = true;
      h.setPointerCapture(e.pointerId);
      h.focus({ preventScroll: true });
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      setRange(moveHandle(range, which, timeAt(e), dur()));
      opts.onScrub(range[which]);
    });
    const stop = (): void => {
      if (!drag) return;
      drag = false;
      opts.onScrubEnd(range[which]);
    };
    h.addEventListener('pointerup', stop);
    h.addEventListener('pointercancel', stop);
    h.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); return; }
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!dir) return;
      e.stopPropagation();
      e.preventDefault();
      setRange(moveHandle(range, which, range[which] + dir * (e.shiftKey ? BIG_STEP : STEP), dur()));
      opts.onScrub(range[which]);
    });
  }
  bindHandle(hs, 'start');
  bindHandle(he, 'end');

  kindBtns.forEach((b) => b.addEventListener('click', () => { kind = b.dataset.kind as MarkKind; userKind = true; render(); }));
  startHere.addEventListener('click', () => setRange(moveHandle(range, 'start', opts.getTime(), dur())));
  endHere.addEventListener('click', () => setRange(moveHandle(range, 'end', opts.getTime(), dur())));
  cancel.addEventListener('click', () => close(true));
  send.addEventListener('click', async () => {
    if (busy || !rangeValid(range)) return;
    busy = true;
    render();
    let ok = false;
    try { ok = await opts.onSend(kind, range.start, range.end); } catch (_) { ok = false; } finally { busy = false; }
    if (ok) close(true); else if (open) render();
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); }
  });

  function close(back: boolean): void {
    if (!open) return;
    open = false;
    layer.hidden = true;
    pop.hidden = true;
    opts.onClose(back);
  }

  return {
    layer,
    pop,
    open(time) {
      const d = dur();
      if (!(d > 0) || !Number.isFinite(d)) return;
      range = initialRange(time, d);
      userKind = false;
      kind = guessKind(range, d);
      busy = false;
      open = true;
      layer.hidden = false;
      pop.hidden = false;
      render();
      hs.focus({ preventScroll: true });
    },
    close,
    isOpen: () => open,
  };
}
