import type { Note } from '../data/socialV2Api';
import { formatClock } from './progress';
import { NOTE_MAX, QUICK_EMOJIS, noteBody, noteLength, safeColor, type NoteCluster, type NoteKind } from './notesTimeline';
import { initialOf, isFuture } from './playbackSocial';

/* Rendu DOM des notes du lecteur : marqueurs sur la barre (couche distincte des chapitres), aperçu au survol ou au focus,
 * puce brève à la lecture d'une note, popover « Réagir ici » (éventail d'emojis en version tactile). Tout texte
 * utilisateur passe par textContent (jamais innerHTML). */

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

/** Avatar de repli : la lettre colorée (couleur validée). */
export function avatarEl(name: string, color: string, cls: string): HTMLElement {
  const a = el('span', cls, initialOf(name));
  a.style.background = safeColor(color);
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/** Aperçu d'un groupe de notes : heure, puis auteur et texte (ou emoji) pour les trois premières, le reste en compte. */
function cardOf(notes: readonly Note[], clock: string): HTMLElement {
  const box = el('span', 'lp-note-card');
  box.setAttribute('role', 'tooltip');
  box.append(el('span', 'lp-nc-h', clock));
  for (const n of notes.slice(0, 3)) {
    const row = el('span', 'lp-nc-r' + (n.kind === 'emoji' ? ' is-emoji' : ''));
    row.append(dotOf(n, 'lp-nc-d'), el('span', 'lp-nc-w', n.author.handle.name), el('span', 'lp-nc-t', n.body));
    box.append(row);
  }
  if (notes.length > 3) box.append(el('span', 'lp-nc-m', '+ ' + (notes.length - 3) + ' autres'));
  return box;
}

/** Libellé accessible d'un marqueur : heure et contenu de la première note du groupe. */
function labelOf(notes: readonly Note[], clock: string): string {
  const first = notes[0];
  if (notes.length === 1) return 'Réaction de ' + first.author.handle.name + ' à ' + clock + ' : ' + first.body;
  return notes.length + ' réactions à ' + clock + ', la première de ' + first.author.handle.name;
}

/** Marqueur rond d'un groupe, placé à sa position sur la barre ; un clic (ou Entrée au clavier) amène la lecture à la note. */
function markerOf(c: NoteCluster, onSeek: (pos: number) => void): HTMLButtonElement {
  const first = c.notes[0];
  const clock = formatClock(first.pos);
  const b = el('button', 'lp-note' + (c.pct < 12 ? ' is-left' : c.pct > 88 ? ' is-right' : '') + (c.notes.length > 1 ? ' is-multi' : ''));
  b.type = 'button';
  b.style.left = c.pct.toFixed(3) + '%';
  b.dataset.pos = String(first.pos);
  b.dataset.label = labelOf(c.notes, clock);
  b.dataset.futureLabel = 'Réaction à venir à ' + clock;
  b.setAttribute('aria-label', b.dataset.label);
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

/**
 * Anti-spoiler : les marqueurs situés au-delà de la position de lecture sont estompés, leur aperçu et leur libellé ne
 * révèlent plus rien. Ne touche le DOM que pour les marqueurs dont l'état change.
 */
export function fadeFutureMarkers(container: HTMLElement, time: number, antiSpoiler: boolean): void {
  for (const m of Array.from(container.children) as HTMLElement[]) {
    const future = isFuture(Number(m.dataset.pos), time, antiSpoiler);
    if (m.classList.contains('is-future') === future) continue;
    m.classList.toggle('is-future', future);
    m.setAttribute('aria-label', (future ? m.dataset.futureLabel : m.dataset.label) || '');
  }
}

/** Note atteinte par la lecture : emoji flottant, ou puce « avatar · Auteur · texte ». */
export function noteFlashEl(note: Note): HTMLElement {
  const box = el('div', 'lp-nf ' + (note.kind === 'emoji' ? 'is-emoji' : 'is-text'));
  if (note.kind === 'emoji') {
    box.append(el('span', 'lp-nf-e', note.body), el('span', 'lp-nf-w', note.author.handle.name));
  } else {
    const bub = el('span', 'lp-nf-b');
    bub.append(
      avatarEl(note.author.handle.name, note.author.avatarColor, 'lp-nf-d'),
      el('b', 'lp-nf-w', note.author.handle.name), el('span', 'lp-nf-sep', '·'), el('span', 'lp-nf-t', note.body),
    );
    box.append(bub);
  }
  return box;
}

/** Emojis supplémentaires derrière le « + » (la rangée rapide reste QUICK_EMOJIS). */
export const MORE_EMOJIS: readonly string[] = ['👍', '😮', '😢', '🥹', '😍', '🙌', '💀', '🍿'];
/** Éventail tactile : les cinq premiers emojis rapides (maquette Android). */
export const FAN_COUNT = 5;
const EMOJI_LABEL: Record<string, string> = {
  '😂': 'rire', '🔥': 'feu', '😱': 'choc', '😭': 'larmes', '❤️': 'cœur', '👏': 'bravo', '🤯': 'esprit soufflé',
};

export interface ReactOpenOptions {
  /** Ami à qui proposer « Aussi envoyer à X en message » ; absent = la case n'existe pas. */
  friend?: { pid: string; name: string } | null;
  /** Version tactile : éventail d'emojis, le champ texte s'ouvre avec « Note ». */
  touch?: boolean;
}

export interface ReactPanel {
  el: HTMLElement;
  /** Ouvre le popover pour l'heure affichée (`clock`), focus sur la rangée d'emojis. */
  open(clock: string, opts?: ReactOpenOptions): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Popover « Réagir ici » : rangée d'emojis, champ texte (140 caractères au plus, compteur), « Aussi envoyer à X en
 * message ». `onPick` reçoit un corps valide (et, si la case est cochée, le pid de l'ami en 3e argument) ; `onCancel`
 * est appelé par Échap. La position est gérée par l'appelant.
 */
export function createReactPanel(opts: { onPick: (kind: NoteKind, body: string, also?: string) => void; onCancel: () => void }): ReactPanel {
  const root = el('div', 'lp-react');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Réagir à ce moment');
  root.hidden = true;

  const title = el('p', 'lp-react-t');
  const clockEl = el('b', 'lp-react-clock');
  const left = el('span');
  left.append('Réagir à ', clockEl);
  title.append(left, el('span', 'lp-react-vis', 'Visible : amis'));

  let also: string | null = null;
  const alsoBox = el('input');
  alsoBox.type = 'checkbox';
  alsoBox.checked = true;
  const pick = (kind: NoteKind, body: string): void => {
    if (also && alsoBox.checked) opts.onPick(kind, body, also);
    else opts.onPick(kind, body);
  };
  const emojiBtn = (e: string, cls: string): HTMLButtonElement => {
    const b = el('button', cls, e);
    b.type = 'button';
    b.setAttribute('aria-label', 'Réagir avec ' + (EMOJI_LABEL[e] ? EMOJI_LABEL[e] + ' ' : '') + e);
    b.addEventListener('click', () => pick('emoji', e));
    return b;
  };

  const row = el('div', 'lp-react-emo');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Réactions rapides');
  QUICK_EMOJIS.forEach((e, i) => row.append(emojiBtn(e, 'lp-react-e' + (i >= FAN_COUNT ? ' is-extra' : ''))));
  const more = el('button', 'lp-react-more', '+');
  more.type = 'button';
  more.setAttribute('aria-label', 'Plus d’emojis');
  more.setAttribute('aria-expanded', 'false');
  const moreRow = el('div', 'lp-react-emo lp-react-emo2');
  moreRow.hidden = true;
  moreRow.setAttribute('role', 'group');
  moreRow.setAttribute('aria-label', 'Plus d’emojis');
  for (const e of MORE_EMOJIS) moreRow.append(emojiBtn(e, 'lp-react-e2'));
  more.addEventListener('click', () => {
    moreRow.hidden = !moreRow.hidden;
    more.setAttribute('aria-expanded', String(!moreRow.hidden));
  });
  const noteBtn = el('button', 'lp-react-note', 'Note');
  noteBtn.type = 'button';
  row.append(more, noteBtn);

  const form = el('form', 'lp-react-f');
  const input = el('input', 'lp-react-in');
  input.type = 'text';
  input.maxLength = NOTE_MAX;
  input.placeholder = 'Une note à ce moment… (' + NOTE_MAX + ')';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Note texte, ' + NOTE_MAX + ' caractères au plus');
  const count = el('span', 'lp-react-c', '0 / ' + NOTE_MAX);
  const send = el('button', 'lp-react-send', 'Poser');
  send.type = 'submit';
  send.disabled = true;
  form.append(input, count, send);
  noteBtn.addEventListener('click', () => {
    root.classList.add('is-note');
    input.focus({ preventScroll: true });
  });

  const alsoRow = el('label', 'lp-react-also');
  alsoRow.hidden = true;
  const alsoTxt = el('span', 'lp-react-also-t');
  alsoRow.append(alsoBox, el('span', 'lp-react-cb', '✓'), alsoTxt);

  const sync = (): void => {
    count.textContent = noteLength(input.value) + ' / ' + NOTE_MAX;
    send.disabled = noteBody('text', input.value) === null;
  };
  input.addEventListener('input', sync);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = noteBody('text', input.value);
    if (body === null) return;
    pick('text', body);
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
  root.append(title, row, moreRow, form, alsoRow);

  return {
    el: root,
    open(clock: string, o: ReactOpenOptions = {}) {
      clockEl.textContent = clock;
      input.value = '';
      sync();
      also = o.friend ? o.friend.pid : null;
      alsoRow.hidden = !o.friend;
      alsoTxt.textContent = o.friend ? 'Aussi envoyer à ' + o.friend.name + ' en message' : '';
      alsoBox.checked = true;
      moreRow.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      root.classList.toggle('is-fan', !!o.touch);
      root.classList.remove('is-note');
      root.hidden = false;
      const first = row.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    },
    close() { root.hidden = true; },
    isOpen: () => !root.hidden,
  };
}
