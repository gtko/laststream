// Invitation d'un salon : lien `#/party/join/<id>?t=<jeton>`, pseudo, chemin WebSocket invité, messages, et signalisation
// `rtc` du client de salon (envoi et réception).
import { describe, expect, it } from 'vitest';
import { PartyClient, type SocketLike } from '../src/party/client';
import {
  cleanPseudo, clearGuestSession, endText, entryErrorText, guestWsPath, joinLinkOf, loadGuestSession, parseJoinHash, refusedText, relayErrorText, saveGuestSession,
} from '../src/party/join';
import { parseRtcFrame } from '../src/party/protocol';

class FakeSocket implements SocketLike {
  sent: any[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { /* sans effet */ }
  open() { this.onopen?.(); }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('lien d’invitation', () => {
  it('lit l’identifiant du salon et le jeton de la route', () => {
    expect(parseJoinHash('#/party/join/ROOM_1-x?t=abcdefgh12')).toEqual({ roomId: 'ROOM_1-x', token: 'abcdefgh12' });
  });

  it('décode les caractères réservés du jeton', () => {
    expect(parseJoinHash('#/party/join/R1?t=ab%2Bcd%2Fef')).toEqual({ roomId: 'R1', token: 'ab+cd/ef' });
  });

  it('refuse les routes voisines, les jetons trop courts et les paramètres en trop', () => {
    expect(parseJoinHash('#/party/R1')).toBeNull();
    expect(parseJoinHash('#/party/join/R1')).toBeNull();
    expect(parseJoinHash('#/party/join/R1?t=court')).toBeNull();
    expect(parseJoinHash('#/party/join/R1?t=abcdefgh&x=1')).toBeNull();
    expect(parseJoinHash('#/party/join/R1?t=abc%E0%A4%A')).toBeNull();
    expect(parseJoinHash('#/party/join/R 1?t=abcdefgh12')).toBeNull();
    expect(parseJoinHash('#/party/join/R1?t=abc def ghi')).toBeNull();
  });

  it('construit le lien à partir de l’origine, et la route le relit à l’identique', () => {
    const link = joinLinkOf('https://laststream.example.invalid/', 'R1', 'ab+cd/ef');
    expect(link).toBe('https://laststream.example.invalid/#/party/join/R1?t=ab%2Bcd%2Fef');
    expect(parseJoinHash(link.slice(link.indexOf('#')))).toEqual({ roomId: 'R1', token: 'ab+cd/ef' });
  });
});

describe('pseudo et chemin WebSocket invité', () => {
  it('nettoie le pseudo et refuse le vide, le trop long et les caractères de contrôle', () => {
    expect(cleanPseudo('  Léa  ')).toBe('Léa');
    expect(cleanPseudo('   ')).toBeNull();
    expect(cleanPseudo('x'.repeat(33))).toBeNull();
    expect(cleanPseudo('a\nb')).toBeNull();
    expect(cleanPseudo('x'.repeat(32))).toHaveLength(32);
  });

  it('encode le salon, le jeton et le pseudo dans le chemin du WebSocket', () => {
    expect(guestWsPath('R 1', 'tok/en+1', 'Léa')).toBe('/party/R%201/ws?t=tok%2Fen%2B1&name=L%C3%A9a');
  });
});

describe('messages', () => {
  it('ne contiennent jamais d’adresse ni de contenu de la source', () => {
    const all = [refusedText(), endText('kicked'), endText('ended'), endText('full'), endText('replaced'), endText('x'),
      relayErrorText('timeout'), relayErrorText('source'), relayErrorText('busy'), relayErrorText('unknown')];
    for (const m of all) expect(m).not.toMatch(/https?:|\/\//);
    expect(refusedText()).toContain('lien expiré');
    expect(endText('full')).toBe('Le salon est complet.');
  });
});

describe('signalisation rtc du salon', () => {
  it('reconnaît les trames rtc relayées, et rien d’autre', () => {
    expect(parseRtcFrame(JSON.stringify({ type: 'rtc', from: 'p1', data: { t: 'hello' } }))).toEqual({ from: 'p1', data: { t: 'hello' } });
    expect(parseRtcFrame(JSON.stringify({ t: 'pong', c: 1, s: 2 }))).toBeNull();
    expect(parseRtcFrame(JSON.stringify({ type: 'rtc', from: 'p1' }))).toBeNull();
    expect(parseRtcFrame('pas du json')).toBeNull();
    expect(parseRtcFrame({ type: 'rtc', from: 'p1', data: {} })).toBeNull();
  });

  it('envoie {type:"rtc",to,data} seulement en ligne, et refuse une trame de plus de 4 Ko', async () => {
    const s = new FakeSocket();
    const client = new PartyClient({ connect: async () => s, setTimer: () => 0, clearTimer: () => undefined });
    client.start();
    await flush();
    expect(client.sendRtc('p1', { t: 'hello' })).toBe(false);
    s.open();
    expect(client.sendRtc('p1', { t: 'hello' })).toBe(true);
    expect(s.sent.at(-1)).toEqual({ type: 'rtc', to: 'p1', data: { t: 'hello' } });
    expect(client.sendRtc('p1', { t: 'offer', sdp: 'x'.repeat(5000) })).toBe(false);
    client.close();
  });

  it('émet un événement rtc pour chaque trame relayée, sans toucher aux messages du salon', async () => {
    const s = new FakeSocket();
    const client = new PartyClient({ connect: async () => s, setTimer: () => 0, clearTimer: () => undefined });
    const got: Array<{ from: string; data: unknown }> = [];
    client.on('rtc', (m) => got.push(m));
    client.start();
    await flush();
    s.open();
    s.recv({ type: 'rtc', from: 'h1', data: { t: 'offer', sdp: 'v=0' } });
    s.recv({ t: 'error', code: 'rate_limited' });
    expect(got).toEqual([{ from: 'h1', data: { t: 'offer', sdp: 'v=0' } }]);
    client.close();
  });
});

/** Stockage d'onglet simulé. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe('séance d’invité du lien partagé (sessionStorage)', () => {
  const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
  const session = { sessionToken: 'abcdefgh.ijklmnop-1234', name: 'Léa 2', expiresAt: new Date(NOW + 3600_000).toISOString() };

  it('mémorise puis relit la séance d’un salon, sans toucher aux autres salons', () => {
    const store = memoryStorage();
    saveGuestSession('R1', session, store);
    expect(loadGuestSession('R1', NOW, store)).toEqual(session);
    expect(loadGuestSession('R2', NOW, store)).toBeNull();
    clearGuestSession('R1', store);
    expect(loadGuestSession('R1', NOW, store)).toBeNull();
  });

  it('oublie une séance expirée ou mal formée', () => {
    const store = memoryStorage();
    saveGuestSession('R1', session, store);
    expect(loadGuestSession('R1', NOW + 3600_000, store)).toBeNull();
    expect(store.data.size).toBe(0);
    store.setItem('ls.party.guest.R1', '{pas du json');
    expect(loadGuestSession('R1', NOW, store)).toBeNull();
    store.setItem('ls.party.guest.R1', JSON.stringify({ ...session, sessionToken: 'court' }));
    expect(loadGuestSession('R1', NOW, store)).toBeNull();
    store.setItem('ls.party.guest.R1', JSON.stringify({ ...session, name: '   ' }));
    expect(loadGuestSession('R1', NOW, store)).toBeNull();
  });

  it('stockage absent ou qui lève : aucune exception, la page fonctionne sans', () => {
    const broken = {
      getItem: () => { throw new Error('bloqué'); },
      setItem: () => { throw new Error('bloqué'); },
      removeItem: () => { throw new Error('bloqué'); },
    };
    expect(() => saveGuestSession('R1', session, broken)).not.toThrow();
    expect(loadGuestSession('R1', NOW, broken)).toBeNull();
    expect(() => clearGuestSession('R1', broken)).not.toThrow();
    expect(() => saveGuestSession('R1', session, null)).not.toThrow();
    expect(loadGuestSession('R1', NOW, null)).toBeNull();
  });

  it('messages d’entrée : codes connus, jamais d’adresse', () => {
    expect(entryErrorText('invite_revoked')).toContain('nouveau lien');
    expect(entryErrorText('invite_invalid')).toContain('expiré');
    expect(entryErrorText('room_full')).toBe('Le salon est complet.');
    expect(entryErrorText('guest_limit')).toBe('Le salon est complet.');
    for (const code of ['invite_revoked', 'invite_invalid', 'room_not_found', 'too_many_entries', 'invalid_name', 'network', 'autre']) {
      expect(entryErrorText(code)).not.toMatch(/https?:|\/\//);
    }
  });
});
