import { describe, expect, it, vi } from 'vitest';
import { NativeEngine } from '../src/player/engines.js';
import { CATCHUP_DRIFT_S, handleNativeReplyText, nativeRoomOf, nativeSocialOf, replyTextOf } from '../src/player/nativeSocial';
import { SEND_FAILED, SEND_LIMIT } from '../src/player/messageBubble';
import { CHAT_MAX_CHARS } from '../src/party/protocol';
import type { Message } from '../src/data/socialV2Api';

/* LAST-1632 : état du salon transmis au lecteur natif (membres, hôte, synchro) et réponse texte saisie dans le natif. */

const client = (n: number, host: boolean, waitingWho: string[] | null = null) => ({
  participants: Array.from({ length: n }, (_, i) => ({ username: 'u' + i })),
  isHost: host,
  waiting: waitingWho ? { who: waitingWho, since: 0, maxMs: 10_000, resumeAhead: 2 } : null,
});
const msg = (id: string, from: string): Message => ({ id, conv: 'dm', from, to: 'me', kind: 'text', body: 'Salut', reactions: [], createdAt: 1 }) as unknown as Message;
const gate = { available: true, kid: false, status: 'online' as const, cinema: false, room: true };

describe('salon natif : état transmis', () => {
  it('membres (moi compris) et rôle', () => {
    expect(nativeRoomOf(client(3, true), null)).toEqual({ members: 3, host: true, sync: 'synced' });
    expect(nativeRoomOf(client(2, false), 0.2)).toEqual({ members: 2, host: false, sync: 'synced' });
    // Liste pas encore reçue : au moins moi.
    expect(nativeRoomOf(client(0, false), null).members).toBe(1);
  });

  it('synchro : rattrapage au-delà du seuil (dans les deux sens), attente prioritaire', () => {
    expect(nativeRoomOf(client(2, false), CATCHUP_DRIFT_S - 0.1).sync).toBe('synced');
    expect(nativeRoomOf(client(2, false), CATCHUP_DRIFT_S).sync).toBe('catching');
    expect(nativeRoomOf(client(2, false), -3).sync).toBe('catching');
    expect(nativeRoomOf(client(2, false), Number.NaN).sync).toBe('synced');
    expect(nativeRoomOf(client(2, false, ['léa']), 5).sync).toBe('waiting');
    // Attente sans membre nommé : pas d'attente affichée.
    expect(nativeRoomOf(client(2, false, []), null).sync).toBe('synced');
  });

  it('setSocial : salon joint en salon seulement, jamais pour un profil enfant ni hors salon', () => {
    const room = nativeRoomOf(client(3, false), null);
    expect(nativeSocialOf(gate, [], room).room).toEqual({ members: 3, host: false, sync: 'synced' });
    expect(nativeSocialOf({ ...gate, room: false }, [], room).room).toBeNull();
    expect(nativeSocialOf({ ...gate, kid: true }, [], room).room).toBeNull();
    expect(nativeSocialOf(gate, []).room).toBeNull();
  });

  it('setSocial : le salon arrive tel quel au plugin', async () => {
    const setSocial = vi.fn(async () => {});
    const plugin = { addListener: vi.fn(async () => ({ remove: async () => {} })), open: vi.fn(async () => {}), close: vi.fn(async () => {}), setSocial };
    const e = new NativeEngine(plugin as never);
    await e.load({ url: 'http://serveur.test/v.mkv', startAt: 0, open: {} as never });
    const payload = nativeSocialOf(gate, [], nativeRoomOf(client(2, true), 2));
    e.setSocial(payload);
    expect(setSocial).toHaveBeenCalledWith(expect.objectContaining({ room: { members: 2, host: true, sync: 'catching' } }));
  });
});

describe('salon natif : réponse texte', () => {
  it('validation : texte rogné, vide refusé, coupé à la limite du chat', () => {
    expect(replyTextOf({ messageId: 'm1', text: '  ok  ' })).toEqual({ messageId: 'm1', text: 'ok' });
    expect(replyTextOf({ text: 'sans id' })).toEqual({ messageId: '', text: 'sans id' });
    expect(replyTextOf({ messageId: 'm1', text: '   ' })).toBeNull();
    expect(replyTextOf({ messageId: 'm1', text: 3 })).toBeNull();
    expect(replyTextOf(null)).toBeNull();
    expect(replyTextOf({ text: 'x'.repeat(CHAT_MAX_CHARS + 20) })!.text).toHaveLength(CHAT_MAX_CHARS);
  });

  it('en salon : part dans le chat du salon, même sans message connu', async () => {
    const chat = vi.fn(() => true);
    const send = vi.fn(async () => ({}));
    const h = { chat, react: vi.fn(), messageOf: () => undefined, send, error: vi.fn() };
    await handleNativeReplyText({ messageId: 'party-react-1', text: 'Trop bien' }, h);
    expect(chat).toHaveBeenCalledWith('Trop bien');
    expect(send).not.toHaveBeenCalled();
  });

  it('en salon : chat refusé (hors ligne), erreur affichée', async () => {
    const error = vi.fn();
    await handleNativeReplyText({ text: 'Salut' }, { chat: () => false, react: vi.fn(), messageOf: () => undefined, send: vi.fn(), error });
    expect(error).toHaveBeenCalledWith(SEND_FAILED);
  });

  it('hors salon : envoyée à l’auteur du message ; message inconnu, rien', async () => {
    const send = vi.fn(async () => ({}));
    const m = msg('m1', 'amy');
    const h = { chat: null, react: vi.fn(), messageOf: (id: string) => (id === 'm1' ? m : undefined), send, error: vi.fn() };
    await handleNativeReplyText({ messageId: 'm1', text: 'Haha' }, h);
    expect(send).toHaveBeenCalledWith('amy', 'Haha');
    expect(handleNativeReplyText({ messageId: 'm9', text: 'Haha' }, h)).toBeNull();
    expect(handleNativeReplyText({ text: 'Haha' }, h)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('hors salon : 429 affiche la limite, un autre échec le message générique', async () => {
    const error = vi.fn();
    const base = { chat: null, react: vi.fn(), messageOf: () => msg('m1', 'amy'), error };
    await handleNativeReplyText({ messageId: 'm1', text: 'a' }, { ...base, send: vi.fn(async () => { throw { status: 429 }; }) });
    expect(error).toHaveBeenLastCalledWith(SEND_LIMIT);
    await handleNativeReplyText({ messageId: 'm1', text: 'a' }, { ...base, send: vi.fn(async () => { throw new Error('réseau'); }) });
    expect(error).toHaveBeenLastCalledWith(SEND_FAILED);
  });

  it('replyText du plugin : relayé par le moteur natif', async () => {
    const handlers = new Map<string, (d: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
      open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    const e = new NativeEngine(plugin as never);
    await e.load({ url: 'http://serveur.test/v.mkv', startAt: 0, open: {} as never });
    const got: unknown[] = [];
    e.on('replyText', (d: unknown) => got.push(d));
    handlers.get('replyText')?.({ messageId: 'm1', text: 'Salut' });
    expect(got).toEqual([{ messageId: 'm1', text: 'Salut' }]);
  });
});
