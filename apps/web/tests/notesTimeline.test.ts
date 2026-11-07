// Notes de la timeline du lecteur (Social v2, lot 4a) : franchissement, retour en arrière, regroupement sur la barre,
// validation des corps de note, et rendu DOM (texte échappé, marqueurs, popover « Réagir ici »).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_JUMP, NOTE_MAX, QUICK_EMOJIS, clusterNotes, crossing, isEmoji, markerPct, mediaKey, noteBody, rearmed, safeColor, uniqueNotes, upsertNotes,
} from '../src/player/notesTimeline';
import {
  createNoteMenu, createReactPanel, nearestMarker, noteFlashEl, renderNoteMarkers, type NoteMenu, type OwnNotes,
} from '../src/player/notesView';
import type { Note } from '../src/data/socialV2Api';

const note = (id: string, pos: number, extra: Partial<Note> = {}): Note => ({
  id, pos, kind: 'text', body: 'bien vu', createdAt: 0,
  author: { pid: 'p-' + id, handle: { name: 'Lou', tag: 'B2C3', full: 'Lou#B2C3' }, avatarColor: '#7b5bf5' },
  ...extra,
});

describe('crossing : notes franchies par une lecture normale', () => {
  it('franchit une note située dans (prévu, courant]', () => {
    expect(crossing(9.9, 10.1, [note('a', 10)]).map((n) => n.id)).toEqual(['a']);
  });

  it('inclut une note exactement à la position courante, pas celle exactement à la position précédente', () => {
    expect(crossing(9.8, 10, [note('a', 10)]).map((n) => n.id)).toEqual(['a']);
    expect(crossing(10, 10.2, [note('a', 10)])).toEqual([]);
  });

  it('accepte un saut égal à MAX_JUMP et refuse un saut plus grand (seek)', () => {
    expect(MAX_JUMP).toBe(3);
    expect(crossing(100, 103, [note('a', 102)]).map((n) => n.id)).toEqual(['a']);
    expect(crossing(100, 103.1, [note('a', 102)])).toEqual([]);
    expect(crossing(100, 130, [note('a', 110)])).toEqual([]);
  });

  it('ne franchit rien au retour en arrière, à l’immobilité ou pour des valeurs non finies', () => {
    expect(crossing(20, 15, [note('a', 17)])).toEqual([]);
    expect(crossing(20, 20, [note('a', 20)])).toEqual([]);
    expect(crossing(Number.NaN, 10, [note('a', 10)])).toEqual([]);
    expect(crossing(9, Number.POSITIVE_INFINITY, [note('a', 10)])).toEqual([]);
  });

  it('exclut les notes déjà franchies et ne renvoie jamais deux fois le même id', () => {
    expect(crossing(9, 10.5, [note('a', 10)], { fired: new Set(['a']) })).toEqual([]);
    expect(crossing(9, 10.5, [note('a', 10), note('a', 10)]).map((n) => n.id)).toEqual(['a']);
  });

  it('respecte une limite de saut personnalisée et renvoie les notes dans l’ordre des positions', () => {
    expect(crossing(0, 5, [note('a', 4)], { maxJump: 10 }).map((n) => n.id)).toEqual(['a']);
    expect(crossing(9.9, 10.3, [note('b', 10.2), note('a', 10.1)]).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('rearmed : retour en arrière', () => {
  it('relâche les notes de la zone revisitée (curPos exclu, prevPos inclus)', () => {
    const notes = [note('a', 95), note('b', 99.8), note('c', 90), note('d', 101)];
    expect(rearmed(100, 90, notes)).toEqual(['a', 'b']);
  });

  it('ne relâche rien pour un petit recul ou une avance', () => {
    expect(rearmed(100, 99.8, [note('a', 99.9)])).toEqual([]);
    expect(rearmed(90, 100, [note('a', 95)])).toEqual([]);
  });

  it('une note revisitée s’affiche de nouveau en repassant par là', () => {
    const list = [note('a', 10)];
    const fired = new Set<string>();
    const step = (prev: number, cur: number): string[] => {
      for (const id of rearmed(prev, cur, list)) fired.delete(id);
      const hits = crossing(prev, cur, list, { fired }).map((n) => n.id);
      for (const id of hits) fired.add(id);
      return hits;
    };
    expect(step(9.8, 10)).toEqual(['a']);
    expect(step(10, 10.1)).toEqual([]);
    expect(step(10.1, 0)).toEqual([]); // retour au début : la note est relâchée
    expect(step(9.8, 10)).toEqual(['a']);
  });
});

describe('positionnement et regroupement sur la barre', () => {
  it('markerPct donne la position en % et refuse durée inconnue ou position hors vidéo', () => {
    expect(markerPct(0, 100)).toBe(0);
    expect(markerPct(50, 200)).toBe(25);
    expect(markerPct(100.5, 100)).toBe(100);
    expect(markerPct(102, 100)).toBeNull();
    expect(markerPct(-1, 100)).toBeNull();
    expect(markerPct(10, 0)).toBeNull();
    expect(markerPct(Number.NaN, 100)).toBeNull();
  });

  it('regroupe les notes qui se touchent sur la barre et place le groupe à la moyenne', () => {
    const clusters = clusterNotes([note('a', 10), note('b', 10.5), note('c', 500)], 1000);
    expect(clusters.map((c) => c.notes.length)).toEqual([2, 1]);
    expect(clusters[0].pct).toBeCloseTo(1.025, 5);
    expect(clusters[1].pct).toBeCloseTo(50, 5);
  });

  it('enchaîne les proximités en un seul groupe', () => {
    const clusters = clusterNotes([note('a', 0), note('b', 9), note('c', 18), note('d', 27)], 1000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].notes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignore les notes hors de la vidéo et renvoie rien sans durée', () => {
    expect(clusterNotes([note('a', 10)], 0)).toEqual([]);
    expect(clusterNotes([note('a', 5000)], 1000)).toEqual([]);
    expect(clusterNotes([], 1000)).toEqual([]);
  });

  it('uniqueNotes dédoublonne par id et trie par position', () => {
    expect(uniqueNotes([note('b', 5), note('a', 1), note('a', 1)]).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('validation des notes et des couleurs', () => {
  it('mediaKey distingue film, épisode et absence de saison', () => {
    expect(mediaKey({ type: 'series', tmdbId: 1399, season: 1, episode: 2 })).toBe('series:1399:1:2');
    expect(mediaKey({ type: 'movie', tmdbId: 603 })).toBe('movie:603::');
    expect(mediaKey({ type: 'movie', tmdbId: '603', season: null })).toBe('movie:603::');
  });

  it('mediaKey traite une saison ou un épisode absent d’une série comme 0 (le serveur les omet à 0)', () => {
    expect(mediaKey({ type: 'series', tmdbId: 1, episode: 5 })).toBe('series:1:0:5');
    expect(mediaKey({ type: 'series', tmdbId: 1, episode: 5 })).toBe(mediaKey({ type: 'series', tmdbId: 1, season: 0, episode: 5 }));
    expect(mediaKey({ type: 'series', tmdbId: 1, season: 2 })).toBe('series:1:2:0');
    expect(mediaKey({ type: 'movie', tmdbId: 603, season: 0, episode: 0 })).toBe('movie:603::');
  });

  it('noteBody rogne un texte et refuse le vide ou plus de 140 caractères', () => {
    expect(NOTE_MAX).toBe(140);
    expect(noteBody('text', '  salut  ')).toBe('salut');
    expect(noteBody('text', '   ')).toBeNull();
    expect(noteBody('text', 'a'.repeat(140))).toBe('a'.repeat(140));
    expect(noteBody('text', 'a'.repeat(141))).toBeNull();
    expect(noteBody('text', 'é'.repeat(140))).toBe('é'.repeat(140));
  });

  it('noteBody accepte un seul emoji (variante et modificateur compris), pas une suite', () => {
    expect(noteBody('emoji', ' 👍 ')).toBe('👍');
    expect(noteBody('emoji', '❤️')).toBe('❤️');
    expect(noteBody('emoji', '👍🏽')).toBe('👍🏽');
    expect(noteBody('emoji', '👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(noteBody('emoji', '👍👍')).toBeNull();
    expect(noteBody('emoji', 'ok')).toBeNull();
    expect(QUICK_EMOJIS.every((e) => isEmoji(e))).toBe(true);
  });

  it('safeColor garde les couleurs d’avatar sûres et remplace le reste', () => {
    expect(safeColor('#7b5bf5')).toBe('#7b5bf5');
    expect(safeColor(' #abc ')).toBe('#abc');
    expect(safeColor('hsl(120, 50%, 40%)')).toBe('hsl(120, 50%, 40%)');
    expect(safeColor('red')).not.toBe('red');
    expect(safeColor('#fff;background:url(http://x)')).not.toContain('url');
    expect(safeColor(undefined)).not.toBe('');
  });
});

describe('upsertNotes : ajout et édition sans doublon', () => {
  it('une note de même identifiant remplace l’ancienne, les autres sont gardées, triées par position', () => {
    const list = [note('a', 30), note('b', 10)];
    const out = upsertNotes(list, [note('a', 30, { kind: 'emoji', body: '🔥' })]);
    expect(out.map((n) => n.id)).toEqual(['b', 'a']);
    expect(out[1]).toMatchObject({ kind: 'emoji', body: '🔥', pos: 30 });
  });

  it('ajoute les notes nouvelles sans modifier la liste d’origine', () => {
    const list = [note('a', 20)];
    const out = upsertNotes(list, [note('b', 5)]);
    expect(out.map((n) => n.id)).toEqual(['b', 'a']);
    expect(list.map((n) => n.id)).toEqual(['a']);
  });
});

describe('rendu DOM', () => {
  it('rend un marqueur par groupe, texte échappé, sans HTML injecté', () => {
    const container = document.createElement('div');
    const evil = note('a', 10, { body: '<img src=x onerror="alert(1)">', author: { pid: 'x', handle: { name: '<b>Ev</b>', tag: 'AAAA', full: '<b>Ev</b>#AAAA' }, avatarColor: 'red;background:url(http://x)' } });
    renderNoteMarkers(container, clusterNotes([evil], 1000), () => undefined);
    expect(container.querySelectorAll('.lp-note')).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    const dot = container.querySelector('.lp-note-dot') as HTMLElement;
    expect(dot.style.background).not.toContain('url');
    const marker = container.querySelector('.lp-note') as HTMLElement;
    expect(parseFloat(marker.style.left)).toBeCloseTo(1, 5);
  });

  it('un appui sur un marqueur ne remonte pas à la barre de progression (pas de capture du pointeur)', () => {
    const bar = document.createElement('div');
    const container = document.createElement('div');
    bar.append(container);
    const onBar = vi.fn();
    bar.addEventListener('pointerdown', onBar);
    renderNoteMarkers(container, clusterNotes([note('a', 10)], 1000), () => undefined);
    (container.querySelector('.lp-note') as HTMLElement).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onBar).not.toHaveBeenCalled();
    bar.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onBar).toHaveBeenCalledTimes(1);
  });

  it('un groupe affiche son nombre et un clic amène à la première note', () => {
    const container = document.createElement('div');
    const onSeek = vi.fn();
    renderNoteMarkers(container, clusterNotes([note('a', 10), note('b', 10.4)], 1000), onSeek);
    const marker = container.querySelector('.lp-note') as HTMLButtonElement;
    expect(marker.querySelector('.lp-note-n')?.textContent).toBe('2');
    expect(marker.getAttribute('aria-label')).toContain('2 réactions');
    marker.click();
    expect(onSeek).toHaveBeenCalledWith(10);
  });

  it('l’aperçu liste auteur et texte, et le reste en compte au-delà de trois notes', () => {
    const container = document.createElement('div');
    const notes = [note('a', 10), note('b', 10.2), note('c', 10.4), note('d', 10.6, { kind: 'emoji', body: '🔥' })];
    renderNoteMarkers(container, clusterNotes(notes, 1000), () => undefined);
    const card = container.querySelector('.lp-note-card') as HTMLElement;
    expect(card.querySelectorAll('.lp-nc-w')).toHaveLength(3);
    expect(card.querySelector('.lp-nc-m')?.textContent).toBe('+ 1 autres');
    expect(card.querySelector('.lp-nc-w')?.textContent).toBe('Lou');
    expect(container.querySelector('.lp-note')?.getAttribute('aria-label')).toContain('Lou');
    expect(container.textContent).not.toContain('#B2C3');
  });

  it('la bulle de lecture rend emoji ou texte sans HTML', () => {
    const text = noteFlashEl(note('a', 10, { body: '<img src=x onerror="alert(2)">' }));
    expect(text.querySelector('img')).toBeNull();
    expect(text.textContent).toContain('<img src=x onerror="alert(2)">');
    const emoji = noteFlashEl(note('b', 10, { kind: 'emoji', body: '👍' }));
    expect(emoji.querySelector('.lp-nf-e')?.textContent).toBe('👍');
    expect(emoji.querySelector('.lp-nf-w')?.textContent).toBe('Lou');
    expect(emoji.textContent).not.toContain('#');
  });

  it('le popover envoie un emoji, un texte valide, et ferme à Échap', () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const panel = createReactPanel({ onPick, onCancel });
    document.body.append(panel.el);
    expect(panel.isOpen()).toBe(false);
    panel.open('12:34');
    expect(panel.isOpen()).toBe(true);
    expect(panel.el.querySelector('.lp-react-clock')?.textContent).toBe('12:34');
    expect(panel.el.querySelectorAll('.lp-react-e')).toHaveLength(QUICK_EMOJIS.length);

    (panel.el.querySelector('.lp-react-e') as HTMLButtonElement).click();
    expect(onPick).toHaveBeenLastCalledWith('emoji', QUICK_EMOJIS[0]);

    const input = panel.el.querySelector('.lp-react-in') as HTMLInputElement;
    const send = panel.el.querySelector('.lp-react-send') as HTMLButtonElement;
    const count = panel.el.querySelector('.lp-react-c') as HTMLElement;
    expect(send.disabled).toBe(true);
    input.value = '  Bonjour  ';
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(false);
    expect(count.textContent).toBe('11 / ' + NOTE_MAX);
    panel.el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onPick).toHaveBeenLastCalledWith('text', 'Bonjour');
    expect(input.value).toBe('');

    input.value = 'a'.repeat(141);
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(true);

    panel.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    panel.close();
    expect(panel.isOpen()).toBe(false);
    panel.el.remove();
  });
});

/** Notes de l'utilisateur courant (auteur `me`), pour le marquage « mes réactions ». */
const MINE = { pid: 'me', handle: { name: 'Moi', tag: 'AAAA', full: 'Moi#AAAA' }, avatarColor: '#7b5bf5' };
const mineNote = (id: string, pos: number): Note => note(id, pos, { author: MINE });
const ownNotes = (onMenu: OwnNotes['onMenu']): OwnNotes => ({ mine: (n) => n.author.pid === 'me', onMenu });

describe('nearestMarker : focus rendu après un nouveau rendu des repères', () => {
  const marker = (pos: string): HTMLElement => {
    const b = document.createElement('button');
    b.dataset.pos = pos;
    return b;
  };

  it('retrouve le repère de même position', () => {
    const a = marker('10'), b = marker('42.5');
    expect(nearestMarker([a, b], '42.5')).toBe(b);
  });

  it('retombe sur le repère le plus proche quand le sien a disparu', () => {
    const a = marker('10'), b = marker('60');
    expect(nearestMarker([a, b], '50')).toBe(b);
    expect(nearestMarker([a, b], '20')).toBe(a);
  });

  it('renvoie null sans repère ou sans position valable', () => {
    expect(nearestMarker([], '10')).toBeNull();
    expect(nearestMarker([marker('10')], '')).toBeNull();
    expect(nearestMarker([marker('10')], 'x')).toBeNull();
  });
});

describe('marqueurs de ses propres réactions', () => {
  it('sans own, ou pour les notes d’un autre : ni is-mine ni menu, le clic amène seulement à la note', () => {
    const onSeek = vi.fn();
    const onMenu = vi.fn();
    const plain = document.createElement('div');
    renderNoteMarkers(plain, clusterNotes([mineNote('m', 10)], 1000), onSeek);
    const others = document.createElement('div');
    renderNoteMarkers(others, clusterNotes([note('a', 10)], 1000), onSeek, ownNotes(onMenu));
    for (const box of [plain, others]) {
      const marker = box.querySelector('.lp-note') as HTMLButtonElement;
      expect(marker.classList.contains('is-mine')).toBe(false);
      expect(marker.hasAttribute('aria-haspopup')).toBe(false);
      marker.click();
    }
    expect(onSeek).toHaveBeenCalledTimes(2);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('avec mes notes : un clic amène à la note et ouvre le menu sur mes réactions', () => {
    const onSeek = vi.fn();
    const onMenu = vi.fn();
    const container = document.createElement('div');
    renderNoteMarkers(container, clusterNotes([mineNote('m', 10)], 1000), onSeek, ownNotes(onMenu));
    const marker = container.querySelector('.lp-note') as HTMLButtonElement;
    expect(marker.classList.contains('is-mine')).toBe(true);
    expect(marker.getAttribute('aria-label')).toContain('la tienne');
    marker.click();
    expect(onSeek).toHaveBeenCalledWith(10);
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(onMenu).toHaveBeenCalledWith(marker, [expect.objectContaining({ id: 'm' })]);
  });

  it('une note optimiste tmp- n’est pas modifiable : pas de marque ni de menu', () => {
    const onMenu = vi.fn();
    const container = document.createElement('div');
    renderNoteMarkers(container, clusterNotes([mineNote('tmp-1', 10)], 1000), () => undefined, ownNotes(onMenu));
    const marker = container.querySelector('.lp-note') as HTMLButtonElement;
    expect(marker.classList.contains('is-mine')).toBe(false);
    marker.click();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('dans un groupe mêlé, le menu ne reçoit que mes notes enregistrées', () => {
    const onMenu = vi.fn();
    const container = document.createElement('div');
    const cluster = clusterNotes([mineNote('tmp-1', 10), mineNote('m', 10.4), note('a', 10.6)], 1000);
    renderNoteMarkers(container, cluster, () => undefined, ownNotes(onMenu));
    const marker = container.querySelector('.lp-note') as HTMLButtonElement;
    expect(marker.classList.contains('is-mine')).toBe(true);
    marker.click();
    expect(onMenu).toHaveBeenCalledWith(marker, [expect.objectContaining({ id: 'm' })]);
  });
});

describe('menu de ses réactions : modifier et supprimer', () => {
  const mounted: Array<{ menu: NoteMenu; host: HTMLElement }> = [];
  afterEach(() => {
    for (const { menu, host } of mounted.splice(0)) {
      menu.close();
      host.remove();
    }
  });

  /** Monte le menu dans le document, ouvert sur `notes`, avec des gestionnaires espions. */
  function mount(notes: Note[]) {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const menu = createNoteMenu({ onEdit, onDelete, onClose });
    const host = document.createElement('div');
    const anchor = document.createElement('button');
    anchor.dataset.pos = '10';
    host.append(anchor, menu.el);
    document.body.append(host);
    mounted.push({ menu, host });
    menu.open(anchor, notes);
    return { menu, onEdit, onDelete, onClose };
  }

  /** Bouton du menu dont le texte est exactement `text`. */
  const btn = (root: HTMLElement, text: string): HTMLButtonElement => {
    const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!found) throw new Error('bouton absent : ' + text);
    return found;
  };

  it('Modifier, un emoji, puis Enregistrer appelle onEdit avec l’id, le genre et le corps', () => {
    const { menu, onEdit } = mount([mineNote('m1', 10)]);
    btn(menu.el, 'Modifier').click();
    btn(menu.el, '🔥').click();
    btn(menu.el, 'Enregistrer').click();
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('m1', 'emoji', '🔥');
  });

  it('Modifier un texte : la correction est enregistrée rognée, Enregistrer reste inactif sans changement', () => {
    const { menu, onEdit } = mount([mineNote('m1', 10)]);
    btn(menu.el, 'Modifier').click();
    const input = menu.el.querySelector('input') as HTMLInputElement;
    const save = btn(menu.el, 'Enregistrer');
    expect(input.value).toBe('bien vu');
    expect(save.disabled).toBe(true);
    input.value = '  très bien  ';
    input.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(false);
    save.click();
    expect(onEdit).toHaveBeenCalledWith('m1', 'text', 'très bien');
  });

  it('Supprimer seul ne supprime rien : c’est Confirmer qui appelle onDelete, puis le menu se ferme', () => {
    const { menu, onDelete, onClose } = mount([mineNote('m1', 10)]);
    btn(menu.el, 'Supprimer').click();
    expect(menu.el.textContent).toContain('Supprimer cette réaction ?');
    expect(onDelete).not.toHaveBeenCalled();
    btn(menu.el, 'Confirmer').click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('m1');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('Annuler dans la confirmation revient à la liste sans supprimer', () => {
    const { menu, onDelete } = mount([mineNote('m1', 10)]);
    btn(menu.el, 'Supprimer').click();
    btn(menu.el, 'Annuler').click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(menu.el.textContent).not.toContain('Supprimer cette réaction ?');
    expect(menu.el.querySelector('.lp-nm-b')?.textContent).toBe('Modifier');
  });

  it('Annuler dans l’édition revient à la liste sans enregistrer', () => {
    const { menu, onEdit } = mount([mineNote('m1', 10)]);
    btn(menu.el, 'Modifier').click();
    btn(menu.el, 'Annuler').click();
    expect(onEdit).not.toHaveBeenCalled();
    expect(menu.el.querySelector('.lp-nm-b')?.textContent).toBe('Modifier');
  });

  it('Échap ferme le menu (onClose appelé avec back = true)', () => {
    const { menu, onClose } = mount([mineNote('m1', 10)]);
    menu.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('refresh demande la fermeture (onClose, sans retour) quand il ne reste aucune de mes notes', () => {
    const { menu, onClose } = mount([mineNote('m1', 10)]);
    menu.refresh([note('autre', 12)]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('refresh reste en vue d’édition quand une autre note du même groupe change', () => {
    const m1 = mineNote('m1', 10);
    const m2 = mineNote('m2', 10.4);
    const { menu, onClose } = mount([m1, m2]);
    btn(menu.el, 'Modifier').click();
    const input = menu.el.querySelector('input') as HTMLInputElement;
    input.value = 'en cours';
    input.dispatchEvent(new Event('input'));
    menu.refresh([m1, { ...m2, body: 'changé' }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(menu.el.querySelector('input')).toBe(input);
    expect(input.value).toBe('en cours');
    expect(menu.el.querySelector('.lp-nm-clock')).not.toBeNull();
  });

  it('un clic sur le repère d’une autre personne ferme le menu, pas sur un de mes repères', () => {
    const { menu, onClose } = mount([mineNote('m1', 10)]);
    const mine = document.createElement('button');
    mine.className = 'lp-note is-mine';
    const other = document.createElement('button');
    other.className = 'lp-note';
    document.body.append(mine, other);
    try {
      mine.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
      other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(false);
    } finally {
      mine.remove();
      other.remove();
      menu.close();
    }
  });
});
