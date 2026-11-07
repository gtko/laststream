/* Import des addons d'une source (Stremio, Nuvio) : étape séparée, désactivée par défaut, absente des versions App Store et
 * Google Play (distribution.ts). Chaque addon choisi est lu depuis l'appareil (manifest) puis inscrit dans le registre local des
 * catalogues (addonCatalog.ts), marqué « importé » : son adresse, qui peut contenir une clé, reste sur cet appareil et n'est
 * jamais envoyée au serveur. Rien n'est recommandé ni classé : l'utilisateur choisit, le journal dit ce qui s'est passé. */

import { addonKeyOf, catalogDisplay, parseManifestCatalogs, readAddonCatalogs, setAddonCatalog, type AddonCatalogEntry } from '../addonCatalog';
import { appFetch } from '../crossFetch';
import { isStoreBuild } from '../distribution';
import { isObject, str, type MigrationAddon } from './types';

const TIMEOUT_MS = 10_000;

type AddonOutcome = 'added' | 'ignored' | 'failed';

/** Ligne du journal : nom de l'addon (jamais son adresse), issue, raison en langage clair. */
export interface AddonLogEntry {
  name: string;
  outcome: AddonOutcome;
  reason: string;
}

export const addonImportAvailable = (): boolean => !isStoreBuild();

/** `stremio://…` → `https://…`, adresse terminée par /manifest.json (vide si invalide). */
export function manifestUrlOf(raw: string): string {
  const u = raw.trim().replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) return '';
  try {
    const url = new URL(u);
    if (!/manifest\.json$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/+$/, '') + '/manifest.json';
    return url.toString();
  } catch {
    return '';
  }
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i;

/** Raison d'écarter un addon avant toute requête ; null s'il peut être lu. */
export function precheck(a: MigrationAddon, registry: Record<string, AddonCatalogEntry>): string | null {
  if (a.official) return 'Addon officiel de Stremio : Laststream fournit déjà ces informations.';
  const url = manifestUrlOf(a.manifestUrl);
  if (!url) return 'Adresse illisible ou protocole non pris en charge.';
  const host = new URL(url).hostname;
  if (LOOPBACK.test(host)) return 'Addon installé sur l’ancien appareil (adresse locale) : injoignable depuis celui-ci.';
  if (registry[addonKeyOf(url)]) return 'Déjà présent sur cet appareil.';
  return null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function readManifest(url: string, fetchFn: FetchFn): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, { signal: ctrl.signal });
    } catch {
      throw new Error(ctrl.signal.aborted ? 'L’addon n’a pas répondu à temps.' : 'L’addon est injoignable depuis cet appareil.');
    }
    if (!res.ok) throw new Error('L’addon a répondu par une erreur (HTTP ' + res.status + ').');
    try { return await res.json(); } catch { throw new Error('Le manifest de l’addon est illisible.'); }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Importe les addons choisis (`selected` : adresses de manifest) et renvoie le journal, un addon par ligne, dans l'ordre de
 * la source. Les addons non choisis y figurent comme ignorés.
 */
export async function importAddons(addons: readonly MigrationAddon[], selected: ReadonlySet<string>, opts: { fetchFn?: FetchFn; now?: number } = {}): Promise<AddonLogEntry[]> {
  if (!addonImportAvailable()) return [];
  const fetchFn = opts.fetchFn ?? ((u, i) => appFetch(u, i));
  const log: AddonLogEntry[] = [];
  for (const a of addons) {
    if (!selected.has(a.manifestUrl)) { log.push({ name: a.name, outcome: 'ignored', reason: 'Non sélectionné.' }); continue; }
    const why = precheck(a, readAddonCatalogs());
    if (why) { log.push({ name: a.name, outcome: 'ignored', reason: why }); continue; }
    const url = manifestUrlOf(a.manifestUrl);
    let manifest: unknown;
    try {
      manifest = await readManifest(url, fetchFn);
    } catch (err) {
      log.push({ name: a.name, outcome: 'failed', reason: err instanceof Error ? err.message : 'Lecture du manifest impossible.' });
      continue;
    }
    const parsed = parseManifestCatalogs(manifest);
    const name = (isObject(manifest) && str(manifest.name)) || a.name;
    const showable = parsed.catalogs.filter((c) => catalogDisplay(c) !== 'hidden');
    if (!showable.length) {
      log.push({ name, outcome: 'ignored', reason: parsed.resources.stream ? 'Cet addon ne fournit que des sources de lecture, pas de catalogue : rien à ajouter ici.' : 'Cet addon ne déclare aucun catalogue affichable.' });
      continue;
    }
    const logo = isObject(manifest) ? str(manifest.logo) || str(manifest.icon) : '';
    setAddonCatalog(addonKeyOf(url), {
      manifestUrl: url, name, ...(logo ? { logo } : {}), home: false, catalogs: parsed.catalogs, idPrefixes: parsed.idPrefixes,
      types: parsed.types, resources: parsed.resources, at: opts.now ?? Date.now(), imported: true,
    });
    if (!readAddonCatalogs()[addonKeyOf(url)]) { log.push({ name, outcome: 'failed', reason: 'Stockage de l’appareil plein : addon non enregistré.' }); continue; }
    log.push({ name, outcome: 'added', reason: showable.length + (showable.length > 1 ? ' catalogues ajoutés' : ' catalogue ajouté') + ' sur cet appareil, masqués à l’accueil tant que tu ne les affiches pas.' });
  }
  return log;
}

/** Addons importés sur cet appareil (pour les afficher, les montrer à l'accueil ou les retirer). */
export const importedAddons = (): Array<[string, AddonCatalogEntry]> => Object.entries(readAddonCatalogs()).filter(([, e]) => e.imported === true);
