/* Liens débridés partagés entre les appareils d'un même compte (`/user/debrid-links` de lastAddon).
 *
 * Le serveur ne garde que des liens DÉJÀ débloqués sur l'appareil d'un utilisateur : il ne contacte jamais un débrideur.
 * Parcours côté appareil (voir `DebridManager.resolve`) : lire le lien partagé AVANT de débloquer sur l'appareil, puis publier
 * le lien obtenu APRÈS (fire-and-forget). Connecté uniquement : sans session (invité, mode local), aucun appel au serveur.
 * Un lien n'est jamais journalisé ni placé dans un message d'erreur. Les fonctions ici ne lèvent jamais. */

import { getSession } from '../data/session';
import { call } from '../data/userApi';
import { normalizeHash } from './debrid/types';

/** Lecture : au-delà de ce délai, on débloque sur l'appareil (la lecture n'attend pas le serveur plus longtemps). */
const GET_TIMEOUT_MS = 3_000;
const PUT_TIMEOUT_MS = 5_000;
const DELETE_TIMEOUT_MS = 5_000;
/** Motif accepté par le serveur pour `sourceKey`. */
const SOURCE_KEY_RE = /^[A-Za-z0-9:._-]{8,256}$/;
const HTTP_URL_RE = /^https?:\/\//i;

export interface SharedLink {
  url: string;
  expiresAt?: string;
}

const isIndex = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Clé de partage d'une copie torrent : `infoHash:fileIdx` (hash en minuscules), suivie de `:s<saison>e<épisode>` pour un
 * épisode. Null si le hash est invalide ou si l'index du fichier est absent : sans lui, deux épisodes d'un même pack
 * partageraient la même clé. L'épisode fait partie de la clé parce que le `fileIdx` vient de l'addon et peut être faux
 * (ou identique pour tout un pack) : l'appareil choisit le fichier par son nom, et un lien d'un épisode ne doit jamais
 * être servi pour un autre.
 */
export function sourceKeyFor(copy: { infoHash: string; fileIdx?: number }, episode: { season?: number; episode?: number } = {}): string | null {
  const hash = normalizeHash(copy.infoHash);
  const idx = copy.fileIdx;
  if (hash === null || !isIndex(idx)) return null;
  const ep = isIndex(episode.season) && isIndex(episode.episode) ? `:s${episode.season}e${episode.episode}` : '';
  const key = `${hash}:${idx}${ep}`;
  return SOURCE_KEY_RE.test(key) ? key : null;
}

/** Connecté à un compte : seul cas où le serveur est interrogé. */
const connected = (): boolean => getSession() !== null;

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
 * Invalide sur le serveur le lien partagé de cette source, pour ce compte : à appeler quand il a échoué à la lecture, avant de
 * débloquer et republier sur l'appareil. Un échec est silencieux (le lien périmé ne sert plus qu'à ce compte). Ne lève jamais.
 */
export async function forgetSharedLink(key: string): Promise<void> {
  if (!connected() || !SOURCE_KEY_RE.test(key)) return;
  try {
    await call<unknown>('/debrid-links/' + encodeURIComponent(key), {
      method: 'DELETE',
      headers: profileHeaders(),
      timeoutMs: DELETE_TIMEOUT_MS,
    });
  } catch {
    // Échec silencieux : la republication après déblocage local remplace de toute façon le lien.
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
