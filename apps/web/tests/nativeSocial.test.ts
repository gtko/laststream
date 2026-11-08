import { describe, expect, it, vi } from 'vitest';
import { NativeEngine } from '../src/player/engines.js';
import {
  NATIVE_MORE, NATIVE_QUICK, freshIncoming, handleNativeReact, handleNativeReply, nativeSocialOf, reactionOf, replyOf, roomViewers, toNativeMessage, toNativeNotes, watchingViewers,
} from '../src/player/nativeSocial';
import { REPLY_EMOJIS, SEND_FAILED, SEND_LIMIT } from '../src/player/messageBubble';
import type { Message, Note } from '../src/data/socialV2Api';
import type { SocialState } from '../src/data/socialStore';

const author = (pid: string, name: string) => ({ pid, handle: { name, tag: 'AB12', full: name + '#AB12' }, avatarColor: '#ff0000' });
const note = (id: string, pid: string, pos: number, body: string, kind: 'emoji' | 'text' = 'emoji'): Note => ({
  id, author: author(pid, 'Amy'), pos, kind, body, createdAt: 1,
});
const msg = (id: string, from: string, to: string, createdAt: number, body = 'Salut'): Message =>
  ({ id, conv: 'dm', from, to, kind: 'text', body, reactions: [], createdAt }) as unknown as Message;
function stateWith(messages: Message[], status: 'online' | 'dnd' = 'online'): SocialState {
  return {
    me: { pid: 'me', handle: { name: 'Moi', tag: 'ZZ99', full: 'Moi#ZZ99' }, status: 'online', avatarColor: '#000000' },
    status,
    friends: [{ pid: 'amy', handle: { name: 'Amy', tag: 'AB12', full: 'Amy#AB12' }, avatarColor: '#ff0000' }],
    household: [],
    conversations: [],
    messages: { amy: messages },
  } as unknown as SocialState;
}

describe('pont social natif : mapping', () => {
  it('notes : position, corps, auteur en spectateur ; « mine » seulement pour mon profil', () => {
    const out = toNativeNotes([note('n1', 'me', 12.5, '🔥'), note('n2', 'amy', 90, 'Trop bien', 'text')], 'me');
    expect(out).toEqual([
      { id: 'n1', pos: 12.5, kind: 'emoji', body: '🔥', by: { id: 'me', name: 'Amy', initial: 'A' }, mine: true },
      { id: 'n2', pos: 90, kind: 'text', body: 'Trop bien', by: { id: 'amy', name: 'Amy', initial: 'A' }, mine: false },
    ]);
  });

  it('sans profil connu, aucune note n’est « mine »', () => {
    expect(toNativeNotes([note('n1', 'me', 1, '😂')], null)[0].mine).toBe(false);
  });

  it('rangées : quick = maquette (5), more = le reste (10) ; rien d’autre', () => {
    expect([...NATIVE_QUICK]).toEqual(['😂', '🔥', '😱', '❤️', '🤯']);
    expect([...NATIVE_MORE].sort()).toEqual(['👍', '😮', '😢', '🥹', '😍', '🙌', '💀', '🍿', '😭', '👏'].sort());
  });

  it('setSocial : actif seulement si le social est dispo, profil non enfant, statut visible et hors cinéma', () => {
    const gate = { available: true, kid: false, status: 'online' as const, cinema: false };
    const v = [{ id: 'amy', name: 'Amy', initial: 'A' }];
    expect(nativeSocialOf(gate, v)).toMatchObject({ enabled: true, viewers: v });
    for (const g of [{ ...gate, kid: true }, { ...gate, status: 'invisible' as const }, { ...gate, cinema: true }, { ...gate, available: false }]) {
      const s = nativeSocialOf(g, v);
      expect(s.enabled).toBe(false);
      expect(s.viewers).toEqual([]);
    }
  });

  it('setSocial en salon (LAST-1627) : rangée active sans social amis ; profil enfant toujours exclu', () => {
    const v = [{ id: 'lou', name: 'Lou', initial: 'L' }];
    for (const g of [{ available: false, status: 'invisible' as const, cinema: true }, { available: false, status: 'online' as const, cinema: false }]) {
      expect(nativeSocialOf({ kid: false, room: true, ...g }, v)).toMatchObject({ enabled: true, quick: [...NATIVE_QUICK], viewers: v });
    }
    expect(nativeSocialOf({ available: true, kid: true, status: 'online', cinema: false, room: true }, v)).toMatchObject({ enabled: false, viewers: [] });
  });

  it('spectateurs de salon (LAST-1627) : les membres, sans moi ; sans moi connu, tous', () => {
    const members = [{ username: 'Greg' }, { username: 'Lou' }, { username: 'Ana · salon' }];
    expect(roomViewers(members, 'Greg')).toEqual([{ id: 'Lou', name: 'Lou', initial: 'L' }, { id: 'Ana · salon', name: 'Ana · salon', initial: 'A' }]);
    expect(roomViewers(members, null)).toHaveLength(3);
  });

  it('spectateurs : amis qui regardent le même titre, données fraîches seulement', () => {
    const now = 1_000_000;
    const watch = { type: 'movie', tmdbId: 10, pos: 100, at: now, paused: false, duration: 7200 };
    const f = (pid: string, watching: unknown) => ({ pid, handle: { name: 'Amy', tag: 'AB12', full: 'Amy#AB12' }, avatarColor: '#ff0000', status: 'online', watching });
    const s = { friends: [f('amy', watch), f('bob', { ...watch, tmdbId: 11 }), f('cat', { ...watch, at: now - 200_000 })], household: [] } as unknown as SocialState;
    expect(watchingViewers(s, { type: 'movie', tmdbId: 10 }, now, 7200)).toEqual([{ id: 'amy', name: 'Amy', initial: 'A' }]);
  });
});

describe('pont social natif : messages entrants', () => {
  it('seuls les messages reçus, récents, non vus, triés par arrivée', () => {
    const since = 100_000;
    const list = [msg('m5', 'amy', 'me', 100_800), msg('m1', 'amy', 'me', 100_500), msg('mine', 'me', 'amy', 100_600), msg('old', 'amy', 'me', 69_999), msg('seen', 'amy', 'me', 100_700)];
    const seen = new Set(['seen']);
    expect(freshIncoming(stateWith(list), seen, since).map((m) => m.id)).toEqual(['m1', 'm5']);
    expect(seen.has('m1')).toBe(true);
    expect(freshIncoming(stateWith(list), seen, since)).toEqual([]);
  });

  it('Ne pas déranger : aucun message poussé au natif', () => {
    expect(freshIncoming(stateWith([msg('m1', 'amy', 'me', 100_500)], 'dnd'), new Set(), 100_000)).toEqual([]);
  });

  it('message natif : auteur en spectateur, texte rogné à 120 caractères', () => {
    const out = toNativeMessage(msg('m1', 'amy', 'me', 1, 'x'.repeat(200)), stateWith([]));
    expect(out.from).toEqual({ id: 'amy', name: 'Amy', initial: 'A' });
    expect(out.body.length).toBeLessThanOrEqual(120);
    expect(out.body.endsWith('…')).toBe(true);
  });
});

describe('pont social natif : validation des entrées du natif', () => {
  it('réaction : emoji de la rangée et position finie seulement', () => {
    expect(reactionOf({ emoji: '🔥', pos: 42.4 })).toEqual({ emoji: '🔥', pos: 42.4 });
    expect(reactionOf({ emoji: '🍿', pos: 3 })).toEqual({ emoji: '🍿', pos: 3 });
    expect(reactionOf({ emoji: '<script>', pos: 3 })).toBeNull();
    expect(reactionOf({ emoji: '🔥', pos: Number.NaN })).toBeNull();
    expect(reactionOf({ emoji: '🔥', pos: '3' })).toBeNull();
    expect(reactionOf(null)).toBeNull();
  });

  it('réponse : identifiant non vide et emoji de la bulle seulement', () => {
    for (const r of REPLY_EMOJIS) expect(replyOf({ messageId: 'm1', emoji: r.e })).not.toBeNull();
    expect(replyOf({ messageId: 'm1', emoji: '🔥' })).toBeNull();
    expect(replyOf({ messageId: '', emoji: '😂' })).toBeNull();
  });
});

describe('pont social natif : react et reply avec un faux plugin', () => {
  function fakePlugin(extra: Record<string, unknown> = {}) {
    const handlers = new Map<string, (d: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
      open: vi.fn(async () => {}), close: vi.fn(async () => {}),
      ...extra,
    };
    return { plugin, fire: (ev: string, d: unknown) => handlers.get(ev)?.(d) };
  }
  const opened = async (plugin: ReturnType<typeof fakePlugin>['plugin']) => {
    const e = new NativeEngine(plugin as never);
    await e.load({ url: 'http://serveur.test/v.mkv', startAt: 0, open: {} as never });
    return e;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('react du natif : transmis avec sa position ; valeur invalide ignorée', async () => {
    const { plugin, fire } = fakePlugin();
    const e = await opened(plugin);
    const react = vi.fn();
    e.on('react', (d: unknown) => handleNativeReact(d, { react }));
    fire('react', { emoji: '🔥', pos: 61.5 });
    fire('react', { emoji: 'bad', pos: 1 });
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith(61.5, '🔥');
  });

  it('reply du natif : envoyé à l’auteur du message affiché', async () => {
    const send = vi.fn(async () => ({}));
    const m = msg('m1', 'amy', 'me', 1);
    await handleNativeReply({ messageId: 'm1', emoji: '😂' }, { react: vi.fn(), messageOf: (id) => (id === 'm1' ? m : undefined), send, error: vi.fn() });
    expect(send).toHaveBeenCalledWith('amy', '😂');
  });

  it('reply : message inconnu ou réponse invalide, rien n’est envoyé', async () => {
    const send = vi.fn(async () => ({}));
    const h = { react: vi.fn(), messageOf: () => undefined, send, error: vi.fn() };
    expect(await handleNativeReply({ messageId: 'm9', emoji: '😂' }, h)).toBeNull();
    expect(await handleNativeReply({ messageId: 'm1', emoji: '🔥' }, { ...h, messageOf: () => msg('m1', 'amy', 'me', 1) })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('reply : 429 affiche la limite, un autre échec le message générique', async () => {
    const m = msg('m1', 'amy', 'me', 1);
    const error = vi.fn();
    const base = { react: vi.fn(), messageOf: () => m, error };
    await handleNativeReply({ messageId: 'm1', emoji: '😂' }, { ...base, send: vi.fn(async () => { throw { status: 429 }; }) });
    expect(error).toHaveBeenLastCalledWith(SEND_LIMIT);
    await handleNativeReply({ messageId: 'm1', emoji: '😂' }, { ...base, send: vi.fn(async () => { throw new Error('réseau'); }) });
    expect(error).toHaveBeenLastCalledWith(SEND_FAILED);
  });

  it('socialError du natif : relayé pour affichage', async () => {
    const { plugin, fire } = fakePlugin();
    const e = await opened(plugin);
    const got: string[] = [];
    e.on('socialError', (d: { message: string }) => got.push(d.message));
    fire('socialError', { message: 'Trop de réactions' });
    expect(got).toEqual(['Trop de réactions']);
  });

  it('setSocial, setNotes et pushMessage vont au plugin ; un APK ancien sans ces méthodes ne lève rien', async () => {
    const { plugin } = fakePlugin();
    const e = await opened(plugin);
    const payload = nativeSocialOf({ available: true, kid: false, status: 'online', cinema: false }, []);
    expect(() => { e.setSocial(payload); e.setNotes([]); e.pushMessage({ id: 'm', from: { id: 'a', name: 'A' }, body: 'b' }); }).not.toThrow();
  });

  it('setSocial refusé par un APK ancien (rejet du plugin) : pas d’erreur non gérée, appel tenté', async () => {
    const setSocial = vi.fn(async () => { throw new Error('UNIMPLEMENTED'); });
    const setNotes = vi.fn(async () => {});
    const { plugin } = fakePlugin({ setSocial, setNotes });
    const e = await opened(plugin);
    const payload = nativeSocialOf({ available: true, kid: false, status: 'online', cinema: false }, []);
    e.setSocial(payload);
    e.setNotes([{ id: 'n1', pos: 1, kind: 'emoji', body: '😂', by: { id: 'a', name: 'A' }, mine: false }]);
    await flush();
    expect(setSocial).toHaveBeenCalledWith(payload);
    expect(setNotes).toHaveBeenCalledWith({ notes: [expect.objectContaining({ id: 'n1' })] });
  });
});
