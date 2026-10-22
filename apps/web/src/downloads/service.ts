/* Service des téléchargements (ODY-204) : seule porte d'entrée de l'interface vers le gestionnaire.
 *
 * Le gestionnaire est créé à la demande, une seule fois, avec le magasin de la plateforme : Android (plugin natif, ODY-200),
 * coque Windows (`createShellDownloadStore`, ODY-201), navigateur (OPFS ou IndexedDB, ODY-199).
 * Rien n'est envoyé au serveur Laststream. Aucune URL ne sort du gestionnaire : l'index ne garde que la référence du flux
 * (voir streamResolver.ts), et le lien est retrouvé au moment de télécharger. */
import { Capacitor } from '@capacitor/core';
import { matchesLanguage, QUALITY_GROUP_ORDER, type QualityGroupKey } from '../data/sources';
import type { Lang } from '../data/stream';
import type { SourceView } from '../sources/info';
import { knownBandwidthKbps, loadSources, recommendFor, type SourceRequest } from '../sources/load';
import { isShellEnvironment } from '../player/shell';
import { createAndroidDownloads } from './android';
import { createDownloadIndex } from './index';
import { DownloadManager, type TransferFn } from './manager';
import { bindDownloadLimit, clearPurgePending, getDownloadSettings, isCellular, isPurgePending, setDownloadSettings } from './settings';
import { isAddonLinkUrl } from './linkHosts';
import { createStreamResolver, nativeLinkPolicy, isDownloadable, langsOfView, streamToSource, type LinkPolicy } from './streamResolver';
import { DownloadError, downloadId, type DownloadIndex, type DownloadItem, type DownloadSource, type DownloadStore, type SpaceInfo } from './types';
import { createWebDownloadHttp } from './webHttp';
import { createShellDownloadStore } from './shellStore';
import { createWebDownloadStore, type WebDownloadStore } from './webStore';

export type Availability = { ok: true } | { ok: false; reason: string };

/** Titre visé par un téléchargement : une saison et un épisode pour une série, rien pour un film. */
export interface DownloadTarget {
  key: string;
  type: 'movie' | 'tv';
  id: string;
  name: string;
  season?: number;
  episode?: number;
}

type PlatformKind = 'android' | 'shell' | 'web';

let registered: { store: DownloadStore; transfer?: TransferFn } | null = null;
let manager: DownloadManager | null = null;
/** Création en cours : les appels concurrents attendent la même instance. */
let starting: Promise<DownloadManager | null> | null = null;
let index: DownloadIndex | null = null;
let webStore: WebDownloadStore | null = null;
let unsubscribe: (() => void) | null = null;
/** Dernière liste connue du gestionnaire (vide avant l'initialisation). */
let cache: readonly DownloadItem[] = [];
const listeners = new Set<(items: readonly DownloadItem[]) => void>();

function platformKind(): PlatformKind {
  try {
    if (Capacitor.getPlatform() === 'android') return 'android';
  } catch {
    /* hors Capacitor : navigateur ou coque */
  }
  return isShellEnvironment() ? 'shell' : 'web';
}

/** Le navigateur offre-t-il un stockage (IndexedDB ou OPFS) ? Sans lever. */
function webStorageAvailable(): boolean {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) return true;
    const storage = (navigator as unknown as { storage?: { getDirectory?: unknown } }).storage;
    return typeof storage?.getDirectory === 'function';
  } catch {
    return false;
  }
}

/** Les téléchargements sont-ils possibles sur cet appareil ? Une raison lisible sinon. */
export function platformAvailability(): Availability {
  const kind = platformKind();
  if (kind === 'android' || registered) return { ok: true };
  if (kind === 'shell') return { ok: true }; // magasin de la coque (ODY-201) : une panne du pont se voit à l'ouverture du fichier
  return webStorageAvailable()
    ? { ok: true }
    : { ok: false, reason: 'Ton navigateur ne peut pas conserver les téléchargements hors ligne.' };
}

/**
 * Remplace le magasin par défaut de la plateforme (coque Windows : `createShellDownloadStore`, ODY-201) par un magasin et un
 * transfert fournis. À appeler avant le premier `getDownloads()`.
 */
export function registerDownloadPlatform(p: { store: DownloadStore; transfer?: TransferFn }): void {
  registered = p;
}

/** Transfert natif de la plateforme (Android, ou coque avec un transfert) : c'est le seul cas où la politique des liens est celle de la plateforme. */
function usesNativeTransfer(): boolean {
  return registered ? registered.transfer !== undefined : platformKind() === 'android';
}

/**
 * Hôtes acceptés pour les liens des addons. Web : hôtes publics https (linkHosts.ts), comme le transport HTTP.
 * Transfert natif : https public sur le port par défaut, sans identifiants (ODY-232) ; le code natif le revérifie.
 */
function linkPolicy(): LinkPolicy {
  return usesNativeTransfer() ? nativeLinkPolicy : isAddonLinkUrl;
}

/** Diffuse la liste courante aux abonnés et la garde en cache synchrone. */
function publish(items: readonly DownloadItem[]): void {
  cache = items;
  for (const fn of [...listeners]) {
    try {
      fn(items);
    } catch {
      /* un abonné défaillant n'empêche pas les autres */
    }
  }
}

/**
 * Efface les téléchargements connus de l'index : fichier (magasin) puis entrée d'index, sans reprise. Ne lève jamais :
 * une entrée dont le fichier ne part pas sort quand même de l'index, sinon elle reprendrait au démarrage.
 */
async function wipeStored(idx: DownloadIndex, store: DownloadStore): Promise<void> {
  let rows: DownloadItem[] = [];
  try {
    rows = await idx.all();
  } catch {
    /* index illisible : rien à lister */
  }
  for (const row of rows) {
    try {
      await store.remove(row.id);
    } catch {
      /* fichier absent ou magasin indisponible : l'entrée part quand même */
    }
    try {
      await idx.delete(row.id);
    } catch {
      /* index indisponible : l'entrée reste, et la purge reprend au démarrage suivant */
    }
  }
}

/**
 * Construit le gestionnaire. `purge` (déconnexion) ou un marqueur de purge posé : les téléchargements du compte précédent
 * sont effacés AVANT l'initialisation, donc rien ne reprend.
 */
async function build(purge: boolean): Promise<DownloadManager | null> {
  let store: DownloadStore;
  let transfer: TransferFn | undefined;
  if (registered) {
    store = registered.store;
    transfer = registered.transfer;
  } else if (platformKind() === 'android') {
    ({ store, transfer } = createAndroidDownloads());
  } else if (platformKind() === 'shell') {
    store = createShellDownloadStore();
  } else if (platformKind() === 'web') {
    webStore = createWebDownloadStore();
    store = webStore;
  } else {
    return null;
  }
  const idx = createDownloadIndex();
  index = idx;
  const created = new DownloadManager({
    resolver: createStreamResolver({ linkPolicy: linkPolicy() }),
    // Hors transfert de plateforme, les morceaux passent par ce transport : liens https publics des addons (voir linkHosts.ts).
    http: createWebDownloadHttp({ allowHost: isAddonLinkUrl }),
    store,
    index: idx,
    transfer,
    limitBytes: getDownloadSettings().limitBytes,
  });
  unsubscribe = created.subscribe(publish);
  bindDownloadLimit((bytes) => created.setLimit(bytes));
  if (purge || isPurgePending()) {
    await wipeStored(idx, store);
    clearPurgePending();
  }
  // L'index est relu ici : les téléchargements inachevés reprennent d'eux-mêmes.
  await created.init();
  return created;
}

/** Gestionnaire, créé une fois ; `purge` : construit en mode purge. Null si les téléchargements ne sont pas disponibles. */
function startManager(purge: boolean): Promise<DownloadManager | null> {
  if (manager) return Promise.resolve(manager);
  if (!platformAvailability().ok) return Promise.resolve(null);
  starting ??= build(purge)
    .then((created) => {
      manager = created;
      return created;
    })
    .catch(() => null)
    .finally(() => {
      starting = null;
    });
  return starting;
}

/** Gestionnaire, créé une fois (lazy) ; null si les téléchargements ne sont pas disponibles sur cet appareil. */
export function getDownloads(): Promise<DownloadManager | null> {
  return startManager(false);
}

export function downloadIdFor(t: DownloadTarget): string {
  return downloadId(t.key, t.season, t.episode);
}

const requestOf = (t: DownloadTarget): SourceRequest => ({
  type: t.type,
  id: t.id,
  name: t.name,
  key: t.key,
  season: t.season ?? null,
  episode: t.episode ?? null,
});

/**
 * Sources téléchargeables du titre : HLS, liens hors de la politique de la plateforme et torrents sans débrideur exclus.
 * Une erreur de chargement devient une erreur réseau réessayable.
 */
async function downloadableViews(t: DownloadTarget): Promise<readonly SourceView[]> {
  try {
    const loaded = await loadSources(requestOf(t));
    const policy = linkPolicy();
    return loaded.views.filter((v) => isDownloadable(v, policy));
  } catch (err) {
    throw new DownloadError('network', true, err);
  }
}

const matchesAny = (v: SourceView, langs: readonly string[]): boolean => {
  const info = v.info;
  return info !== null && langs.some((l) => matchesLanguage(info, l as Lang));
};

/** Restreint les sources à la qualité et aux langues choisies, si au moins une source les respecte ; sinon le choix est ignoré. */
function narrow(views: readonly SourceView[], quality: string | undefined, langs: readonly string[] | undefined): SourceView[] {
  let pool = [...views];
  if (quality) {
    const same = pool.filter((v) => v.group === quality);
    if (same.length > 0) pool = same;
  }
  if (langs && langs.length > 0) {
    const same = pool.filter((v) => matchesAny(v, langs));
    if (same.length > 0) pool = same;
  }
  return pool;
}

/**
 * Ajoute le titre à la file. Choix : qualité et langues données (mémorisées ensuite) ou mémorisées ; sinon la source
 * recommandée. Lève `DownloadError('network')` hors Wi-Fi quand « Wi-Fi seulement » est actif et que la connexion est mobile ;
 * `DownloadError('content')` quand rien n'est téléchargeable ; `quota_exceeded` si la limite d'espace serait dépassée.
 */
export async function requestDownload(t: DownloadTarget, choice?: { quality?: string; langs?: string[] }): Promise<DownloadItem> {
  const settings = getDownloadSettings();
  if (settings.wifiOnly && isCellular()) throw new DownloadError('network', true);
  const manager = await getDownloads();
  if (!manager) throw new DownloadError('store_failed', false);
  const quality = choice ? choice.quality : settings.quality;
  const langs = choice ? choice.langs : settings.langs;
  const pool = narrow(await downloadableViews(t), quality, langs);
  if (pool.length === 0) throw new DownloadError('content', false);
  const pick = recommendFor(pool, knownBandwidthKbps())?.view ?? pool[0];
  const source: DownloadSource = {
    ...streamToSource(pick, t),
    ...(quality ? { quality } : {}),
    ...(langs && langs.length > 0 ? { langs: [...langs] } : {}),
  };
  const item = await manager.enqueue({
    metaId: t.key,
    title: t.name,
    ...(t.season !== undefined ? { season: t.season } : {}),
    ...(t.episode !== undefined ? { episode: t.episode } : {}),
    source,
    ...(pick.sizeBytes > 0 ? { estimatedSize: pick.sizeBytes } : {}),
  });
  // Le choix fait sur la feuille devient le choix mémorisé.
  if (choice) setDownloadSettings({ quality: choice.quality ?? '', langs: choice.langs ?? [] });
  return item;
}

/** Choix proposés sur la feuille qualité : une entrée par qualité et jeu de langues, téléchargeables seulement. */
export async function previewChoices(t: DownloadTarget): Promise<Array<{ quality: string; langs: string[]; sizeBytes: number }>> {
  const seen = new Map<string, { quality: string; langs: string[]; sizeBytes: number }>();
  for (const v of await downloadableViews(t)) {
    const langs = langsOfView(v);
    const key = `${v.group}|${langs.join('+')}`;
    if (!seen.has(key)) seen.set(key, { quality: v.group, langs, sizeBytes: v.sizeBytes });
  }
  const rank = (q: string): number => {
    const i = QUALITY_GROUP_ORDER.indexOf(q as QualityGroupKey);
    return i < 0 ? QUALITY_GROUP_ORDER.length : i;
  };
  return [...seen.values()].sort((a, b) => rank(a.quality) - rank(b.quality) || a.langs.join('+').localeCompare(b.langs.join('+')));
}

/** Abonnement à la liste : appelle `fn` aussitôt avec la liste courante. No-op si les téléchargements sont indisponibles. */
export function subscribeDownloads(fn: (items: readonly DownloadItem[]) => void): () => void {
  if (!platformAvailability().ok) return () => undefined;
  listeners.add(fn);
  void getDownloads();
  fn(cache);
  return () => {
    listeners.delete(fn);
  };
}

/** Liste courante connue (synchrone) ; vide avant l'initialisation. */
export function listDownloads(): readonly DownloadItem[] {
  return cache;
}

export async function getSpace(): Promise<SpaceInfo | null> {
  try {
    const m = await getDownloads();
    return m ? await m.space() : null;
  } catch {
    return null;
  }
}

/** Demande le stockage persistant (web seulement) ; vrai si le navigateur l'accorde. */
export async function persistStorage(): Promise<boolean> {
  try {
    await getDownloads();
    return (await webStore?.persist()) ?? false;
  } catch {
    return false;
  }
}

/** Oublie le gestionnaire courant (les données sont déjà retirées) et détache ses liens. */
function dropManager(): void {
  unsubscribe?.();
  unsubscribe = null;
  manager = null;
  starting = null;
  index = null;
  webStore = null;
  bindDownloadLimit(null);
}

/**
 * Déconnexion : met en pause, retire chaque téléchargement (fichier et index), vide l'index et réinitialise le gestionnaire.
 * Si le gestionnaire n'existe pas encore, il est construit en mode purge : aucun transfert ne démarre. Le marqueur de purge
 * est effacé quand la purge est allée au bout ; sinon il reste pour le prochain démarrage. Ne lève jamais.
 */
export async function purgeAll(): Promise<void> {
  try {
    const m = await startManager(true);
    if (m) {
      m.pauseAll();
      for (const item of m.list()) await m.remove(item.id);
    }
    if (index) {
      for (const row of await index.all()) await index.delete(row.id);
    }
    clearPurgePending();
  } catch {
    /* ne lève jamais : la déconnexion ne doit pas échouer ; le marqueur reste pour le démarrage suivant */
  } finally {
    dropManager();
    publish([]);
  }
}

/** Réinitialise tout l'état du module (tests seulement). */
export function resetDownloadsForTests(): void {
  dropManager();
  registered = null;
  cache = [];
  listeners.clear();
}
