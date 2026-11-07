/**
 * Mémoire des bandes-annonces YouTube en échec sur cet appareil (vidéo bloquée dans le pays, intégration interdite,
 * supprimée…) : elles sont écartées pendant 7 jours au profit de la candidate suivante.
 */

/** Clé de stockage : objet { cléYouTube: horodatage ms de l'échec }. */
export const FAIL_STORAGE_KEY = 'ls.trailerFail';
/** Durée de la mémoire d'un échec. */
export const FAIL_TTL_MS = 7 * 24 * 3600 * 1000;
/** Nombre maximal d'échecs conservés (les plus anciens sont oubliés). */
export const FAIL_MAX = 200;

type FailMap = Record<string, number>;

// Dernier texte lu et son analyse : trailerFields interroge la mémoire pour chaque candidate, inutile de relire le JSON.
let lastRaw: string | null = null;
let lastParsed: unknown = null;

/** Échecs encore valides ; les expirés sont ignorés. Stockage absent, illisible ou corrompu : aucun échec. */
function read(now: number): FailMap {
  const out: FailMap = {};
  try {
    const raw = globalThis.localStorage?.getItem(FAIL_STORAGE_KEY) ?? null;
    if (raw !== lastRaw) {
      lastParsed = raw ? JSON.parse(raw) : null;
      lastRaw = raw;
    }
    const parsed = lastParsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, t] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof t === 'number' && Number.isFinite(t) && now - t < FAIL_TTL_MS) out[k] = t;
      }
    }
  } catch {
    lastRaw = null;
    lastParsed = null; /* stockage illisible : mémoire vide */
  }
  return out;
}

/** Enregistre la vidéo comme en échec (purge les expirés, plafonne à FAIL_MAX). */
export function markTrailerFailed(key: string, now: number = Date.now()): void {
  if (!key) return;
  const map = read(now);
  map[key] = now;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, FAIL_MAX);
  try { globalThis.localStorage?.setItem(FAIL_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* quota : tant pis */ }
}

/** Vrai si la vidéo a échoué il y a moins de 7 jours sur cet appareil. */
export function isTrailerFailed(key: string, now: number = Date.now()): boolean {
  return !!key && key in read(now);
}

/**
 * Code d'erreur d'un message de l'API IFrame de YouTube (`e.data`, chaîne JSON ou objet) : nombre si `event` vaut
 * `onError`, sinon null.
 */
export function parseYoutubeError(data: unknown): number | null {
  let d: unknown = data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== 'object') return null;
  const m = d as { event?: unknown; info?: unknown };
  return m.event === 'onError' && typeof m.info === 'number' ? m.info : null;
}

/** Codes connus : 2 (paramètre), 5 (HTML5), 100 (introuvable), 101 et 150 (intégration interdite). Tout code d'erreur bascule. */
export function isUnplayableError(code: number | null): boolean {
  return typeof code === 'number' && Number.isFinite(code);
}
