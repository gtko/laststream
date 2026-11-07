// Relais de salon factice pour le test e2e à deux pages (scripts/relay-e2e/two-pages.mjs).
//
// Imite le WebSocket d'un salon tel que le client (src/party/client.ts) le parle : welcome avec participants et peerId,
// join/leave, pong, commandes ctl play/pause/seek diffusées en `state`, et signalisation `rtc` relayée au seul pair visé
// (`{type:'rtc',to,data}` reçu, `{type:'rtc',from,data}` envoyé). Il applique les limites du serveur lastaddon
// (src/party/protocol.ts) : données rtc ≤ 16 Kio, trame rtc ≤ 64 Kio, autres trames ≤ 4096 caractères.
//
// C'EST UN FAUX SALON : aucune persistance, aucune authentification (le rôle vient de la requête), pas de Cloudflare.
// Le WebSocket est écrit à la main (node:http + cadrage RFC 6455) : aucune dépendance ajoutée.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Limites du serveur lastaddon (src/party/protocol.ts : MAX_FRAME_BYTES, RTC_MAX_DATA_BYTES, RTC_MAX_FRAME_CHARS). */
export const SERVER_LIMITS = Object.freeze({ frameChars: 4096, rtcDataBytes: 16 * 1024, rtcFrameChars: 64 * 1024 });
const MAX_PAYLOAD = 256 * 1024;
const PEER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RTC_KINDS = ['hello', 'offer', 'answer', 'ice'];

/** Trame serveur non masquée : op 1 texte, 2 binaire, 8 fermeture, 10 pong. */
function frame(op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.from([0x80 | op, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Lecteur de trames client (toujours masquées, RFC 6455). `onFrame(op, payload)` par message complet ; `onError(code)` si invalide. */
function frameReader(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let parts = null;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return onError(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return onError(1009);
      if (!masked) return onError(1002);
      if (buf.length < off + 4 + len) return;
      const key = buf.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ key[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op >= 8) {
        onFrame(op, payload);
        continue;
      }
      if (op !== 0) {
        if (fin) onFrame(op, payload);
        else {
          fragOp = op;
          parts = [payload];
        }
        continue;
      }
      if (!parts) return onError(1002);
      parts.push(payload);
      if (fin) {
        const full = Buffer.concat(parts);
        parts = null;
        onFrame(fragOp, full);
      }
    }
  };
}

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const cleanName = (raw) => (raw ?? '').slice(0, 24) || 'invite';

/**
 * Démarre le faux salon sur 127.0.0.1. Chaque salon (`/party/<id>/ws`) garde un état de lecture (`state`) et ses membres.
 * Rend `{ url, stats(), close() }` ; `stats().rtc` mesure la signalisation (tailles, rejets, pairs absents).
 */
export async function startFakePartyRelay({ port = 0 } = {}) {
  const rooms = new Map();
  const sockets = new Set();
  const counters = {
    connections: 0,
    textFrames: 0,
    binaryFrames: 0,
    invalid: 0,
    rtc: { count: 0, rejected: 0, undelivered: 0, maxFrameBytes: 0, maxDataBytes: 0, maxByKind: {} },
  };

  const room = (id) => {
    let r = rooms.get(id);
    if (!r) {
      r = { id, state: { playing: false, pos: 0, at: Date.now(), rev: 0 }, members: new Map() };
      rooms.set(id, r);
    }
    return r;
  };

  const send = (member, msg) => {
    if (!member.socket.destroyed) member.socket.write(frame(1, Buffer.from(JSON.stringify(msg))));
  };
  const broadcast = (r, msg) => {
    for (const m of r.members.values()) send(m, msg);
  };
  const participantView = (m) => ({
    username: m.username,
    avatarColor: '#667788',
    host: m.host,
    muted: m.muted,
    joinedAt: m.joinedAt,
    peerId: m.connId,
    ...(m.guest ? { guest: true } : {}),
  });

  function handleText(r, member, text) {
    const invalid = () => {
      counters.invalid += 1;
    };
    if (text.length > SERVER_LIMITS.rtcFrameChars) return invalid();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return invalid();
    }
    if (!isRecord(msg)) return invalid();

    if (msg.type === 'rtc') {
      if (typeof msg.to !== 'string' || !PEER_ID.test(msg.to) || !isRecord(msg.data)) return invalid();
      const rtc = counters.rtc;
      const frameBytes = Buffer.byteLength(text);
      const dataBytes = Buffer.byteLength(JSON.stringify(msg.data));
      rtc.count += 1;
      rtc.maxFrameBytes = Math.max(rtc.maxFrameBytes, frameBytes);
      rtc.maxDataBytes = Math.max(rtc.maxDataBytes, dataBytes);
      const kind = RTC_KINDS.includes(msg.data.t) ? msg.data.t : 'autre';
      rtc.maxByKind[kind] = Math.max(rtc.maxByKind[kind] ?? 0, frameBytes);
      if (dataBytes > SERVER_LIMITS.rtcDataBytes) {
        rtc.rejected += 1;
        return send(member, { t: 'error', code: 'rtc_too_large' });
      }
      const target = r.members.get(msg.to);
      if (!target) {
        rtc.undelivered += 1;
        return;
      }
      // Relayé au seul pair visé, sous la forme {type:'rtc',from,data} (sans enveloppe `t`).
      if (!target.socket.destroyed) target.socket.write(frame(1, Buffer.from(JSON.stringify({ type: 'rtc', from: member.connId, data: msg.data }))));
      return;
    }

    if (text.length > SERVER_LIMITS.frameChars || typeof msg.t !== 'string') return invalid();
    switch (msg.t) {
      case 'ping':
        if (typeof msg.c !== 'number' || !Number.isFinite(msg.c)) return invalid();
        return send(member, { t: 'pong', c: msg.c, s: Date.now() });
      case 'sync':
        return send(member, { t: 'state', state: r.state, serverTime: Date.now(), by: member.username });
      case 'ctl': {
        const pos = msg.pos;
        if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0 || pos > 1_000_000) return invalid();
        const cur = r.state;
        let playing;
        if (msg.action === 'play') playing = true;
        else if (msg.action === 'pause') playing = false;
        else if (msg.action === 'seek') playing = cur.playing;
        else if (msg.action === 'sync') {
          if (!member.host) return send(member, { t: 'error', code: 'not_host' });
          playing = cur.playing;
        } else return invalid();
        r.state = { playing, pos, at: Date.now(), rev: cur.rev + 1 };
        return broadcast(r, { t: 'state', state: r.state, serverTime: Date.now(), by: member.username });
      }
      default:
        // Chat, réactions, modération, épisodes : hors périmètre du test, ignorés.
        return;
    }
  }

  function attach(socket, r, params) {
    const role = params.get('role') === 'host' ? 'host' : 'guest';
    const member = {
      connId: randomBytes(12).toString('base64url'),
      username: cleanName(params.get('name')),
      host: role === 'host',
      guest: role === 'guest' ? true : undefined,
      muted: false,
      joinedAt: Date.now(),
      socket,
    };
    counters.connections += 1;
    sockets.add(socket);
    r.members.set(member.connId, member);
    const hostMember = [...r.members.values()].find((m) => m.host);
    send(member, {
      t: 'welcome',
      you: { username: member.username, host: member.host, muted: false, peerId: member.connId },
      room: {
        id: r.id,
        visibility: 'private',
        title: 'Salon de test',
        poster: null,
        language: null,
        media: { type: 'movie', tmdbId: null, imdbId: null },
        fingerprint: null,
        host: hostMember?.username ?? member.username,
        maxParticipants: 20,
        createdAt: Date.now(),
      },
      state: r.state,
      serverTime: Date.now(),
      participants: [...r.members.values()].map(participantView),
      chat: [],
    });
    for (const other of r.members.values()) {
      if (other !== member) send(other, { t: 'join', participant: participantView(member) });
    }

    const onFrame = (op, payload) => {
      if (op === 8) return socket.end(frame(8, Buffer.alloc(0)));
      if (op === 9) return socket.write(frame(10, payload));
      if (op === 2) {
        counters.binaryFrames += 1;
        return;
      }
      if (op !== 1) return;
      counters.textFrames += 1;
      handleText(r, member, payload.toString('utf8'));
    };
    const onError = (code) => {
      counters.invalid += 1;
      socket.end(frame(8, Buffer.from([code >> 8, code & 0xff])));
    };
    socket.on('data', frameReader(onFrame, onError));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      if (r.members.get(member.connId) !== member) return;
      r.members.delete(member.connId);
      broadcast(r, { t: 'leave', user: member.username });
    });
  }

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/party\/([A-Za-z0-9_-]{1,64})\/ws$/.exec(url.pathname);
    const key = req.headers['sec-websocket-key'];
    if (!m || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    attach(socket, room(m[1]), url.searchParams);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: actual } = server.address();

  return {
    url: `ws://127.0.0.1:${actual}`,
    stats: () => structuredClone(counters),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
