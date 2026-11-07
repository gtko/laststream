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
const AUTOPLAY_STORAGE_KEY = 'laststream.autoplay';
/** Activée par défaut : seule la valeur '0' la désactive. */
export const getAutoplay = (): boolean => read(AUTOPLAY_STORAGE_KEY) !== '0';
export const setAutoplay = (enabled: boolean): void => write(AUTOPLAY_STORAGE_KEY, enabled ? '1' : '0');

// ---- Mise à jour de l'interface (locale à l'appareil, hors synchronisation du compte) ----
const UI_UPDATE_NOTIFY_KEY = 'laststream.uiupdate.notify';
const UI_UPDATE_AUTO_KEY = 'laststream.uiupdate.auto';
/** Prévenir d'une nouvelle version : activé par défaut, seule la valeur '0' le désactive. */
export const getUiUpdateNotify = (): boolean => read(UI_UPDATE_NOTIFY_KEY) !== '0';
export const setUiUpdateNotify = (enabled: boolean): void => write(UI_UPDATE_NOTIFY_KEY, enabled ? '1' : '0');
/** Mise à jour automatique quand l'application est inactive : désactivée par défaut, seule la valeur '1' l'active. */
export const getUiUpdateAuto = (): boolean => read(UI_UPDATE_AUTO_KEY) === '1';
export const setUiUpdateAuto = (enabled: boolean): void => write(UI_UPDATE_AUTO_KEY, enabled ? '1' : '0');

// ---- Débit ----
const BANDWIDTH_SETTING_KEY = 'laststream.bandwidth.setting';
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

// ---- Résolution maximale (ODY-236) ----
const RESOLUTION_CAP_KEY = 'laststream.maxResolution';
/** Plafond de résolution de la source choisie d'office (lecture et téléchargement) ; `auto` : déduit de l'écran. */
export type ResolutionCap = 'auto' | '720p' | '1080p' | '1440p' | '2160p';
export const RESOLUTION_CAPS: readonly ResolutionCap[] = ['auto', '720p', '1080p', '1440p', '2160p'];
/** Par appareil : l'écran et la connexion changent d'un appareil à l'autre. */
export function getResolutionCap(): ResolutionCap {
  const raw = read(RESOLUTION_CAP_KEY);
  return RESOLUTION_CAPS.find((c) => c === raw) ?? 'auto';
}
export const setResolutionCap = (value: ResolutionCap): void => write(RESOLUTION_CAP_KEY, value);

// ---- Sauts automatiques (intro, récap, épisode suivant, épisodes filler d'anime) ----
export type SkipPrefName = 'intro' | 'recap' | 'nextEpisode' | 'filler';
const SKIP_PREF_DEFAULTS: Readonly<Record<SkipPrefName, boolean>> = { intro: false, recap: false, nextEpisode: true, filler: false };
const skipPrefKey = (name: SkipPrefName): string => `laststream.skip.${name}`;
export function getSkipPref(name: SkipPrefName): boolean {
  const raw = read(skipPrefKey(name));
  return raw === null ? SKIP_PREF_DEFAULTS[name] : raw === '1';
}
export const setSkipPref = (name: SkipPrefName, enabled: boolean): void => write(skipPrefKey(name), enabled ? '1' : '0');

// ---- Lancer la lecture après la bande-annonce (fiche) ----
const TRAILER_AUTOPLAY_KEY = 'laststream.trailerAutoplay';
/** Réglage explicite, ou undefined tant qu'il n'a jamais été réglé (le défaut dépend du profil : voir getTrailerAutoplay). */
export const getTrailerAutoplayStored = (): boolean | undefined => {
  const raw = read(TRAILER_AUTOPLAY_KEY);
  return raw === null ? undefined : raw === '1';
};
export const setTrailerAutoplay = (enabled: boolean): void => write(TRAILER_AUTOPLAY_KEY, enabled ? '1' : '0');
export const clearTrailerAutoplay = (): void => {
  try { globalThis.localStorage?.removeItem(TRAILER_AUTOPLAY_KEY); } catch { /* ignoré */ }
};
/** Activé par défaut ; désactivé par défaut pour les profils enfants (`kid`), sauf réglage explicite. */
export const getTrailerAutoplay = (kid: boolean): boolean => {
  const stored = getTrailerAutoplayStored();
  return stored === undefined ? !kid : stored;
};

// ---- Région (watch_region, region, classification) ----
const REGION_STORAGE_KEY = 'laststream.region';
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
const DEFAULT_REGION = 'FR';

export function getRegion(): Region {
  const code = read(REGION_STORAGE_KEY);
  return REGIONS.find((r) => r.code === code) ?? REGIONS.find((r) => r.code === DEFAULT_REGION)!;
}
export const setRegion = (code: string): void => {
  if (REGIONS.some((r) => r.code === code)) write(REGION_STORAGE_KEY, code);
};

// ---- Langue des bandes-annonces et des textes TMDB ----
const VIDEO_LANG_KEY = 'laststream.videolang';
export const VIDEO_LANGS: ReadonlyArray<readonly [string, string]> = [
  ['fr', 'Français'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['it', 'Italiano'],
];
export interface VideoLang {
  /** Code ISO 639-1 (fr). */
  lang: string;
  /** Étiquette TMDB `language` (fr-FR, fr-CA…). */
  tag: string;
  /** Pays de la variante régionale recherchée (FR, CA…). */
  country: string;
}

/** Langue choisie dans les réglages ; « automatique » = langue de la région (FR, BE, LU, CH, CA : français). */
export function getVideoLang(): VideoLang {
  const region = getRegion().code;
  const chosen = read(VIDEO_LANG_KEY);
  const lang = VIDEO_LANGS.some(([c]) => c === chosen) ? (chosen as string) : 'fr';
  const country = lang === 'fr' ? (region === 'CA' ? 'CA' : 'FR') : ({ en: 'US', es: 'ES', de: 'DE', it: 'IT' } as Record<string, string>)[lang];
  return { lang, tag: `${lang}-${country}`, country };
}
export const setVideoLang = (code: string): void => {
  if (code === 'auto') {
    try { globalThis.localStorage?.removeItem(VIDEO_LANG_KEY); } catch { /* ignoré */ }
  } else if (VIDEO_LANGS.some(([c]) => c === code)) write(VIDEO_LANG_KEY, code);
};
export const getVideoLangSetting = (): string => {
  const v = read(VIDEO_LANG_KEY);
  return VIDEO_LANGS.some(([c]) => c === v) ? (v as string) : 'auto';
};

// ---- Lecteur externe (par appareil : un téléphone n'a pas les mêmes applis qu'un PC ; hors synchronisation du compte) ----
const EXTERNAL_PLAYER_KEY = 'laststream.externalPlayer';
const PREFERRED_EXTERNAL_KEY = 'laststream.preferredExternal';
/** Lecteur externe choisi sur cet appareil ; vide tant qu'il n'a jamais été réglé (voir currentPlayer). */
export const getExternalPlayer = (): string => read(EXTERNAL_PLAYER_KEY) ?? '';
export const setExternalPlayer = (id: string): void => write(EXTERNAL_PLAYER_KEY, id);
/** Lecteur externe préféré de cet appareil : VLC par défaut. */
export const getPreferredExternal = (): string => read(PREFERRED_EXTERNAL_KEY) || 'vlc';
export const setPreferredExternal = (id: string): void => write(PREFERRED_EXTERNAL_KEY, id);

// ---- Moteur de lecture de la coque Windows (par appareil) : mpv, libVLC intégré, ou automatique (mpv, puis libVLC si mpv échoue) ----
const DESKTOP_ENGINE_KEY = 'laststream.desktopEngine';
export type DesktopEngine = 'auto' | 'mpv' | 'libvlc';
/** Moteur choisi sur cet appareil ; « auto » tant qu'il n'a jamais été réglé. */
export const getDesktopEngine = (): DesktopEngine => {
  const v = read(DESKTOP_ENGINE_KEY);
  return v === 'mpv' || v === 'libvlc' ? v : 'auto';
};
export const setDesktopEngine = (engine: DesktopEngine): void => write(DESKTOP_ENGINE_KEY, engine === 'mpv' || engine === 'libvlc' ? engine : 'auto');
