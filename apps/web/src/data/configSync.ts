import { DEFAULT_BASE, getSettings, isAndroidApp, PUBLIC_BASE, saveSettings } from './config';

/*
 * Synchronisation de la config lastAddon chiffrée avec le compte (réglages du profil, clé `lastaddonConfig`).
 * La chaîne est chiffrée côté serveur : elle ne contient aucun secret en clair.
 */

export const CONFIG_SETTING_KEY = 'lastaddonConfig';
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
  if (typeof remote !== 'string' || !remote.trim()) return 'none';
  // Serveur perso choisi : son adresse. Sinon origine de la page servie par lastAddon, puis serveur Laststream sur Android.
  const base = local.mode === 'custom' && local.custom
    ? local.custom
    : (await servedByLastAddon()) ? location.origin : local.base || (isAndroidApp() ? PUBLIC_BASE : DEFAULT_BASE);
  saveSettings({ base, config: remote });
  return 'pulled';
}
