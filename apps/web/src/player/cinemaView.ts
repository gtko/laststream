import type { CinemaElement } from '../data/socialStore';
import type { MissedSummary } from '../data/socialV3Api';
import { CINEMA_LABELS, indicatorText, menuElements, type CinemaDuration } from './playbackSocial';
import { avatarEl } from './notesView';
import { formatClock } from './progress';

/* Interface du mode cinéma dans le lecteur : menu (interrupteur, durée, cases « Masquer »), indicateur discret
 * « Mode cinéma · N messages en attente » et résumé de fin. Aucune logique de store ici : la session branche les
 * rappels. Tout texte utilisateur passe par textContent. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

interface CinemaModel {
  active: boolean;
  duration: CinemaDuration;
  hidden: readonly CinemaElement[];
  /** « 1 h 33 restantes » pour la ligne « jusqu'à la fin de ce film ». */
  remaining: string;
}

export interface CinemaHandlers {
  /** L'interrupteur change : démarrer ou arrêter. */
  onSwitch(on: boolean): void;
  /** Une durée est choisie (hors mode actif : elle s'applique au démarrage). */
  onDuration(d: CinemaDuration): void;
  /** Une case « Masquer » change. */
  onToggle(el: CinemaElement): void;
  onClose(): void;
}

export interface CinemaMenu {
  el: HTMLElement;
  open(model: CinemaModel): void;
  render(model: CinemaModel): void;
  close(): void;
  isOpen(): boolean;
}

const DURATIONS: ReadonlyArray<{ id: CinemaDuration; label: string }> = [
  { id: 'film', label: 'Jusqu’à la fin de ce film' },
  { id: 'hour', label: 'Pendant 1 heure' },
  { id: 'always', label: 'Toujours (réglage du profil)' },
];

export function createCinemaMenu(h: CinemaHandlers): CinemaMenu {
  const root = el('div', 'lp-cinema-menu');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Mode cinéma');
  root.hidden = true;

  const head = el('div', 'lp-cm-head');
  const hd = el('div', 'lp-cm-hd');
  hd.append(el('div', 'lp-cm-title', 'Mode cinéma'), el('div', 'lp-cm-sub', 'Coupe le social, rien n’est perdu'));
  const sw = el('button', 'lp-cm-switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.append(el('span', 'lp-cm-knob'));
  head.append(hd, sw);

  const durLabel = el('div', 'lp-cm-lb', 'Durée');
  durLabel.id = 'lp-cm-dur';
  const durs = el('div', 'lp-cm-durs');
  durs.setAttribute('role', 'radiogroup');
  durs.setAttribute('aria-labelledby', 'lp-cm-dur');
  const radios = new Map<CinemaDuration, HTMLButtonElement>();
  const rem = el('span', 'lp-cm-rem');
  for (const d of DURATIONS) {
    const b = el('button', 'lp-cm-op');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.append(el('span', 'lp-cm-rd'), el('span', 'lp-cm-opt', d.label));
    if (d.id === 'film') b.append(rem);
    b.addEventListener('click', () => h.onDuration(d.id));
    radios.set(d.id, b);
    durs.append(b);
  }

  const hideLabel = el('div', 'lp-cm-lb', 'Masquer');
  const grid = el('div', 'lp-cm-grid');
  const boxes = new Map<CinemaElement, HTMLButtonElement>();
  for (const id of menuElements()) {
    const b = el('button', 'lp-cm-op lp-cm-chk');
    b.type = 'button';
    b.setAttribute('role', 'checkbox');
    b.append(el('span', 'lp-cm-cb', '✓'), el('span', 'lp-cm-opt', CINEMA_LABELS[id]));
    b.addEventListener('click', () => h.onToggle(id));
    boxes.set(id, b);
    grid.append(b);
  }
  const foot = el('div', 'lp-cm-foot', 'À la fin du film : un résumé de ce que tu as manqué (messages, notes posées par tes amis pendant ce film).');
  const locked = el('div', 'lp-cm-lock', 'Pour changer la durée, désactive puis réactive le mode.');
  locked.hidden = true;
  root.append(head, durLabel, durs, locked, hideLabel, grid, foot);

  sw.addEventListener('click', () => h.onSwitch(sw.getAttribute('aria-checked') !== 'true'));
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    h.onClose();
  });

  function render(m: CinemaModel): void {
    sw.setAttribute('aria-checked', String(m.active));
    sw.setAttribute('aria-label', m.active ? 'Mode cinéma activé' : 'Mode cinéma désactivé');
    sw.classList.toggle('is-on', m.active);
    for (const [id, b] of radios) {
      const on = id === m.duration;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-on', on);
      b.disabled = m.active && !on;
    }
    locked.hidden = !m.active;
    rem.textContent = m.remaining;
    for (const [id, b] of boxes) {
      const on = m.hidden.includes(id);
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-on', on);
    }
  }

  return {
    el: root,
    open(m) {
      render(m);
      root.hidden = false;
      sw.focus({ preventScroll: true });
    },
    render,
    close() { root.hidden = true; },
    isOpen: () => !root.hidden,
  };
}

/** Indicateur discret en haut à droite ; `null` le retire. */
export function createCinemaIndicator(): { el: HTMLElement; set(count: number | null): void } {
  const root = el('div', 'lp-cinema-ind');
  root.setAttribute('role', 'status');
  root.hidden = true;
  const icon = el('span', 'lp-ci-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 0 1 9.3-5M18 8c0 7 3 9 3 9H9M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18"/></svg>';
  const txt = el('span', 'lp-ci-txt');
  root.append(icon, txt);
  return {
    el: root,
    set(count) {
      root.hidden = count === null;
      if (count !== null) txt.textContent = indicatorText(count);
    },
  };
}

/** Résumé de fin de mode : messages par ami, notes posées par les amis pendant ce film. */
export function createCinemaSummary(onClose: () => void, onSeek: (pos: number) => void): { el: HTMLElement; show(s: MissedSummary): void; hide(): void; isOpen(): boolean } {
  const root = el('div', 'lp-cinema-sum');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Ce que tu as manqué');
  root.hidden = true;
  const title = el('div', 'lp-cs-title', 'Ce que tu as manqué');
  const body = el('div', 'lp-cs-body');
  const ok = el('button', 'lp-cs-ok', 'Fermer');
  ok.type = 'button';
  ok.addEventListener('click', onClose);
  root.append(title, body, ok);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  });
  return {
    el: root,
    show(s) {
      body.replaceChildren();
      const noMsg = s.messages <= 0;
      const noNotes = s.notes.length === 0;
      if (noMsg && noNotes) {
        body.append(el('p', 'lp-cs-empty', 'Rien de nouveau pendant ce film.'));
      }
      if (!noMsg) {
        body.append(el('p', 'lp-cs-line', s.messages + (s.messages > 1 ? ' messages reçus' : ' message reçu')));
        const ul = el('ul', 'lp-cs-friends');
        for (const f of s.byFriend) ul.append(el('li', '', f.handle.name + ' : ' + f.count));
        if (ul.childElementCount) body.append(ul);
      }
      if (!noNotes) {
        body.append(el('p', 'lp-cs-line', s.notes.length + (s.notes.length > 1 ? ' notes d’amis' : ' note d’ami')));
        const ul = el('ul', 'lp-cs-notes');
        for (const n of s.notes.slice(0, 5)) {
          const li = el('li');
          const b = el('button', 'lp-cs-note');
          b.type = 'button';
          b.append(avatarEl(n.author.handle.name, n.author.avatarColor, 'lp-cs-av', n.author.avatar), el('span', 'lp-cs-at', formatClock(n.pos)), el('span', 'lp-cs-t', n.body));
          b.addEventListener('click', () => onSeek(n.pos));
          li.append(b);
          ul.append(li);
        }
        body.append(ul);
      }
      root.hidden = false;
      ok.focus({ preventScroll: true });
    },
    hide() { root.hidden = true; },
    isOpen: () => !root.hidden,
  };
}
