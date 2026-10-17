/** Préférences de l'utilisateur (localStorage). Clés conservées de l'application précédente. */

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Stockage indisponible : le réglage vaut pour la session.
  }
}

// ---- Lecture automatique de la meilleure source ----
export const AUTOPLAY_STORAGE_KEY = 'laststream.autoplay';
/** Activée par défaut : seule la valeur '0' la désactive. */
export const getAutoplay = (): boolean => read(AUTOPLAY_STORAGE_KEY) !== '0';
export const setAutoplay = (enabled: boolean): void => write(AUTOPLAY_STORAGE_KEY, enabled ? '1' : '0');

// ---- Débit ----
export const BANDWIDTH_SETTING_KEY = 'laststream.bandwidth.setting';
export const BANDWIDTH_PRESETS_MBPS: readonly number[] = [2, 5, 10, 20, 50, 100];
export type BandwidthSetting = 'auto' | number;

export function getBandwidthSetting(): BandwidthSetting {
  const raw = read(BANDWIDTH_SETTING_KEY);
  if (raw === null || raw === 'auto') return 'auto';
  const mbps = Number(raw);
  return Number.isFinite(mbps) && mbps > 0 ? mbps : 'auto';
}
export const setBandwidthSetting = (value: BandwidthSetting): void =>
  write(BANDWIDTH_SETTING_KEY, value === 'auto' ? 'auto' : String(value));

// ---- Sauts automatiques (intro, récap, épisode suivant) ----
export type SkipPrefName = 'intro' | 'recap' | 'nextEpisode';
export const SKIP_PREF_DEFAULTS: Readonly<Record<SkipPrefName, boolean>> = { intro: false, recap: false, nextEpisode: true };
export const skipPrefKey = (name: SkipPrefName): string => `laststream.skip.${name}`;
export function getSkipPref(name: SkipPrefName): boolean {
  const raw = read(skipPrefKey(name));
  return raw === null ? SKIP_PREF_DEFAULTS[name] : raw === '1';
}
export const setSkipPref = (name: SkipPrefName, enabled: boolean): void => write(skipPrefKey(name), enabled ? '1' : '0');

// ---- Région (watch_region, region, classification) ----
export const REGION_STORAGE_KEY = 'laststream.region';
export interface Region {
  code: string;
  label: string;
  /** Forme avec préposition : « en Suisse », « au Canada ». */
  where: string;
}
export const REGIONS: readonly Region[] = [
  { code: 'FR', label: 'France', where: 'en France' },
  { code: 'CH', label: 'Suisse', where: 'en Suisse' },
  { code: 'BE', label: 'Belgique', where: 'en Belgique' },
  { code: 'CA', label: 'Canada', where: 'au Canada' },
  { code: 'LU', label: 'Luxembourg', where: 'au Luxembourg' },
];
export const DEFAULT_REGION = 'FR';

export function getRegion(): Region {
  const code = read(REGION_STORAGE_KEY);
  return REGIONS.find((r) => r.code === code) ?? REGIONS.find((r) => r.code === DEFAULT_REGION)!;
}
export const setRegion = (code: string): void => {
  if (REGIONS.some((r) => r.code === code)) write(REGION_STORAGE_KEY, code);
};
