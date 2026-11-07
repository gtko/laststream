/* Quota et persistance du stockage web (ODY-199) : `navigator.storage.estimate()` et `persist()`. Aucune de ces API n'est
 * garantie (absentes de vieux navigateurs, valeurs arrondies par Safari et Firefox pour ne pas servir d'empreinte) : chaque
 * fonction répond « inconnu » (null) au lieu de lever. Sans persistance, le navigateur peut vider le stockage sous pression
 * (Safari le fait aussi après 7 jours sans visite) : l'interface doit proposer de la demander. */

export interface StorageManagerLike {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
}

export interface WebStorageInfo {
  /** Octets utilisés par l'origine (toutes données confondues). */
  usage: number | null;
  /** Octets que le navigateur accorde à l'origine (estimation). */
  quota: number | null;
  /** `quota - usage`, jamais négatif ; null si l'un des deux est inconnu. */
  available: number | null;
  /** Le navigateur promet de ne pas vider le stockage ; null si inconnu. */
  persisted: boolean | null;
}

const defaultStorage = (): StorageManagerLike | undefined => (typeof navigator === 'undefined' ? undefined : navigator.storage);

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

export async function estimateStorage(storage: StorageManagerLike | undefined = defaultStorage()): Promise<WebStorageInfo> {
  let usage: number | null = null;
  let quota: number | null = null;
  let persisted: boolean | null = null;
  try {
    const est = await storage?.estimate?.();
    usage = finite(est?.usage);
    quota = finite(est?.quota);
  } catch {
    /* estimation indisponible */
  }
  try {
    persisted = (await storage?.persisted?.()) ?? null;
  } catch {
    /* état inconnu */
  }
  return { usage, quota, available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null, persisted };
}

/**
 * Demande au navigateur de ne pas vider le stockage ; vrai s'il l'accorde. À appeler sur un geste de l'utilisateur
 * (Firefox ouvre une invite). Chrome et Safari décident seuls, d'après l'usage du site : un refus n'est pas une erreur.
 */
export async function requestPersistence(storage: StorageManagerLike | undefined = defaultStorage()): Promise<boolean> {
  try {
    if (await storage?.persisted?.()) return true;
    return (await storage?.persist?.()) === true;
  } catch {
    return false;
  }
}
