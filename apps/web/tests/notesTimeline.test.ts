// Notes de la timeline du lecteur (Social v2, lot 4a) : franchissement, retour en arrière, regroupement sur la barre,
// validation des corps de note, et rendu DOM (texte échappé, marqueurs, popover « Réagir ici »).
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_JUMP, NOTE_MAX, QUICK_EMOJIS, clusterNotes, crossing, isEmoji, markerPct, mediaKey, noteBody, rearmed, safeColor, uniqueNotes,
} from '../src/player/notesTimeline';
import { createReactPanel, noteFlashEl, renderNoteMarkers } from '../src/player/notesView';
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
    expect(card.querySelector('.lp-nc-w')?.textContent).toBe('Lou#B2C3');
  });

  it('la bulle de lecture rend emoji ou texte sans HTML', () => {
    const text = noteFlashEl(note('a', 10, { body: '<img src=x onerror="alert(2)">' }));
    expect(text.querySelector('img')).toBeNull();
    expect(text.textContent).toContain('<img src=x onerror="alert(2)">');
    const emoji = noteFlashEl(note('b', 10, { kind: 'emoji', body: '👍' }));
    expect(emoji.querySelector('.lp-nf-e')?.textContent).toBe('👍');
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
