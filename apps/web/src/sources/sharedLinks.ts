/* Liens débridés partagés entre les appareils d'un même compte (`/user/debrid-links` de lastAddon).
 *
 * Le serveur ne garde que des liens DÉJÀ débloqués sur l'appareil d'un utilisateur : il ne contacte jamais un débrideur.
 * Parcours côté appareil (voir `DebridManager.resolve`) : lire le lien partagé AVANT de débloquer sur l'appareil, puis publier
 * le lien obtenu APRÈS (fire-and-forget). Connecté uniquement : sans session (invité, mode local), aucun appel au serveur.
 * Un lien n'est jamais journalisé ni placé dans un message d'erreur. Les fonctions ici ne lèvent jamais. */

import { getSession, isLocalMode } from '../data/session';
import { call } from '../data/userApi';
import { normalizeHash } from './debrid/types';

/** Lecture : au-delà de ce délai, on débloque sur l'appareil (la lecture n'attend pas le serveur plus longtemps). */
const GET_TIMEOUT_MS = 3_000;
const PUT_TIMEOUT_MS = 5_000;
/** Motif accepté par le serveur pour `sourceKey`. */
const SOURCE_KEY_RE = /^[A-Za-z0-9:._-]{8,256}$/;
const HTTP_URL_RE = /^https?:\/\//i;

export interface SharedLink {
  url: string;
  expiresAt?: string;
}

/**
 * Clé de partage d'une copie torrent : `infoHash:fileIdx` (hash en minuscules). Null si le hash est invalide ou si l'index du
 * fichier est absent : sans lui, deux épisodes d'un même pack partageraient la même clé et un autre appareil recevrait le mauvais lien.
 */
export function sourceKeyFor(copy: { infoHash: string; fileIdx?: number }): string | null {
  const hash = normalizeHash(copy.infoHash);
  const idx = copy.fileIdx;
  if (hash === null || typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return null;
  const key = `${hash}:${idx}`;
  return SOURCE_KEY_RE.test(key) ? key : null;
}

/** Connecté à un compte, hors mode local (« continuer sans compte ») : seul cas où le serveur est interrogé. */
const connected = (): boolean => getSession() !== null && !isLocalMode();

/** Profil actif (en-tête X-Profile-Id, optionnel). */
const profileHeaders = (): Record<string, string> => {
  const profileId = getSession()?.profileId;
  return profileId ? { 'x-profile-id': profileId } : {};
};

/**
 * Lien partagé pour cette clé, ou null : absent, expiré, autre IP ou autre compte (404), erreur, non connecté.
 * Ne lève jamais.
 */
export async function getSharedLink(key: string): Promise<SharedLink | null> {
  if (!connected() || !SOURCE_KEY_RE.test(key)) return null;
  try {
    const r = await call<{ url?: unknown; expiresAt?: unknown }>('/debrid-links?sourceKey=' + encodeURIComponent(key), {
      headers: profileHeaders(),
      timeoutMs: GET_TIMEOUT_MS,
    });
    if (typeof r?.url !== 'string' || !HTTP_URL_RE.test(r.url)) return null;
    return { url: r.url, ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * Publie sur le serveur le lien débloqué sur cet appareil, pour les autres appareils du compte. Fire-and-forget : l'appelant
 * n'attend pas, et un échec (réseau, refus, serveur indisponible) est silencieux. Ne lève jamais.
 */
export async function publishSharedLink(key: string, url: string, expiresAt?: string): Promise<void> {
  if (!connected() || !SOURCE_KEY_RE.test(key) || !HTTP_URL_RE.test(url)) return;
  try {
    await call<unknown>('/debrid-links', {
      method: 'PUT',
      body: { sourceKey: key, url, ...(expiresAt ? { expiresAt } : {}) },
      headers: profileHeaders(),
      timeoutMs: PUT_TIMEOUT_MS,
    });
  } catch {
    // Échec silencieux : la lecture ne dépend pas du partage.
  }
}
