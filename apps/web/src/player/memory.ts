/* Choix de pistes mémorisés par titre (série entière ou film) : langue audio, sous-titres. */

export interface TitleMemory {
  /** Code de langue audio (fr, en…). */
  audio?: string;
  /** `off` ou code de langue des sous-titres. */
  sub?: string;
}

const MEMORY_KEY = 'laststream.player.memory';
const MAX_ENTRIES = 300;

function readAll(): Record<string, TitleMemory> {
  try {
    const raw = globalThis.localStorage?.getItem(MEMORY_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, TitleMemory>) : {};
  } catch {
    return {};
  }
}

export function getMemory(titleKey: string): TitleMemory {
  const m = readAll()[titleKey];
  return m && typeof m === 'object' ? m : {};
}

export function remember(titleKey: string, patch: TitleMemory): void {
  const all = readAll();
  // Le plus récent en dernier ; on garde les 300 derniers titres.
  const merged = { ...(all[titleKey] ?? {}), ...patch };
  delete all[titleKey];
  all[titleKey] = merged;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
  try { globalThis.localStorage?.setItem(MEMORY_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

// ---------- Calage des sous-titres, par fichier et par piste ----------

export interface SubSync {
  /** Décalage en secondes (positif : sous-titres plus tard). */
  offset: number;
  /** Rapport de vitesse (1 : aucun). */
  rate: number;
}

const SYNC_KEY = 'laststream.player.subsync';

/** Clé d'un fichier : nom + taille (deux releases différentes ne partagent pas leur calage). */
export function fileKey(filename: string, size: number): string {
  return (filename || 'inconnu').toLowerCase() + '|' + (size > 0 ? Math.round(size) : 0);
}

function readSync(): Record<string, SubSync> {
  try {
    const raw = globalThis.localStorage?.getItem(SYNC_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SubSync>) : {};
  } catch {
    return {};
  }
}

export function getSubSync(file: string, subKey: string): SubSync | null {
  const v = readSync()[file + '#' + subKey];
  return v && Number.isFinite(v.offset) && Number.isFinite(v.rate) ? v : null;
}

export function setSubSync(file: string, subKey: string, sync: SubSync): void {
  const all = readSync();
  const k = file + '#' + subKey;
  delete all[k];
  if (sync.offset !== 0 || sync.rate !== 1) all[k] = sync;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[old];
  try { globalThis.localStorage?.setItem(SYNC_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

// ---------- Sources lentes ou en échec, par titre (24 h) ----------

const BAD_KEY = 'laststream.player.badsources';
export const BAD_TTL_MS = 24 * 60 * 60 * 1000;

interface BadEntry { reason: string; at: number }

function readBad(): Record<string, Record<string, BadEntry>> {
  try {
    const raw = globalThis.localStorage?.getItem(BAD_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Record<string, BadEntry>>) : {};
  } catch {
    return {};
  }
}

/** Identité d'une source : torrent (infoHash) ou lien sans paramètres (les jetons changent d'une fois à l'autre). */
export function sourceKey(v: { stream: { url?: unknown; infoHash?: unknown } }): string {
  const s = v.stream;
  if (typeof s.infoHash === 'string' && s.infoHash) return 'h:' + s.infoHash.toLowerCase();
  if (typeof s.url === 'string') {
    try { const u = new URL(s.url); return 'u:' + u.origin + u.pathname; } catch { return 'u:' + s.url; }
  }
  return 'x:?';
}

export function markBad(title: string, source: string, reason: string, now = Date.now()): void {
  const all = readBad();
  const t = { ...(all[title] ?? {}) };
  t[source] = { reason, at: now };
  all[title] = t;
  // On ne garde que les 100 derniers titres.
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
  try { globalThis.localStorage?.setItem(BAD_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

/** Sources à éviter pour ce titre (moins de 24 h) : clé → raison. */
export function badSources(title: string, now = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  const t = readBad()[title] ?? {};
  for (const [k, e] of Object.entries(t)) if (e && now - e.at < BAD_TTL_MS) out.set(k, e.reason);
  return out;
}
