/* Réglages des téléchargements (ODY-204) : limite d'espace, Wi-Fi seulement, qualité et langues mémorisées, question déjà posée.
 * Stockage local sous le préfixe `laststream.downloads.` ; chaque lecture et chaque écriture est protégée : un stockage refusé
 * (navigation privée, données bloquées) donne les valeurs par défaut sans rien lever. Ces réglages ne contiennent aucun lien. */

const GB = 1024 ** 3;

/** Limites d'espace proposées, en octets ; null : sans limite. */
export const LIMIT_CHOICES: readonly (number | null)[] = [5 * GB, 10 * GB, 20 * GB, 50 * GB, null];

const DEFAULT_LIMIT_BYTES = 20 * GB;
const PREFIX = 'laststream.downloads.';
const KEY = {
  limit: `${PREFIX}limit`,
  wifi: `${PREFIX}wifi`,
  quality: `${PREFIX}quality`,
  langs: `${PREFIX}langs`,
  asked: `${PREFIX}asked`,
  /** Marqueur posé à la déconnexion : les téléchargements du compte sont à effacer avant toute reprise (voir service.ts). */
  purge: `${PREFIX}purge`,
  /** Compte propriétaire des téléchargements de l'appareil (serveur + pseudo), voir `claimDownloads` (service.ts). */
  owner: `${PREFIX}owner`,
  /** Supprimer un téléchargement terminé quand son titre est marqué vu (voir afterWatch.ts). Réglage à part. */
  deleteAfterWatch: `${PREFIX}deleteAfterWatch`,
  /** Navigateur web : où vont les téléchargements (voir webSave.ts, LAST-498). */
  webDestination: `${PREFIX}webDestination`,
} as const;
/** Valeur écrite pour « sans limite ». */
const NO_LIMIT = 'none';

export interface DownloadSettings {
  limitBytes: number | null;
  wifiOnly: boolean;
  quality?: string;
  langs?: string[];
  /** La question du premier téléchargement (espace, Wi-Fi) a été posée. */
  asked: boolean;
}

/** Point d'écriture vers le gestionnaire (posé par le service quand il existe) : évite un import circulaire. */
let limitSink: ((bytes: number | null) => void) | null = null;

/** Enregistre (ou retire, avec null) la fonction qui applique la limite au gestionnaire actif. */
export function bindDownloadLimit(fn: ((bytes: number | null) => void) | null): void {
  limitSink = fn;
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* stockage indisponible : le réglage vaut pour cette session seulement */
  }
}

function readLimit(): number | null {
  const raw = read(KEY.limit);
  if (raw === null) return DEFAULT_LIMIT_BYTES;
  if (raw === NO_LIMIT) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT_BYTES;
}

function readLangs(): string[] | undefined {
  const raw = read(KEY.langs);
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const langs = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    return langs.length > 0 ? langs : undefined;
  } catch {
    return undefined;
  }
}

/** Réglages courants ; défauts : limite de 20 Go, Wi-Fi seulement désactivé, question non posée. */
export function getDownloadSettings(): DownloadSettings {
  const quality = read(KEY.quality);
  const langs = readLangs();
  return {
    limitBytes: readLimit(),
    wifiOnly: read(KEY.wifi) === '1',
    ...(quality ? { quality } : {}),
    ...(langs ? { langs } : {}),
    asked: read(KEY.asked) === '1',
  };
}

/**
 * Persiste les champs fournis. `quality` vide ou `langs` vide : le choix est oublié (retour au choix automatique).
 * Une limite change aussi celle du gestionnaire actif, s'il existe.
 */
export function setDownloadSettings(p: Partial<DownloadSettings>): void {
  if (p.limitBytes !== undefined) {
    write(KEY.limit, p.limitBytes === null ? NO_LIMIT : String(Math.max(0, p.limitBytes)));
    limitSink?.(p.limitBytes);
  }
  if (p.wifiOnly !== undefined) write(KEY.wifi, p.wifiOnly ? '1' : '0');
  if (p.quality !== undefined) write(KEY.quality, p.quality ? p.quality : null);
  if (p.langs !== undefined) write(KEY.langs, p.langs.length > 0 ? JSON.stringify(p.langs) : null);
  if (p.asked !== undefined) write(KEY.asked, p.asked ? '1' : null);
}

/** Supprimer après visionnage : désactivé par défaut. Réglage à part, hors de `getDownloadSettings`. */
export function getDeleteAfterWatch(): boolean {
  return read(KEY.deleteAfterWatch) === '1';
}

/** Écrit le réglage « supprimer après visionnage ». */
export function setDeleteAfterWatch(on: boolean): void {
  write(KEY.deleteAfterWatch, on ? '1' : '0');
}

/**
 * Destination des téléchargements dans le navigateur web (LAST-498) : `device` (par défaut) enregistre le fichier sur l'appareil,
 * dans le dossier choisi ou celui du navigateur ; `app` le garde dans l'app pour la lecture hors ligne (hébergeurs compatibles CORS).
 */
export type WebDestination = 'device' | 'app';

export function getWebDestination(): WebDestination {
  return read(KEY.webDestination) === 'app' ? 'app' : 'device';
}

export function setWebDestination(d: WebDestination): void {
  write(KEY.webDestination, d === 'app' ? 'app' : null);
}

/**
 * Marqueur de purge : posé à la déconnexion explicite, il survit à un rechargement de la page (la purge immédiate peut être
 * coupée). Le prochain démarrage du gestionnaire efface alors les téléchargements avant toute reprise.
 */
export function markPurgePending(): void {
  write(KEY.purge, '1');
}

/** Vrai tant que la purge demandée par une déconnexion n'est pas terminée. */
export function isPurgePending(): boolean {
  return read(KEY.purge) === '1';
}

/** Efface le marqueur une fois la purge terminée. */
export function clearPurgePending(): void {
  write(KEY.purge, null);
}

/** Compte propriétaire des téléchargements (serveur et pseudo), ou null : aucun propriétaire mémorisé. */
export function getDownloadsOwner(): string | null {
  return read(KEY.owner) || null;
}

/** Mémorise le compte propriétaire des téléchargements ; null l'oublie. */
export function setDownloadsOwner(owner: string | null): void {
  write(KEY.owner, owner || null);
}

/**
 * Connexion de `identity` (serveur et pseudo du compte ; vide : compte inconnu) : les téléchargements gardés sur l'appareil ne
 * servent que leur propriétaire. Synchrone (rien ne se lit entre la connexion et la décision) ; vrai si une purge est à faire.
 * - même compte : rien ne change (une 401 suivie d'une reconnexion au même compte garde tout) ;
 * - sans propriétaire mémorisé : `adoptUnowned` (session restaurée) le donne à ce compte ; sinon (connexion) purge, car on ne
 *   sait pas à qui appartiennent des fichiers antérieurs au suivi du propriétaire ;
 * - autre compte ou autre serveur : le marqueur de purge est posé (la lecture hors ligne est bloquée) et le nouveau propriétaire
 *   mémorisé ; l'appelant lance alors `purgeForOwnerChange` (service.ts).
 */
export function claimDownloadsOwner(identity: string, adoptUnowned = false): boolean {
  const owner = getDownloadsOwner();
  if (identity !== '' && owner === identity) return false;
  if (identity !== '' && owner === null && adoptUnowned) {
    setDownloadsOwner(identity);
    return false;
  }
  markPurgePending();
  setDownloadsOwner(identity || null);
  return true;
}

/** Connexion mobile facturée à l'usage. Faux quand le navigateur ne dit pas le type de connexion. */
export function isCellular(): boolean {
  try {
    const connection = (globalThis.navigator as { connection?: { type?: string } } | undefined)?.connection;
    return connection?.type === 'cellular';
  } catch {
    return false;
  }
}
