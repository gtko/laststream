import { DEFAULT_BASE, getBase, getConfig, getSettings, isAndroidApp, PUBLIC_BASE, saveSettings } from './config';
import { encodeConfig } from './configApi';

/*
 * Synchronisation de la config lastAddon chiffrée avec le compte (réglages du profil, clé `lastaddonConfig`).
 * La chaîne est chiffrée côté serveur : elle ne contient aucun secret en clair.
 */

export const CONFIG_SETTING_KEY = 'lastaddonConfig';
/** Compte (nom d'utilisateur) à qui appartient la config lastAddon gardée dans ce navigateur. */
export const CONFIG_OWNER_KEY = 'laststream.configOwner';
/** Caches locaux liés à un compte (filtres d'accueil, recommandations) : effacés à la déconnexion. */
const ACCOUNT_CACHE_PREFIXES = ['laststream.homeFilters.', 'laststream.aiRecs.'];
const MAX_VALUE_BYTES = 4096;

/** Valeur à envoyer au profil, ou null si la config est vide ou trop volumineuse pour le serveur. */
export function configForAccount(config: string): string | null {
  const c = config.trim();
  if (!c) return null;
  return new TextEncoder().encode(c).length <= MAX_VALUE_BYTES ? c : null;
}

/** Vrai si la page est servie par lastAddon lui-même (GET /health sur l'origine courante). */
export async function servedByLastAddon(timeoutMs = 2500): Promise<boolean> {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return false;
  // Dans l'app Android (Capacitor), http://localhost sert l'app embarquée : ce n'est jamais lastAddon.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${location.origin}/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    // Un serveur statique renvoie index.html (fallback SPA) : seul lastAddon répond { ok: true } en JSON.
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compte neuf (ou navigateur vierge) : génère la config par défaut (langue fr, aucun addon ; les clés de services
 * viennent du serveur) en chiffrant une config vide côté serveur. Renvoie true si une config locale existe ensuite.
 */
export async function ensureDefaultConfig(): Promise<boolean> {
  if (getConfig()) return true;
  if (!getBase()) return false;
  try {
    saveSettings({ config: await encodeConfig({}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * À la connexion : la config du compte fait foi (remplace une config locale différente) ; sans config locale, la reprend (base = origine courante quand la page
 * est servie par lastAddon). Renvoie 'pulled' si la config locale a été remplie, 'push' si le compte n'a
 * rien et qu'une config locale peut être envoyée, sinon 'none'.
 */
export async function reconcileConfig(
  accountSettings: Record<string, unknown>,
): Promise<'pulled' | 'push' | 'none'> {
  const remote = accountSettings[CONFIG_SETTING_KEY];
  const local = getSettings();
  if (local.config) {
    if (typeof remote !== 'string' || !remote.trim()) return configForAccount(local.config) ? 'push' : 'none';
    // Le compte fait foi (chaque enregistrement y est envoyé) : une config locale différente, périmée ou incomplète,
    // est remplacée par celle du compte.
    if (remote.trim() === local.config.trim()) return 'none';
    saveSettings({ config: remote.trim() });
    return 'pulled';
  }
  if (typeof remote !== 'string' || !remote.trim()) {
    // Ni config locale ni config de compte : compte neuf, on génère la config par défaut et on l'envoie au compte.
    return (await ensureDefaultConfig()) && configForAccount(getConfig()) ? 'push' : 'none';
  }
  // Serveur perso choisi : son adresse. Sinon origine de la page servie par lastAddon, puis serveur Laststream sur Android.
  const base = local.mode === 'custom' && local.custom
    ? local.custom
    : (await servedByLastAddon()) ? location.origin : local.base || (isAndroidApp() ? PUBLIC_BASE : DEFAULT_BASE);
  saveSettings({ base, config: remote });
  return 'pulled';
}

export function getConfigOwner(): string {
  try { return globalThis.localStorage?.getItem(CONFIG_OWNER_KEY) ?? ''; } catch { return ''; }
}

function setConfigOwner(username: string): void {
  try {
    if (username) globalThis.localStorage?.setItem(CONFIG_OWNER_KEY, username);
    else globalThis.localStorage?.removeItem(CONFIG_OWNER_KEY);
  } catch { /* stockage indisponible */ }
}

/**
 * Déconnexion : la config locale (URL d'addons, donc clés de débrideur) est effacée avec les caches du compte ; l'adresse
 * du serveur reste. La reconnexion du même compte la récupère depuis le serveur.
 */
export function clearLocalAccountData(): void {
  saveSettings({ config: '' });
  setConfigOwner('');
  try {
    const s = globalThis.localStorage;
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const k = s.key(i);
      if (k && ACCOUNT_CACHE_PREFIXES.some((p) => k.startsWith(p))) s.removeItem(k);
    }
  } catch { /* stockage indisponible */ }
}

/**
 * Connexion de `username` : la config locale n'est conservée que si elle appartient à ce compte. Sans propriétaire
 * mémorisé, elle n'est reprise que si `adoptUnowned` (session restaurée d'une installation antérieure au suivi du
 * propriétaire). Sinon elle est vidée : le compte prend sa config sur le serveur, ou démarre avec la config par défaut.
 */
export function claimLocalConfig(username: string, adoptUnowned = false): void {
  const owner = getConfigOwner();
  if (owner !== username && !(owner === '' && adoptUnowned)) saveSettings({ config: '' });
  setConfigOwner(username);
}
