import { isRecord } from '../sources/http.js';
import { recordMetaEvent } from '../metrics/index.js';
import { buildCatalogMetas, CATALOGS, catalogMetas, type CatalogDef, type StremioMeta } from './catalog.js';
import type { LtContext } from './context.js';
import { etagOf } from './meta.js';

/**
 * Rangées d'accueil communes : les catalogues de catalog.ts (tendances, films et séries populaires). Elles ne dépendent
 * ni du profil ni du compte (seul le jeton TMDB de la requête les lit, sans effet sur le contenu). Le cron (toutes les
 * 6 h) les précalcule dans R2 (`rows/<identifiant>.json`) ; la route les sert telles quelles. Aucune donnée personnelle.
 */

/** Enregistrement stocké : corps JSON de la réponse `{ metas }`, empreinte (ETag) et date de génération (métadonnées R2). */
export interface RowBlob {
  body: string;
  etag: string;
  generatedAt: number;
}

/** Stockage des rangées (R2 sous Workers). `get` renvoie undefined si l'objet est absent ; `put` réécrit l'objet entier. */
export interface RowBlobStore {
  get(key: string): Promise<RowBlob | undefined>;
  put(key: string, blob: RowBlob): Promise<void>;
}

/** Clé R2 d'une rangée. */
export function rowKey(def: CatalogDef): string {
  return `rows/${def.id}.json`;
}

/** Ressources de la route : contexte lt, stockage (absent : calcul à chaque demande), horloge, travail après la réponse. */
export interface RowRuntime {
  ctx: LtContext;
  blobs: RowBlobStore | undefined;
  now: () => number;
  /** Travail après la réponse (Workers : waitUntil ; Node : sans suivi). */
  background: (work: Promise<unknown>) => void;
}

/** Rangée servie : corps exact, empreinte, et origine (R2 ou calcul). */
export interface ServedRow {
  body: string;
  etag: string;
  source: 'r2' | 'computed';
}

/** Statut d'une rangée au passage du cron (aucun contenu n'est journalisé). */
export type RowStatus = 'written' | 'unchanged' | 'skipped' | 'failed';

function rowBody(metas: StremioMeta[]): string {
  return JSON.stringify({ metas });
}

/** Rangée utilisable : contenu JSON contenant au moins une méta. Sinon (absente, vide, illisible) : false. */
function usableRow(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && Array.isArray(parsed.metas) && parsed.metas.length > 0;
  } catch {
    return false;
  }
}

/** Lecture du stockage : une erreur ou une rangée inutilisable est traitée comme absente (journalisé sans contenu). */
async function readRow(blobs: RowBlobStore, key: string): Promise<RowBlob | undefined> {
  try {
    const blob = await blobs.get(key);
    if (blob !== undefined && !usableRow(blob.body)) {
      console.warn('[lt][rows] rangée illisible dans le stockage : recalculée');
      return undefined;
    }
    return blob;
  } catch (err) {
    console.warn(`[lt][rows] lecture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
    return undefined;
  }
}

/** Écrit la rangée seulement si son empreinte a changé (ou si elle est absente). */
async function storeRow(blobs: RowBlobStore, key: string, body: string, etag: string, now: number): Promise<'written' | 'unchanged'> {
  const previous = await blobs.get(key);
  if (previous !== undefined && previous.etag === etag) return 'unchanged';
  await blobs.put(key, { body, etag, generatedAt: now });
  return 'written';
}

/**
 * Sert une rangée commune : R2 d'abord, telle quelle (avec son empreinte). Absente ou vide : calcul comme avant, puis
 * écriture en arrière-plan quand R2 est disponible (jamais de rangée vide écrite). Sans R2 (Node, tests) : calcul seul.
 */
export async function serveRow(rt: RowRuntime, token: string, def: CatalogDef): Promise<ServedRow> {
  const key = rowKey(def);
  const blobs = rt.blobs;
  if (blobs !== undefined) {
    const stored = await readRow(blobs, key);
    if (stored !== undefined) {
      recordMetaEvent('r2hit', 'rows');
      return { body: stored.body, etag: stored.etag, source: 'r2' };
    }
    recordMetaEvent('r2miss', 'rows');
  }
  const metas = await catalogMetas(rt.ctx, token, def, 0);
  const body = rowBody(metas);
  const etag = etagOf(body);
  if (blobs !== undefined && metas.length > 0) {
    rt.background(
      storeRow(blobs, key, body, etag, rt.now()).catch((err: unknown) => {
        console.warn(`[lt][rows] écriture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
      }),
    );
  }
  return { body, etag, source: 'computed' };
}

/** Ressources du cron : contexte lt, stockage R2 et horloge. */
export interface RowRefreshRuntime {
  ctx: LtContext;
  blobs: RowBlobStore;
  now: () => number;
}

/**
 * Reconstruit les rangées communes dans R2 (Cron Trigger). Une rangée en échec ou vide garde son contenu précédent ;
 * une rangée dont le contenu n'a pas changé n'est pas réécrite. Renvoie le statut de chaque rangée (identifiant → statut).
 */
export async function refreshRows(rt: RowRefreshRuntime, token: string, defs: readonly CatalogDef[] = CATALOGS): Promise<Record<string, RowStatus>> {
  const statuses: Record<string, RowStatus> = {};
  for (const def of defs) {
    try {
      const metas = await buildCatalogMetas(rt.ctx, token, def, 1);
      if (metas.length === 0) {
        statuses[def.id] = 'skipped';
        continue;
      }
      const body = rowBody(metas);
      statuses[def.id] = await storeRow(rt.blobs, rowKey(def), body, etagOf(body), rt.now());
    } catch (err) {
      console.warn(`[lt][rows] ${def.id} : reconstruction échouée (${err instanceof Error ? err.name : 'inconnue'})`);
      statuses[def.id] = 'failed';
    }
  }
  return statuses;
}
