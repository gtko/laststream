import type { Note } from '../data/socialV2Api';
import { formatClock } from './progress';
import { NOTE_MAX, QUICK_EMOJIS, noteBody, noteLength, safeColor, type NoteCluster, type NoteKind } from './notesTimeline';

/* Rendu DOM des notes du lecteur : marqueurs sur la barre (couche distincte des chapitres), aperçu au survol ou au focus,
 * bulle brève à la lecture d'une note, popover « Réagir ici ». Tout texte utilisateur passe par textContent (jamais innerHTML). */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Pastille de couleur d'avatar (couleur validée avant d'entrer dans le style). */
function dotOf(n: Note, cls: string): HTMLElement {
  const d = el('span', cls);
  d.style.background = safeColor(n.author.avatarColor);
  return d;
}

/** Aperçu d'un groupe de notes : heure, puis auteur et texte (ou emoji) pour les trois premières, le reste en compte. */
function cardOf(notes: readonly Note[], clock: string): HTMLElement {
  const box = el('span', 'lp-note-card');
  box.setAttribute('role', 'tooltip');
  box.append(el('span', 'lp-nc-h', clock));
  for (const n of notes.slice(0, 3)) {
    const row = el('span', 'lp-nc-r' + (n.kind === 'emoji' ? ' is-emoji' : ''));
    row.append(dotOf(n, 'lp-nc-d'), el('span', 'lp-nc-w', n.author.handle.full), el('span', 'lp-nc-t', n.body));
    box.append(row);
  }
  if (notes.length > 3) box.append(el('span', 'lp-nc-m', '+ ' + (notes.length - 3) + ' autres'));
  return box;
}

/** Libellé accessible d'un marqueur : heure et contenu de la première note du groupe. */
function labelOf(notes: readonly Note[], clock: string): string {
  const first = notes[0];
  if (notes.length === 1) return 'Réaction de ' + first.author.handle.full + ' à ' + clock + ' : ' + first.body;
  return notes.length + ' réactions à ' + clock + ', la première de ' + first.author.handle.full;
}

/** Marqueur rond d'un groupe, placé à sa position sur la barre ; un clic (ou Entrée au clavier) amène la lecture à la note. */
function markerOf(c: NoteCluster, onSeek: (pos: number) => void): HTMLButtonElement {
  const first = c.notes[0];
  const clock = formatClock(first.pos);
  const b = el('button', 'lp-note' + (c.pct < 12 ? ' is-left' : c.pct > 88 ? ' is-right' : ''));
  b.type = 'button';
  b.style.left = c.pct.toFixed(3) + '%';
  b.setAttribute('aria-label', labelOf(c.notes, clock));
  b.append(dotOf(first, 'lp-note-dot'));
  if (c.notes.length > 1) b.append(el('b', 'lp-note-n', String(c.notes.length)));
  b.append(cardOf(c.notes, clock));
  b.addEventListener('click', () => onSeek(first.pos));
  // L'appui ne remonte pas à la barre [data-seek], qui capturerait le pointeur et lancerait un glissement de lecture.
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

/** Remplace les marqueurs du conteneur (la couche `.lp-notes` de la piste) par ceux des groupes donnés. */
export function renderNoteMarkers(container: HTMLElement, clusters: readonly NoteCluster[], onSeek: (pos: number) => void): void {
  container.replaceChildren(...clusters.map((c) => markerOf(c, onSeek)));
}

/** Bulle brève affichée quand la lecture franchit une note : emoji animé, ou texte avec son auteur. */
export function noteFlashEl(note: Note): HTMLElement {
  const box = el('div', 'lp-nf ' + (note.kind === 'emoji' ? 'is-emoji' : 'is-text'));
  if (note.kind === 'emoji') {
    box.append(el('span', 'lp-nf-e', note.body), el('span', 'lp-nf-w', note.author.handle.full));
  } else {
    const bub = el('span', 'lp-nf-b');
    bub.append(dotOf(note, 'lp-nf-d'), el('span', 'lp-nf-w', note.author.handle.full), el('span', 'lp-nf-t', note.body));
    box.append(bub);
  }
  return box;
}

export interface ReactPanel {
  el: HTMLElement;
  /** Ouvre le popover pour l'heure affichée (`clock`), focus sur la rangée d'emojis. */
  open(clock: string): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Popover « Réagir ici » : rangée d'emojis rapides, champ texte (140 caractères au plus, compteur). `onPick` reçoit un
 * corps valide ; `onCancel` est appelé par Échap. Le popover ne transmet rien d'autre : la position est gérée par l'appelant.
 */
export function createReactPanel(opts: { onPick: (kind: NoteKind, body: string) => void; onCancel: () => void }): ReactPanel {
  const root = el('div', 'lp-react');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Réagir à ce moment');
  root.hidden = true;

  const title = el('p', 'lp-react-t');
  const clockEl = el('b', 'lp-react-clock');
  title.append('Réagir à ', clockEl);

  const row = el('div', 'lp-react-emo');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Réactions rapides');
  for (const e of QUICK_EMOJIS) {
    const b = el('button', 'lp-react-e', e);
    b.type = 'button';
    b.setAttribute('aria-label', 'Réagir avec ' + e);
    b.addEventListener('click', () => opts.onPick('emoji', e));
    row.append(b);
  }

  const form = el('form', 'lp-react-f');
  const input = el('input', 'lp-react-in');
  input.type = 'text';
  input.maxLength = NOTE_MAX;
  input.placeholder = 'Écrire une note';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Note texte, ' + NOTE_MAX + ' caractères au plus');
  const count = el('span', 'lp-react-c', '0 / ' + NOTE_MAX);
  const send = el('button', 'btn btn-primary lp-react-send', 'Envoyer');
  send.type = 'submit';
  send.disabled = true;
  form.append(input, count, send);

  const sync = (): void => {
    count.textContent = noteLength(input.value) + ' / ' + NOTE_MAX;
    send.disabled = noteBody('text', input.value) === null;
  };
  input.addEventListener('input', sync);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = noteBody('text', input.value);
    if (body === null) return;
    opts.onPick('text', body);
    input.value = '';
    sync();
  });
  // Échap ferme le popover sans atteindre les raccourcis du lecteur.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    opts.onCancel();
  });
  root.append(title, row, form);

  return {
    el: root,
    open(clock: string) {
      clockEl.textContent = clock;
      input.value = '';
      sync();
      root.hidden = false;
      const first = row.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    },
    close() { root.hidden = true; },
    isOpen: () => !root.hidden,
  };
}
