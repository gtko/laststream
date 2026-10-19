import { auth, isServerMode } from './auth';
import { getSettings, putSettings } from './userApi';
import { userStore } from './userStore';

/*
 * Recommandations IA : une seule liste par jour et par profil (au moins 50 titres).
 * Stockage : réglages du profil sur lastAddon (clés aiRecs, aiRecs0…) pour que tous les appareils voient la même liste ;
 * repli localStorage hors compte. Les réglages sont limités à 4 Ko par valeur : la liste est découpée en morceaux.
 */

export const RECS_COUNT = 50;
export const HOME_ROW_COUNT = 20;
const CHUNK_BYTES = 3300;
const MAX_CHUNKS = 12;

/** Titre recommandé, sous forme compacte (id TMDB, type, titre, affiche, année, raison). */
export interface RecItem {
  i: number;
  t: 'm' | 't';
  n: string;
  p: string;
  y: string;
  r: string;
  /** Genres TMDB (absent sur les listes enregistrées avant cette version). */
  g?: number[];
}

export interface DailyRecs {
  /** Jour local au format AAAA-MM-JJ. */
  date: string;
  items: RecItem[];
}

export function todayLocal(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Réponse de /lt/recommend → liste compacte (sans doublon, avec affiche). */
export function compactItems(items: unknown[]): RecItem[] {
  const seen = new Set<string>();
  const out: RecItem[] = [];
  for (const raw of items as Array<Record<string, any>>) {
    if (!raw || typeof raw.id !== 'number' || !raw.poster_path) continue;
    const tv = raw.media_type === 'tv';
    const k = (tv ? 't' : 'm') + raw.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      i: raw.id,
      t: tv ? 't' : 'm',
      n: String(raw.title || raw.name || raw.original_title || raw.original_name || '').slice(0, 120),
      p: String(raw.poster_path),
      y: String(raw.release_date || raw.first_air_date || '').slice(0, 4),
      r: String(raw.reason_fr || '').slice(0, 160),
      ...(genres(raw.genre_ids).length ? { g: genres(raw.genre_ids) } : {}),
    });
  }
  return out;
}

/** Forme attendue par toItem() de l'interface. */
export function rawOf(it: RecItem): Record<string, unknown> {
  const tv = it.t === 't';
  return {
    id: it.i, media_type: tv ? 'tv' : 'movie', [tv ? 'name' : 'title']: it.n, poster_path: it.p,
    [tv ? 'first_air_date' : 'release_date']: it.y ? it.y + '-01-01' : '', reason_fr: it.r,
    genre_ids: it.g ?? [],
  };
}

/** Identifiants de genres entiers, sans doublon. */
function genres(v: unknown): number[] {
  return Array.isArray(v) ? [...new Set(v.filter((g): g is number => Number.isInteger(g)))] : [];
}

/** Découpe en valeurs de réglages de moins de 4 Ko. */
export function packRecs(recs: DailyRecs): Record<string, unknown> {
  const chunks: RecItem[][] = [[]];
  for (const it of recs.items) {
    const cur = chunks[chunks.length - 1];
    if (cur.length && JSON.stringify([...cur, it]).length > CHUNK_BYTES) chunks.push([it]);
    else cur.push(it);
  }
  const out: Record<string, unknown> = { aiRecs: { date: recs.date, n: chunks.length } };
  chunks.slice(0, MAX_CHUNKS).forEach((c, k) => { out['aiRecs' + k] = c; });
  for (let k = chunks.length; k < MAX_CHUNKS; k++) out['aiRecs' + k] = null; // supprime les anciens morceaux
  return out;
}

export function unpackRecs(settings: Record<string, unknown> | null | undefined): DailyRecs | null {
  const head = settings?.aiRecs as { date?: unknown; n?: unknown } | undefined;
  if (!head || typeof head.date !== 'string' || typeof head.n !== 'number') return null;
  const items: RecItem[] = [];
  for (let k = 0; k < Math.min(head.n, MAX_CHUNKS); k++) {
    const c = settings?.['aiRecs' + k];
    if (!Array.isArray(c)) return null;
    items.push(...(c as RecItem[]));
  }
  return { date: head.date, items };
}

const localKey = (): string => 'laststream.aiRecs.' + (auth.profile?.id ?? 'local');

function readLocal(): DailyRecs | null {
  try {
    const raw = globalThis.localStorage?.getItem(localKey());
    const v = raw ? (JSON.parse(raw) as DailyRecs) : null;
    return v && typeof v.date === 'string' && Array.isArray(v.items) ? v : null;
  } catch {
    return null;
  }
}

function writeLocal(recs: DailyRecs): void {
  try {
    globalThis.localStorage?.setItem(localKey(), JSON.stringify(recs));
  } catch {
    // Stockage indisponible : la liste sera recalculée au prochain chargement.
  }
}

/** Liste enregistrée (réglages du profil, sinon stockage local). */
export async function readRecs(): Promise<DailyRecs | null> {
  if (isServerMode() && auth.profile) {
    try {
      const { settings } = await getSettings(auth.profile.id);
      const r = unpackRecs(settings);
      if (r) return r;
    } catch {
      // Serveur injoignable : repli local.
    }
  }
  return readLocal();
}

export async function saveRecs(recs: DailyRecs): Promise<void> {
  writeLocal(recs);
  if (isServerMode() && auth.profile) {
    try {
      await putSettings(auth.profile.id, packRecs(recs));
    } catch {
      // La liste locale suffit pour aujourd'hui.
    }
  }
}

/** Titres à ne pas recommander : déjà vus, en bibliothèque ou notés (identifiants TMDB). */
export function excludeList(): Array<{ type: 'movie' | 'tv'; tmdbId: number }> {
  const map = new Map<string, { type: 'movie' | 'tv'; tmdbId: number }>();
  const add = (type: string, id: number): void => {
    if ((type === 'movie' || type === 'tv') && Number.isFinite(id)) map.set(type + ':' + id, { type, tmdbId: id });
  };
  userStore.getLibrary().forEach((e) => add(e.type, e.id));
  userStore.continueWatching(50).forEach((p) => add(p.type, p.id));
  const rated = (userStore as unknown as { getRatings?: () => Array<{ type: string; id: number }> }).getRatings?.() ?? [];
  rated.forEach((r) => add(r.type, r.id));
  userStore.getSeen().forEach((k) => { const [t, id] = k.split(':'); add(t, Number(id)); });
  // Le serveur ne lit que 500 entrées : un gros historique de titres vus passe en dernier.
  return [...map.values()].slice(0, 500);
}
