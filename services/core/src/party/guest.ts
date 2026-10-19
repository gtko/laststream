import { GUEST_NAME_MAX, GUEST_SESSION_MS, type Identity } from './protocol.js';
import { stripInvisible } from './text.js';

/**
 * Jeton d'invité : séance sans compte pour un salon de visionnage. Un membre connecté demande POST /party/:id/invite ; le
 * jeton lie l'invité au salon, expire après GUEST_SESSION_MS et porte un identifiant aléatoire (pas de compte, pas d'email).
 *
 * Format : `<payload base64url>.<signature base64url>` ; payload JSON = { purpose, roomId, gid, exp (ms) }. Signature =
 * HMAC-SHA256 (WebCrypto) avec une clé dérivée du secret du Worker par HKDF, `info` propre à ce jeton : aucun autre jeton
 * (ticket, élévation, jeton de flux) ne peut être rejoué comme jeton invité.
 *
 * Module portable, WebCrypto seulement (ni `node:*` ni Buffer), comme range-token.ts : il tourne à l'identique sous Node
 * et sous Cloudflare Workers.
 */

const PURPOSE = 'lastaddon-party-guest-v1';
/** Jeton de lien d'invitation du salon (multi-usage, non lié à un pseudo) : clé HKDF distincte de celle du jeton d'invité. */
const LINK_PURPOSE = 'lastaddon-party-room-invite-v1';
const GUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TOKEN_CHARS = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Préfixe de la clé interne d'un invité (`accountId` des membres) : jamais un identifiant de compte. */
export const GUEST_KEY_PREFIX = 'guest:';
/** Couleur d'avatar fixe des invités (pas de profil). */
export const GUEST_COLOR = '#64748b';

interface GuestPayload {
  purpose: typeof PURPOSE;
  roomId: string;
  gid: string;
  exp: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Clé HMAC dérivée du secret (HKDF, `info` = PURPOSE). */
async function macKey(secret: string, usage: 'sign' | 'verify', purpose: string = PURPOSE) {
  if (secret.length === 0) throw new RangeError('secret vide');
  const master = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(purpose) }, master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [usage]);
}

export interface GuestToken {
  token: string;
  /** Expiration, ISO 8601. */
  expiresAt: string;
}

/** Identifiant d'invité aléatoire (128 bits). */
export function newGuestId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Émet un jeton d'invité pour ce salon, valable GUEST_SESSION_MS à partir de `now` (ms). `options` fixe l'identifiant
 * (jeton de séance délivré à l'entrée par le lien partagé) et/ou l'échéance (au plus la fin du salon).
 */
export async function signGuestToken(roomId: string, now: number, secret: string, options: { gid?: string; exp?: number } = {}): Promise<GuestToken> {
  const exp = options.exp ?? now + GUEST_SESSION_MS;
  const payload: GuestPayload = { purpose: PURPOSE, roomId, gid: options.gid ?? newGuestId(), exp };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(secret, 'sign'), encoder.encode(body)));
  return { token: `${body}.${base64url(signature)}`, expiresAt: new Date(exp).toISOString() };
}

/**
 * Identifiant d'invité porté par un jeton authentique, non expiré et émis pour ce salon ; sinon `undefined` (aucune
 * exception). La signature est vérifiée en temps constant par WebCrypto.
 */
export async function verifyGuestToken(token: string, roomId: string, now: number, secret: string): Promise<{ guestId: string } | undefined> {
  if (token.length > MAX_TOKEN_CHARS) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
  const body = token.slice(0, dot);
  const signature = fromBase64url(token.slice(dot + 1));
  if (signature === undefined) return undefined;
  const valid = await crypto.subtle.verify('HMAC', await macKey(secret, 'verify'), signature, encoder.encode(body));
  if (!valid) return undefined;
  const bytes = fromBase64url(body);
  if (bytes === undefined) return undefined;
  let payload: Partial<GuestPayload>;
  try {
    payload = JSON.parse(decoder.decode(bytes)) as Partial<GuestPayload>;
  } catch {
    return undefined;
  }
  if (
    payload.purpose !== PURPOSE ||
    payload.roomId !== roomId ||
    typeof payload.gid !== 'string' ||
    !GUEST_ID.test(payload.gid) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now
  ) {
    return undefined;
  }
  return { guestId: payload.gid };
}

/**
 * Pseudo d'invité nettoyé : caractères invisibles retirés, espaces réduits, 24 caractères au plus (sans couper un
 * caractère composé). `undefined` si rien ne reste.
 */
export function cleanGuestName(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const name = stripInvisible(raw.slice(0, 200)).replace(/\s+/g, ' ').trim();
  const clipped = Array.from(name).slice(0, GUEST_NAME_MAX).join('').trim();
  return clipped === '' ? undefined : clipped;
}

/** Identité d'un invité dans le salon : clé `guest:<id>`, pseudo nettoyé, drapeau `guest`. */
export function guestIdentity(guestId: string, username: string): Identity {
  return { accountId: `${GUEST_KEY_PREFIX}${guestId}`, username, avatarColor: GUEST_COLOR, guest: true };
}

interface LinkPayload {
  purpose: typeof LINK_PURPOSE;
  roomId: string;
  epoch: number;
  exp: number;
}

/**
 * Jeton du lien d'invitation partageable d'un salon : multi-usage, non lié à un pseudo ni à un invité. Il porte le salon,
 * la génération (`epoch`, stockée dans le salon : l'hôte l'incrémente pour révoquer l'ancien lien) et l'échéance (fin du
 * salon). Déterministe pour (salon, génération, échéance) : redemander le lien rend le même lien. Il ne suffit pas à
 * ouvrir une WebSocket : l'entrée passe par POST /party/:id/guest, qui rend le jeton de séance individuel.
 */
export async function signRoomInviteToken(roomId: string, epoch: number, exp: number, secret: string): Promise<string> {
  const payload: LinkPayload = { purpose: LINK_PURPOSE, roomId, epoch, exp };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(secret, 'sign', LINK_PURPOSE), encoder.encode(body)));
  return `${body}.${base64url(signature)}`;
}

/** Génération et échéance d'un jeton de lien authentique, non expiré et émis pour ce salon ; sinon `undefined`. */
export async function verifyRoomInviteToken(token: string, roomId: string, now: number, secret: string): Promise<{ epoch: number; exp: number } | undefined> {
  if (token.length > MAX_TOKEN_CHARS) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
  const body = token.slice(0, dot);
  const signature = fromBase64url(token.slice(dot + 1));
  if (signature === undefined) return undefined;
  // Vérification en temps constant par WebCrypto.
  if (!(await crypto.subtle.verify('HMAC', await macKey(secret, 'verify', LINK_PURPOSE), signature, encoder.encode(body)))) return undefined;
  const bytes = fromBase64url(body);
  if (bytes === undefined) return undefined;
  let payload: Partial<LinkPayload>;
  try {
    payload = JSON.parse(decoder.decode(bytes)) as Partial<LinkPayload>;
  } catch {
    return undefined;
  }
  if (
    payload.purpose !== LINK_PURPOSE ||
    payload.roomId !== roomId ||
    typeof payload.epoch !== 'number' ||
    !Number.isInteger(payload.epoch) ||
    payload.epoch < 0 ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now
  ) {
    return undefined;
  }
  return { epoch: payload.epoch, exp: payload.exp };
}
