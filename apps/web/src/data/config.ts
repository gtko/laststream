import { Capacitor } from '@capacitor/core';
import { LastAddonError } from './errors';
import { cleartextAllowed } from './lan';

/**
 * Réglages lastAddon : même clé localStorage que l'application précédente (même origine), pour récupérer
 * telle quelle la configuration déjà saisie. `config` est la chaîne chiffrée renvoyée par POST /config/encode.
 */
export const SETTINGS_STORAGE_KEY = 'laststream.lastaddon';
export const DEFAULT_BASE = 'http://localhost:7000';
/** Serveur public de lastAddon : adresse par défaut de l'application Android (une seule modification à faire ici). */
export const PUBLIC_BASE = 'https://laststream.gtux-prog.workers.dev';

/** Choix du serveur (Android et pages servies par lastAddon) : Laststream par défaut, ou un serveur perso. */
export type ServerMode = 'public' | 'custom';

export interface LastAddonSettings {
  /** Adresse effective utilisée par les requêtes (calculée selon le choix et la plateforme). */
  base: string;
  config: string;
  /** Absent tant que le choix n'a pas été fait (anciennes installations). */
  mode?: ServerMode;
  /** Adresse du serveur perso, gardée même quand le mode est 'public'. */
  custom?: string;
}

export type QueryValue = string | number | boolean | null | undefined;

const EMPTY: LastAddonSettings = { base: '', config: '' };

function readSettings(): LastAddonSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<LastAddonSettings> | null;
    const stored = typeof parsed?.base === 'string' ? parsed.base : '';
    // Android : une adresse http stockée hors réseau local est écartée au démarrage.
    const base = isAndroidApp() && stored && !cleartextAllowed(stored) ? '' : stored;
    const mode = parsed?.mode === 'public' || parsed?.mode === 'custom' ? parsed.mode : undefined;
    return {
      base,
      config: typeof parsed?.config === 'string' ? parsed.config : '',
      ...(mode ? { mode } : {}),
      custom: typeof parsed?.custom === 'string' ? parsed.custom : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeSettings(settings: LastAddonSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Stockage indisponible : le réglage reste valable en mémoire.
  }
}

let settings: LastAddonSettings = readSettings();
const listeners = new Set<() => void>();

/** Relit le stockage (utile aux tests et après une écriture externe). */
export function reloadSettings(): LastAddonSettings {
  settings = readSettings();
  return settings;
}

/** Application native (Capacitor) : pas de navigateur, serveur lastAddon sur le réseau local. */
export function isAndroidApp(): boolean {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

export function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LastAddonError('invalid_base', 'Adresse lastAddon invalide.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LastAddonError('invalid_base', 'L’adresse lastAddon doit commencer par http ou https.');
  }
  // Application Android : le http en clair n'est permis que vers le réseau local (le PC qui héberge lastAddon).
  if (isAndroidApp() && !cleartextAllowed(trimmed)) {
    throw new LastAddonError('invalid_base', 'En http, l’adresse doit être celle d’un appareil de ton réseau local (par exemple http://192.168.1.20:7000). Sinon utilise https.');
  }
  return trimmed;
}

export const getBase = (): string => settings.base;
export const getConfig = (): string => settings.config;
export const getSettings = (): LastAddonSettings => ({ ...settings });
export const getMode = (): ServerMode | undefined => settings.mode;
export const getCustom = (): string => settings.custom ?? '';
export const isConfigured = (): boolean => settings.base !== '' && settings.config !== '';

/** Enregistre {base, config} dans la clé historique. */
export function saveSettings(next: Partial<LastAddonSettings>): void {
  const merged: LastAddonSettings = {
    base: next.base !== undefined ? normalizeBase(next.base) : settings.base,
    config: next.config !== undefined ? next.config.trim() : settings.config,
    ...(next.mode !== undefined ? { mode: next.mode } : settings.mode ? { mode: settings.mode } : {}),
    custom: next.custom !== undefined ? (next.custom.trim() ? normalizeBase(next.custom) : '') : (settings.custom ?? ''),
  };
  settings = merged;
  writeSettings(merged);
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requireBase(): string {
  if (settings.base === '') throw new LastAddonError('not_configured', 'lastAddon n’est pas configuré.');
  return settings.base;
}

const encodePath = (path: string): string =>
  path.split('/').filter((s) => s !== '').map((s) => encodeURIComponent(s)).join('/');

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  Object.keys(query).forEach((key) => {
    const value = query[key];
    if (value !== undefined && value !== null) params.append(key, String(value));
  });
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

/** URL d'une route lt : `{base}/{config}/lt/<path>`. Lève not_configured si base ou config manquent. */
export function ltUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!isConfigured()) throw new LastAddonError('not_configured', 'lastAddon n’est pas configuré.');
  return `${settings.base}/${encodeURIComponent(settings.config)}/lt/${encodePath(path)}${buildQuery(query)}`;
}

/** URL d'une route Stremio de l'addon : `{base}/{config}/<path>` (ex. stream/movie/tt123.json). */
export function addonUrl(path: string): string {
  if (!isConfigured()) throw new LastAddonError('not_configured', 'lastAddon n’est pas configuré.');
  return `${settings.base}/${encodeURIComponent(settings.config)}/${path.replace(/^\/+/, '')}`;
}
