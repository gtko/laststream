import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { appFetch } from './crossFetch';
import { PUBLIC_BASE } from './config';

/* Mise à jour en un tap de l'application Android (plugin natif `LaststreamUpdate`). Le serveur Laststream publie
 * /app/android/latest.json ({versionCode, versionName, url, sha256, size, notes}) ; l'interface étant chargée depuis le serveur,
 * seul le code natif (lecteur, plugins) demande une nouvelle APK. Fonctions pures testées ; réseau et plugin en bordure. */

export interface UpdateManifest {
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  size?: number;
  notes?: string;
}

const MANIFEST_PATH = '/app/android/latest.json';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECKED_KEY = 'laststream.update.checked';
const DISMISSED_KEY = 'laststream.update.dismissed';

const SHA256 = /^[0-9a-f]{64}$/;

/** Manifeste valide ou null. L'adresse relative est résolue sur le serveur Laststream ; seul le https est accepté. */
export function parseManifest(raw: unknown, base: string = PUBLIC_BASE): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const code = Number(o.versionCode);
  if (!Number.isInteger(code) || code <= 0) return null;
  const sha = typeof o.sha256 === 'string' ? o.sha256.trim().toLowerCase() : '';
  if (!SHA256.test(sha)) return null;
  if (typeof o.url !== 'string' || !o.url.trim()) return null;
  let url: URL;
  try { url = new URL(o.url.trim(), base.replace(/\/*$/, '/')); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const name = typeof o.versionName === 'string' && o.versionName.trim() ? o.versionName.trim() : String(code);
  const size = Number(o.size);
  return {
    versionCode: code, versionName: name, url: url.toString(), sha256: sha,
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(typeof o.notes === 'string' && o.notes.trim() ? { notes: o.notes.trim() } : {}),
  };
}

/** Une version publiée est plus récente si son versionCode est strictement supérieur. */
export const isNewer = (publishedCode: number, installedCode: number): boolean =>
  Number.isFinite(publishedCode) && Number.isFinite(installedCode) && publishedCode > installedCode;

/** Contrôle au lancement puis au plus une fois toutes les 24 h. */
export function shouldCheck(lastCheckMs: number | null, nowMs: number): boolean {
  return lastCheckMs === null || !Number.isFinite(lastCheckMs) || lastCheckMs > nowMs || nowMs - lastCheckMs >= CHECK_INTERVAL_MS;
}

/** La bannière revient pour une version plus récente que celle déjà écartée. */
export const isDismissed = (dismissedCode: number | null, publishedCode: number): boolean => dismissedCode !== null && publishedCode <= dismissedCode;

export interface BannerModel {
  text: string;
  action: string;
}

export function bannerModel(m: UpdateManifest): BannerModel {
  return { text: `Mise à jour disponible (v${m.versionName})`, action: 'Installer' };
}

export function sizeLabel(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} Mo` : `${Math.ceil(bytes / 1024)} Ko`;
}

// ---------- Plugin natif ----------

interface LaststreamUpdatePlugin {
  getVersion(): Promise<{ versionCode: number; versionName: string }>;
  canInstall(): Promise<{ allowed: boolean }>;
  install(options: { url: string; sha256: string; versionCode: number }): Promise<{ started: boolean }>;
  addListener(event: 'updateProgress', fn: (d: { percent: number }) => void): Promise<PluginListenerHandle>;
}

const NativeUpdate = registerPlugin<LaststreamUpdatePlugin>('LaststreamUpdate');

export function updateSupported(): boolean {
  try { return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LaststreamUpdate'); } catch { return false; }
}

const readNumber = (k: string): number | null => {
  try {
    const v = globalThis.localStorage?.getItem(k);
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
};
const writeNumber = (k: string, n: number): void => { try { globalThis.localStorage?.setItem(k, String(n)); } catch { /* stockage indisponible */ } };

const lastChecked = (): number | null => readNumber(CHECKED_KEY);
export const dismissedCode = (): number | null => readNumber(DISMISSED_KEY);
export const dismiss = (m: UpdateManifest): void => writeNumber(DISMISSED_KEY, m.versionCode);

/**
 * Cherche une version plus récente que celle installée. Renvoie le manifeste, ou null (à jour, hors application native,
 * serveur injoignable, manifeste invalide). `force` ignore le délai de 24 h et la version écartée.
 */
export async function checkForUpdate(opts: { force?: boolean; now?: number } = {}): Promise<UpdateManifest | null> {
  if (!updateSupported()) return null;
  const now = opts.now ?? Date.now();
  if (!opts.force && !shouldCheck(lastChecked(), now)) return null;
  try {
    const [installed, res] = await Promise.all([
      NativeUpdate.getVersion(),
      appFetch(PUBLIC_BASE + MANIFEST_PATH, { cache: 'no-store', headers: { accept: 'application/json' } }),
    ]);
    if (!res.ok) return null;
    writeNumber(CHECKED_KEY, now);
    const manifest = parseManifest(await res.json().catch(() => null));
    if (!manifest || !isNewer(manifest.versionCode, installed.versionCode)) return null;
    if (!opts.force && isDismissed(dismissedCode(), manifest.versionCode)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export type InstallResult = 'started' | 'permission' | 'hash' | 'signature' | 'network' | 'invalid';

/** Télécharge, vérifie l'empreinte puis ouvre l'installeur. `permission` : l'écran « sources inconnues » vient de s'ouvrir. */
export async function installUpdate(m: UpdateManifest, onProgress: (percent: number) => void = () => {}): Promise<InstallResult> {
  let handle: PluginListenerHandle | null = null;
  try {
    handle = await NativeUpdate.addListener('updateProgress', (d) => onProgress(typeof d?.percent === 'number' ? d.percent : -1));
  } catch { /* progression facultative */ }
  try {
    await NativeUpdate.install({ url: m.url, sha256: m.sha256, versionCode: m.versionCode });
    return 'started';
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    return code === 'permission' || code === 'hash' || code === 'signature' || code === 'network' ? code : code === 'bad_request' ? 'invalid' : 'network';
  } finally {
    try { await handle?.remove(); } catch { /* ignoré */ }
  }
}

export const INSTALL_MESSAGES: Record<Exclude<InstallResult, 'started'>, string> = {
  permission: 'Autorise l’installation depuis Laststream dans les réglages qui viennent de s’ouvrir, puis reviens et appuie de nouveau sur Installer.',
  hash: 'Le fichier téléchargé est corrompu : mise à jour annulée.',
  signature: 'Cette version est signée avec une autre clé que l’app installée : Android refuse de la mettre à jour. Désinstalle Laststream, puis installe la dernière version depuis laststream.app (une seule fois).',
  network: 'Téléchargement impossible pour le moment. Réessaie plus tard.',
  invalid: 'Mise à jour invalide.',
};
