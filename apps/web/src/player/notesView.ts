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

/** Avatar : la lettre colorée (couleur validée) en repli ; l'illustration (data-avatar) est posée par avatar-art.js. */
export function avatarEl(name: string, color: string, cls: string, avatar?: string): HTMLElement {
  const a = el('span', cls, initialOf(name));
  a.style.background = safeColor(color);
  a.setAttribute('aria-hidden', 'true');
  if (typeof avatar === 'string' && avatar !== '' && avatar.length <= 200) a.dataset.avatar = avatar;
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

/** Gestion de ses propres notes : `mine` reconnaît les notes du profil actif ; `onMenu` ouvre le menu ancré au marqueur. */
export interface OwnNotes {
  mine: (n: Note) => boolean;
  onMenu: (anchor: HTMLButtonElement, notes: Note[]) => void;
}

/** Notes du profil actif déjà enregistrées (les notes optimistes `tmp-` ne sont pas encore modifiables). */
const editable = (own: OwnNotes, notes: readonly Note[]): Note[] => notes.filter((n) => own.mine(n) && !n.id.startsWith('tmp-'));

/**
 * Marqueur rond d'un groupe, placé à sa position sur la barre ; un clic (ou Entrée au clavier) amène la lecture à la note.
 * Si le groupe contient des notes du profil actif, ce même clic ouvre aussi le menu Modifier / Supprimer ; les notes des
 * autres gardent l'aperçu seul.
 */
function markerOf(c: NoteCluster, onSeek: (pos: number) => void, own?: OwnNotes): HTMLButtonElement {
  const first = c.notes[0];
  const clock = formatClock(first.pos);
  const mine = own ? editable(own, c.notes) : [];
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
  if (own && mine.length) {
    b.classList.add('is-mine');
    b.dataset.label += mine.length > 1 ? ' — ' + mine.length + ' sont les tiennes : modifier ou supprimer' : ' — la tienne : modifier ou supprimer';
    b.setAttribute('aria-label', b.dataset.label);
    b.setAttribute('aria-haspopup', 'dialog');
  }
  b.addEventListener('click', () => {
    onSeek(first.pos);
    if (own && mine.length) own.onMenu(b, mine);
  });
  // L'appui ne remonte pas à la barre [data-seek], qui capturerait le pointeur et lancerait un glissement de lecture.
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

/** Marqueur de position `pos` (valeur de `data-pos`), à défaut le plus proche en position ; null s'il n'y a aucun marqueur. */
export function nearestMarker(markers: readonly HTMLElement[], pos: string): HTMLElement | null {
  const exact = markers.find((m) => m.dataset.pos === pos);
  if (exact) return exact;
  const at = Number(pos);
  if (pos === '' || !Number.isFinite(at)) return null;
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (const m of markers) {
    const d = Math.abs(Number(m.dataset.pos) - at);
    if (d < gap) { gap = d; best = m; }
  }
  return best;
}

/** Remplace les marqueurs du conteneur (la couche `.lp-notes` de la piste) par ceux des groupes donnés. */
export function renderNoteMarkers(container: HTMLElement, clusters: readonly NoteCluster[], onSeek: (pos: number) => void, own?: OwnNotes): void {
  container.replaceChildren(...clusters.map((c) => markerOf(c, onSeek, own)));
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
      avatarEl(note.author.handle.name, note.author.avatarColor, 'lp-nf-d', note.author.avatar),
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

interface ReactOpenOptions {
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

export interface NoteMenuOptions {
  /** Enregistre le nouveau contenu (corps déjà validé par `noteBody`) ; l'horodatage ne change jamais. */
  onEdit: (id: string, kind: NoteKind, body: string) => void;
  /** Supprime la note, après confirmation dans le menu. */
  onDelete: (id: string) => void;
  /** Le menu demande sa fermeture (Échap, clic ailleurs, action faite) ; `back` : rendre le focus au marqueur. */
  onClose: (back: boolean) => void;
}

export interface NoteMenu {
  el: HTMLElement;
  /** Ouvre le menu des notes `notes` (les miennes du groupe), ancré au marqueur `anchor` dans l'hôte `host`. */
  open(anchor: HTMLElement, notes: readonly Note[], host?: HTMLElement): void;
  /** Met à jour avec les notes à jour (édition ou suppression en direct) ; ferme le menu s'il ne reste rien à gérer. */
  refresh(all: readonly Note[]): void;
  close(): void;
  isOpen(): boolean;
  /** Position (s) de la première note du groupe ouvert, pour retrouver le marqueur après un nouveau rendu. */
  anchorPos(): string;
}

type MenuView = { kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'confirm'; id: string };

/**
 * Menu d'un marqueur contenant mes réactions : liste (Modifier / Supprimer), édition (emojis rapides + champ texte, l'heure
 * ne change pas, Annuler / Enregistrer) et suppression en deux appuis (« Supprimer cette réaction ? » Annuler / Confirmer).
 * Un seul menu à la fois ; Échap ou un clic ailleurs le ferme. Tout texte utilisateur passe par textContent.
 */
export function createNoteMenu(opts: NoteMenuOptions): NoteMenu {
  const root = el('div', 'lp-notemenu');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Mes réactions');
  root.hidden = true;

  let notes: Note[] = [];
  let view: MenuView = { kind: 'list' };
  let pos = '';
  let open = false;

  const find = (id: string): Note | undefined => notes.find((n) => n.id === id);
  const clockOf = (n: Note): string => formatClock(n.pos);
  const dismiss = (back: boolean): void => {
    if (open) opts.onClose(back);
  };
  const outside = (e: Event): void => {
    const t = e.target;
    // Seul un clic sur mon propre repère est épargné (il rouvre ou bascule le menu) ; un clic sur celui d'un autre ferme.
    if (!(t instanceof Element) || root.contains(t) || t.closest('.lp-note.is-mine')) return;
    dismiss(false);
  };
  const btn = (cls: string, text: string, label?: string): HTMLButtonElement => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  };

  function renderList(): void {
    root.replaceChildren(el('p', 'lp-nm-t', notes.length > 1 ? 'Mes réactions' : 'Ma réaction'));
    for (const n of notes) {
      const row = el('div', 'lp-nm-row');
      const what = n.kind === 'emoji' ? n.body : '« ' + n.body + ' »';
      row.append(el('span', 'lp-nm-w' + (n.kind === 'emoji' ? ' is-emoji' : ''), n.body), el('span', 'lp-nm-c', clockOf(n)));
      const edit = btn('lp-nm-b', 'Modifier', 'Modifier ma réaction ' + what + ' à ' + clockOf(n));
      edit.addEventListener('click', () => { view = { kind: 'edit', id: n.id }; render(); });
      const del = btn('lp-nm-b is-danger', 'Supprimer', 'Supprimer ma réaction ' + what + ' à ' + clockOf(n));
      del.addEventListener('click', () => { view = { kind: 'confirm', id: n.id }; render(); });
      row.append(edit, del);
      root.append(row);
    }
    const first = root.querySelector<HTMLElement>('.lp-nm-b');
    if (first) first.focus({ preventScroll: true });
  }

  function renderConfirm(n: Note): void {
    const cancel = btn('lp-nm-b', 'Annuler');
    cancel.addEventListener('click', () => { view = { kind: 'list' }; render(); });
    const ok = btn('lp-nm-b is-danger', 'Confirmer', 'Confirmer la suppression de ma réaction à ' + clockOf(n));
    ok.addEventListener('click', () => { opts.onDelete(n.id); dismiss(true); });
    const acts = el('div', 'lp-nm-acts');
    acts.append(cancel, ok);
    const ask = el('p', 'lp-nm-t', 'Supprimer cette réaction ?');
    ask.setAttribute('role', 'alert');
    root.replaceChildren(ask, el('p', 'lp-nm-sub', n.body), acts);
    cancel.focus({ preventScroll: true });
  }

  function renderEdit(n: Note): void {
    let kind: NoteKind = n.kind;
    let body = n.body;
    const title = el('p', 'lp-nm-t');
    title.append('Modifier la réaction à ', el('b', 'lp-nm-clock', clockOf(n)));

    const emojis = el('div', 'lp-react-emo');
    emojis.setAttribute('role', 'group');
    emojis.setAttribute('aria-label', 'Choisir un emoji');
    const form = el('form', 'lp-react-f');
    const input = el('input', 'lp-react-in');
    input.type = 'text';
    input.maxLength = NOTE_MAX;
    input.autocomplete = 'off';
    input.value = n.kind === 'text' ? n.body : '';
    input.placeholder = 'Ou une note (' + NOTE_MAX + ')';
    input.setAttribute('aria-label', 'Note texte, ' + NOTE_MAX + ' caractères au plus');
    const count = el('span', 'lp-react-c');
    const save = el('button', 'lp-nm-b is-primary', 'Enregistrer');
    save.type = 'submit';
    const cancel = btn('lp-nm-b', 'Annuler');
    cancel.addEventListener('click', () => { view = { kind: 'list' }; render(); });
    const acts = el('div', 'lp-nm-acts');
    acts.append(cancel, save);

    const picks: Array<[string, HTMLButtonElement]> = [];
    const sync = (): void => {
      count.textContent = noteLength(input.value) + ' / ' + NOTE_MAX;
      for (const [e, b] of picks) b.setAttribute('aria-pressed', String(kind === 'emoji' && body === e));
      const next = noteBody(kind, body);
      save.disabled = next === null || (kind === n.kind && next === n.body);
    };
    for (const e of QUICK_EMOJIS) {
      const b = btn('lp-react-e', e, 'Choisir ' + (EMOJI_LABEL[e] ? EMOJI_LABEL[e] + ' ' : '') + e);
      b.addEventListener('click', () => { kind = 'emoji'; body = e; input.value = ''; sync(); });
      picks.push([e, b]);
      emojis.append(b);
    }
    input.addEventListener('input', () => { kind = 'text'; body = input.value; sync(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = noteBody(kind, body);
      if (next === null || (kind === n.kind && next === n.body)) return;
      opts.onEdit(n.id, kind, next);
      dismiss(true);
    });
    // Annuler et Enregistrer sont dans le formulaire pour que Entrée enregistre depuis le champ.
    form.append(input, count, acts);
    sync();
    root.replaceChildren(title, emojis, form);
    const pressed = picks.find(([e]) => kind === 'emoji' && body === e);
    (pressed ? pressed[1] : input).focus({ preventScroll: true });
  }

  function render(): void {
    const n = view.kind === 'list' ? null : find(view.id);
    if (view.kind !== 'list' && !n) view = { kind: 'list' };
    if (view.kind === 'edit' && n) renderEdit(n);
    else if (view.kind === 'confirm' && n) renderConfirm(n);
    else renderList();
  }

  // Échap ferme le menu sans atteindre les raccourcis du lecteur.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    dismiss(true);
  });
  // L'appui dans le menu ne lance pas un glissement de la barre.
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  return {
    el: root,
    open(anchor, mine, host) {
      notes = [...mine];
      view = { kind: 'list' };
      pos = anchor.dataset.pos ?? '';
      if (!open) document.addEventListener('pointerdown', outside, true);
      open = true;
      root.hidden = false;
      render();
      // Ancré au marqueur (hors petit écran, où le CSS le met en pleine largeur).
      const h = host ? host.getBoundingClientRect() : null;
      if (host && h && h.width > 640) {
        const a = anchor.getBoundingClientRect();
        const w = root.offsetWidth || 320;
        root.style.left = Math.round(Math.min(Math.max(8, a.left + a.width / 2 - h.left - w / 2), Math.max(8, h.width - w - 8))) + 'px';
        root.style.right = 'auto';
      } else {
        root.style.left = '';
        root.style.right = '';
      }
    },
    refresh(all) {
      if (!open) return;
      const byId = new Map(all.map((n) => [n.id, n]));
      const next = notes.map((n) => byId.get(n.id)).filter((n): n is Note => !!n);
      if (!next.length) { dismiss(false); return; }
      const changed = next.length !== notes.length || next.some((n, i) => n !== notes[i]);
      if (!changed) return;
      notes = next;
      // Une édition ou une confirmation en cours n'est pas écrasée par la mise à jour d'une autre note.
      if (view.kind === 'list' || !find(view.id)) { view = { kind: 'list' }; render(); }
    },
    close() {
      if (open) document.removeEventListener('pointerdown', outside, true);
      open = false;
      root.hidden = true;
      root.replaceChildren();
    },
    isOpen: () => open,
    anchorPos: () => pos,
  };
}
