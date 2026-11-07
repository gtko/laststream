// LAST-1614 : une réaction d'ami arrivée en direct s'affiche tout de suite (sans attendre que la lecture franchisse sa
// position), en grand, avec une file pour ne pas empiler les emojis.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/data/socialV2Api';

const h = vi.hoisted(() => {
  const flash = vi.fn();
  return {
    flash,
    live: { cb: null as null | ((m: unknown, n: unknown) => void) },
    S: { P: null as any, ui: { showNoteFlash: flash, setNotesAvailable: vi.fn(), setHeat: vi.fn(), setNoteMarkers: vi.fn(), setFriendChip: vi.fn() } },
  };
});
const { flash, S } = h;

vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onNote: (cb: (m: unknown, n: unknown) => void) => { h.live.cb = cb; return () => { h.live.cb = null; }; },
  onNoteRemoved: () => () => undefined,
  getState: () => ({ me: { pid: 'p-me' } }),
  subscribe: () => () => undefined,
  endCinema: vi.fn(), loadPrefs: vi.fn(), sendMessage: vi.fn(), setCinemaHidden: vi.fn(), startCinema: vi.fn(),
}));
vi.mock('../src/data/socialV2Api', () => ({ deleteNote: vi.fn(), getNotes: () => new Promise(() => undefined), postNote: vi.fn(), updateNote: vi.fn() }));
vi.mock('../src/data/socialV3Api', () => ({ getHeatmap: () => new Promise(() => undefined), getMissed: vi.fn() }));
vi.mock('../src/relay/sourceUrl', () => ({ relayableUrl: vi.fn() }));
vi.mock('../src/player/presenceV2', () => ({ setPresenceMedia: vi.fn() }));
vi.mock('../src/ui/socialHooks.js', () => ({ openShareDialog: vi.fn() }));
vi.mock('../src/player/sessionActions.js', () => ({ seekTo: vi.fn() }));
vi.mock('../src/player/sessionPlay.js', () => ({ resolveMedia: vi.fn() }));
vi.mock('../src/player/sessionTracks.js', () => ({ allSubtitleTracks: () => [] }));
vi.mock('../src/player/sessionState.js', () => ({ S: h.S, notesAllowed: () => true }));

import { startNotes } from '../src/player/sessionSocial.js';
import { LIVE_WINDOW_SEC, liveFlashDue } from '../src/player/notesTimeline';
import { createReactionQueue } from '../src/player/reactionFx';

const NOW = 1_800_000_000_000;
const note = (id: string, pos: number, extra: Partial<Note> = {}): Note => ({
  id, pos, kind: 'emoji', body: '🔥', createdAt: NOW,
  author: { pid: 'p-ami', handle: { name: 'Lou', tag: 'B2C3', full: 'Lou#B2C3' }, avatarColor: '#7b5bf5' },
  ...extra,
});
const MEDIA = { type: 'movie', tmdbId: 7 };

describe('liveFlashDue', () => {
  const ctx = { now: NOW, mePid: 'p-me', known: [] as Note[] };
  it("affiche une réaction fraîche d'un ami proche de la position", () => {
    expect(liveFlashDue(note('a', 100), 100, ctx)).toBe(true);
    expect(liveFlashDue(note('a', 100 + LIVE_WINDOW_SEC), 100, ctx)).toBe(true);
  });
  it('ignore les notes lointaines, anciennes, déjà connues (édition) ou de soi', () => {
    expect(liveFlashDue(note('a', 100 + LIVE_WINDOW_SEC + 1), 100, ctx)).toBe(false);
    expect(liveFlashDue(note('a', 100, { createdAt: NOW - 120_000 }), 100, ctx)).toBe(false);
    expect(liveFlashDue(note('a', 100), 100, { ...ctx, known: [note('a', 100)] })).toBe(false);
    expect(liveFlashDue(note('a', 100, { author: { ...note('x', 1).author, pid: 'p-me' } }), 100, ctx)).toBe(false);
    expect(liveFlashDue(note('a', 100), Number.NaN, ctx)).toBe(false);
  });
});

describe('startNotes : réaction reçue en direct', () => {
  beforeEach(() => {
    flash.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    S.P = { addon: false, req: { id: '7', type: 'movie' }, cur: {}, engine: { state: () => ({ time: 100 }) }, notes: null };
    startNotes(S.P);
  });

  it("affiche tout de suite la réaction d'un ami posée près de la lecture, une seule fois", () => {
    h.live.cb!(MEDIA, note('a', 98));
    expect(flash).toHaveBeenCalledTimes(1);
    expect(flash.mock.calls[0][0].id).toBe('a');
    h.live.cb!(MEDIA, note('a', 98)); // édition ou doublon : pas de second flash
    expect(flash).toHaveBeenCalledTimes(1);
  });

  it('garde en marqueur, sans flash, une réaction loin de la lecture', () => {
    h.live.cb!(MEDIA, note('b', 4000));
    expect(flash).not.toHaveBeenCalled();
    expect(S.P.notes.list.map((n: Note) => n.id)).toEqual(['b']);
  });
});

describe('createReactionQueue', () => {
  it('limite les emojis visibles, les range en file et les libère au fil du temps', () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const q = createReactionQueue((it) => shown.push(it.emoji), { maxVisible: 2, gapMs: 100, lifeMs: 1000, maxPending: 5 });
    for (let i = 0; i < 4; i++) q.push({ emoji: String(i), name: 'Lou' });
    expect(shown).toEqual(['0']);
    vi.advanceTimersByTime(100);
    expect(shown).toEqual(['0', '1']);
    vi.advanceTimersByTime(500);
    expect(shown).toEqual(['0', '1']); // plein : '2' attend
    vi.advanceTimersByTime(600);
    expect(shown).toEqual(['0', '1', '2', '3']);
  });

  it('abandonne les plus anciens au-delà de la file maximale', () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const q = createReactionQueue((it) => shown.push(it.emoji), { maxVisible: 1, gapMs: 10, lifeMs: 50, maxPending: 2 });
    for (let i = 0; i < 50; i++) q.push({ emoji: String(i), name: 'x' });
    vi.advanceTimersByTime(5000);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown[shown.length - 1]).toBe('49');
  });
});
