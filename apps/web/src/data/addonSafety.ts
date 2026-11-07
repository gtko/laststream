/* Addons amont : diagnostic « torrents seulement ». L'addon répond à un flux de test ; s'il ne renvoie que des infoHash
 * (torrents bruts, inutilisables sans débrideur), aucune source n'est lisible. Fonctions pures, sans réseau, plus
 * l'horodatage du dernier diagnostic (stockage local). L'adresse de l'addon n'est pas écrite en clair (empreinte). */

/** `readable` : au moins un flux donne un lien lisible ; `torrents` : que des infoHash ; `unknown` : rien de lisible. */
export type Verdict = 'readable' | 'torrents' | 'unknown';

/** Dernier diagnostic d'un addon : quand il a été fait et ce qu'il a donné. */
export interface CheckRecord {
  at: number;
  verdict: Verdict;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'laststream.srcCheck.';
const VERDICTS: string[] = ['readable', 'torrents', 'unknown'];

/** Diagnostics de cette page, pour ne pas refaire le test si le stockage local est indisponible. */
const memory = new Map<string, CheckRecord>();

/** Lien lisible : une adresse http(s) non vide (une adresse relative se résout sur l'origine de l'addon). */
function isReadableUrl(raw: string, addonOrigin: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const { protocol } = new URL(trimmed, addonOrigin);
    return protocol === 'http:' || protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/** Classe la réponse de l'addon à un flux de test : un lien lisible l'emporte ; sinon un infoHash = torrents bruts. */
export function classifyStreams(streams: unknown, addonOrigin: string): Verdict {
  if (!Array.isArray(streams) || !streams.length) return 'unknown';
  let torrents = false;
  for (const item of streams) {
    if (!item || typeof item !== 'object') continue;
    const st = item as Record<string, unknown>;
    if (typeof st.url === 'string' && isReadableUrl(st.url, addonOrigin)) return 'readable';
    if (typeof st.infoHash === 'string' && st.infoHash.trim() !== '') torrents = true;
  }
  return torrents ? 'torrents' : 'unknown';
}

/** Clé de stockage d'un addon : empreinte 32 bits (FNV-1a) de son adresse, qui peut contenir une clé. */
export function checkKey(manifestUrl: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < manifestUrl.length; i += 1) {
    h ^= manifestUrl.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Dernier diagnostic : mémoire de la page d'abord, puis stockage local. Absent ou illisible : null. */
export function readCheck(key: string): CheckRecord | null {
  const known = memory.get(key);
  if (known) return known;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<CheckRecord>;
    if (typeof rec.at === 'number' && typeof rec.verdict === 'string' && VERDICTS.includes(rec.verdict)) {
      return { at: rec.at, verdict: rec.verdict as Verdict };
    }
  } catch (_) { /* stockage indisponible ou valeur corrompue */ }
  return null;
}

/** Enregistre un diagnostic (mémoire de la page et stockage local). */
export function writeCheck(key: string, rec: CheckRecord): void {
  memory.set(key, rec);
  try { globalThis.localStorage?.setItem(STORAGE_PREFIX + key, JSON.stringify(rec)); } catch (_) { /* quota : la mémoire suffit */ }
}

/** Vrai si le diagnostic doit être refait : jamais fait, plus de 24 h, ou horloge revenue en arrière. */
export function isDue(rec: CheckRecord | null, now: number): boolean {
  return !rec || now - rec.at >= DAY_MS || now < rec.at;
}
