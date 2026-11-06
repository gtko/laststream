// LAST-1615 : une réaction emoji de salon part par le WebSocket du salon et ne s'affiche qu'une fois (l'écho du salon). La note
// est postée en silence pour les marqueurs et la carte de chaleur. Hors salon, le chemin d'origine ne change pas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const flash = vi.fn();
  const toast = vi.fn();
  return {
    flash,
    toast,
    postNote: vi.fn(),
    allowed: { value: true },
    live: { cb: null as null | ((m: unknown, n: unknown) => void) },
    S: {
      P: null as any,
      bubble: null,
      ui: { showNoteFlash: flash, toast, setNotesAvailable: vi.fn(), setHeat: vi.fn(), setNoteMarkers: vi.fn(), setFriendChip: vi.fn(), openReact: vi.fn(), closeCinemaMenu: vi.fn() },
    },
  };
});
const { flash, toast, S } = h;

vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onNote: (cb: (m: unknown, n: unknown) => void) => { h.live.cb = cb; return () => { h.live.cb = null; }; },
  onNoteRemoved: () => () => undefined,
  getState: () => ({
    me: { pid: 'p-me', handle: { name: 'Moi', tag: 'A1B2', full: 'Moi#A1B2' }, avatarColor: '#ff5a36' },
    status: 'visible',
    cinema: { active: false, since: 0, until: 0, count: 0, hidden: [] },
  }),
  subscribe: () => () => undefined,
  endCinema: vi.fn(), loadPrefs: vi.fn(), sendMessage: vi.fn(), setCinemaHidden: vi.fn(), startCinema: vi.fn(),
}));
vi.mock('../src/data/socialV2Api', () => ({ deleteNote: vi.fn(), getNotes: () => new Promise(() => undefined), postNote: h.postNote, updateNote: vi.fn() }));
vi.mock('../src/data/socialV3Api', () => ({ getHeatmap: () => new Promise(() => undefined), getMissed: vi.fn() }));
vi.mock('../src/relay/sourceUrl', () => ({ relayableUrl: vi.fn() }));
vi.mock('../src/player/presenceV2', () => ({ setPresenceMedia: vi.fn() }));
vi.mock('../src/ui/socialHooks.js', () => ({ openShareDialog: vi.fn() }));
vi.mock('../src/player/sessionActions.js', () => ({ seekTo: vi.fn() }));
vi.mock('../src/player/sessionPlay.js', () => ({ resolveMedia: vi.fn() }));
vi.mock('../src/player/sessionTracks.js', () => ({ allSubtitleTracks: () => [] }));
vi.mock('../src/player/sessionState.js', () => ({ S: h.S, notesAllowed: () => h.allowed.value }));
vi.mock('../src/player/playbackSocial', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), isTouchLayout: () => false }));

import type { Note } from '../src/data/socialV2Api';
import { notesTick, openReactHere, postReact, startNotes, stopNotes } from '../src/player/sessionSocial.js';
import { partyBridge } from '../src/party/bridge';
import { partyReactLimit } from '../src/party/reactLimit';
import { partyReactMessageOf } from '../src/player/nativeSocial';

const NOW = 1_800_000_000_000;
let clock = NOW;
const MEDIA = { type: 'movie', tmdbId: 7 };
const note = (id: string, pos: number, extra: Partial<Note> = {}): Note => ({
  id, pos, kind: 'emoji', body: '🔥', createdAt: clock,
  author: { pid: 'p-ami', handle: { name: 'Lou', tag: 'B2C3', full: 'Lou#B2C3' }, avatarColor: '#7b5bf5' },
  ...extra,
} as Note);

type Handler = (d: unknown) => void;
let handlers: Record<string, Handler> = {};
/** Client de salon minimal : état, réglages, envoi d'une réaction, et abonnements retenus pour les déclencher. */
const fakeParty = () => {
  handlers = {};
  return {
    status: 'open',
    settings: {} as Record<string, unknown>,
    sendReact: vi.fn((_emoji: string, _pos?: number | null) => true),
    on(ev: string, fn: Handler) { handlers[ev] = fn; return () => { delete handlers[ev]; }; },
  };
};
let client: ReturnType<typeof fakeParty>;
const player = () => ({
  addon: false, req: { id: '7', type: 'movie' }, cur: {}, view: {}, notes: null,
  engine: { state: () => ({ time: 100, duration: 7200 }) },
});

beforeEach(() => {
  clock += 5000; // une minute de marge entre les tests : la limite d'une réaction par seconde ne mélange pas les cas
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  flash.mockClear();
  toast.mockClear();
  h.postNote.mockReset();
  h.postNote.mockImplementation(async (data: { pos: number }) => ({
    note: note('srv-1', data.pos, { author: { pid: 'p-me', handle: { name: 'Moi', tag: 'A1B2', full: 'Moi#A1B2' }, avatarColor: '#ff5a36' } }),
  }));
  h.allowed.value = true;
  client = fakeParty();
  partyBridge.client = client as any;
  S.P = player();
});

afterEach(() => {
  if (S.P) stopNotes(S.P);
  partyBridge.client = null;
  vi.restoreAllMocks();
});

describe('réaction de salon (LAST-1615)', () => {
  it('en salon, l’emoji part par le salon sans flash ni toast local, et la note est postée en silence', async () => {
    startNotes(S.P);
    postReact({ pos: 100, kind: 'emoji', body: '🔥' });
    expect(client.sendReact).toHaveBeenCalledWith('🔥', 100);
    expect(h.postNote).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', tmdbId: 7, pos: 100, kind: 'emoji', body: '🔥' }));
    await vi.waitFor(() => expect(S.P.notes.fired.has('srv-1')).toBe(true));
    expect(flash).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(S.P.notes.list.map((n: Note) => n.id)).toEqual(['srv-1']);
  });

  it('une seule apparition : la note d’un ami reçue pendant le salon ne flashe pas, même quand la lecture la franchit', () => {
    startNotes(S.P);
    h.live.cb!(MEDIA, note('srv-9', 100));
    expect(flash).not.toHaveBeenCalled();
    expect(S.P.notes.fired.has('srv-9')).toBe(true);
    notesTick(S.P, { time: 99.5, paused: false });
    notesTick(S.P, { time: 100.5, paused: false });
    expect(flash).not.toHaveBeenCalled();
    expect(S.P.notes.list.map((n: Note) => n.id)).toEqual(['srv-9']); // reste un marqueur
  });

  it('au plus une réaction de salon par seconde : la seconde est ignorée sans erreur', () => {
    startNotes(S.P);
    postReact({ pos: 100, kind: 'emoji', body: '🔥' });
    postReact({ pos: 101, kind: 'emoji', body: '😂' });
    expect(client.sendReact).toHaveBeenCalledTimes(1);
    expect(h.postNote).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    clock += 1000;
    postReact({ pos: 102, kind: 'emoji', body: '😂' });
    expect(client.sendReact).toHaveBeenCalledTimes(2);
  });

  it('si le salon refuse l’envoi (sendReact faux), le chemin d’origine reprend : note optimiste, flash et post', async () => {
    client.sendReact = vi.fn(() => false);
    startNotes(S.P);
    postReact({ pos: 100, kind: 'emoji', body: '🔥' });
    expect(flash).toHaveBeenCalledTimes(1);
    expect(h.postNote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'emoji', body: '🔥' }));
    await vi.waitFor(() => expect(S.P.notes.fired.has('srv-1')).toBe(true));
  });

  it('en salon sans notes (notesAllowed faux), la réaction part quand même par le salon, sans post de note', () => {
    h.allowed.value = false;
    startNotes(S.P);
    expect(S.P.notes).toBeNull();
    postReact({ pos: 100, kind: 'emoji', body: '🔥' });
    expect(client.sendReact).toHaveBeenCalledWith('🔥', 100);
    expect(h.postNote).not.toHaveBeenCalled();
    expect(flash).not.toHaveBeenCalled();
  });

  it('en salon sans notes, le popover « Réagir ici » s’ouvre quand même', () => {
    h.allowed.value = false;
    startNotes(S.P);
    openReactHere();
    expect(S.ui.openReact).toHaveBeenCalledTimes(1);
  });

  it('hors salon, le chemin d’origine est inchangé : note optimiste, flash et post', () => {
    partyBridge.client = null;
    startNotes(S.P);
    postReact({ pos: 100, kind: 'emoji', body: '🔥' });
    expect(flash).toHaveBeenCalledTimes(1);
    expect(h.postNote).toHaveBeenCalledTimes(1);
  });

  it('en salon, une réaction texte garde le chemin d’origine (rien n’est envoyé au salon)', () => {
    startNotes(S.P);
    postReact({ pos: 100, kind: 'text', body: 'bien vu' });
    expect(client.sendReact).not.toHaveBeenCalled();
    expect(h.postNote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', body: 'bien vu' }));
  });
});

describe('réaction de salon au lecteur natif (LAST-1615)', () => {
  it('le natif reçoit l’écho d’une réaction de salon en bulle (pushMessage), une seule fois', () => {
    const eng = { kind: 'native', state: () => ({ time: 100, duration: 7200 }), pushMessage: vi.fn(), setNotes: vi.fn(), setSocial: vi.fn() };
    S.P = { ...player(), engine: eng };
    startNotes(S.P);
    handlers.react({ user: 'bob', by: 'bob', emoji: '🔥', at: 1, pos: null });
    expect(eng.pushMessage).toHaveBeenCalledTimes(1);
    expect(eng.pushMessage.mock.calls[0][0]).toMatchObject({ from: { name: 'bob' }, body: '🔥' });
  });

  it('réglage « réactions désactivées » : rien n’arrive au natif', () => {
    client.settings = { reactions: 'off' };
    const eng = { kind: 'native', state: () => ({ time: 100, duration: 7200 }), pushMessage: vi.fn(), setNotes: vi.fn(), setSocial: vi.fn() };
    S.P = { ...player(), engine: eng };
    startNotes(S.P);
    handlers.react({ user: 'bob', by: 'bob', emoji: '🔥', at: 1, pos: null });
    expect(eng.pushMessage).not.toHaveBeenCalled();
  });

  it('partyReactMessageOf : bulle au format du natif, rien pour une réaction incomplète', () => {
    expect(partyReactMessageOf({ by: 'bob', emoji: '🔥' }, 'x')).toMatchObject({ id: 'x', body: '🔥', from: { name: 'bob' } });
    expect(partyReactMessageOf({ by: 'bob', emoji: '' }, 'x')).toBeNull();
    expect(partyReactMessageOf({ emoji: '🔥' }, 'x')).toBeNull();
  });
});

describe('limite d’envoi des réactions de salon', () => {
  // Dernier test du fichier : la limite est un état partagé de module, mesuré ici à des instants explicites.
  it('une réaction par seconde, mesurée à l’instant donné', () => {
    const t = clock + 60_000;
    expect(partyReactLimit.ready(t)).toBe(true);
    partyReactLimit.sent(t);
    expect(partyReactLimit.ready(t + 999)).toBe(false);
    expect(partyReactLimit.ready(t + 1000)).toBe(true);
  });
});
