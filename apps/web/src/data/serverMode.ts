import { signOut } from './auth';
import { getBase, getCustom, getMode, getSettings, isAndroidApp, PUBLIC_BASE, saveSettings, type ServerMode } from './config';
import { isLanHost } from './lan';
import { clearCache } from './transport';

/** Délai laissé au serveur Laststream au démarrage avant d'afficher l'écran de saisie. */
export const PUBLIC_PROBE_MS = 5000;
/** Délai laissé à une adresse locale enregistrée par l'ancien écran (hors de chez soi, elle ne répond pas). */
const LAN_PROBE_MS = 3000;

export interface ServerContext {
  /** Application Android (Capacitor). */
  native: boolean;
  /** Origine de la page quand elle est servie par lastAddon (app Windows, version web hébergée), sinon null. */
  servedOrigin: string | null;
}

let servedOrigin: string | null = null;
/** Appelé au démarrage quand la page est servie par lastAddon lui-même. */
export function setServedOrigin(origin: string | null): void {
  servedOrigin = origin;
}
export const getServedOrigin = (): string | null => servedOrigin;

let relaunch = (): void => location.reload();
/** Relance l'application après un changement de serveur (injectable en test). */
export function setRelaunch(fn: () => void): void {
  relaunch = fn;
}

export const currentContext = (): ServerContext => ({ native: isAndroidApp(), servedOrigin });

/** Le choix Laststream / perso a un sens : application Android ou page servie par lastAddon. */
export const serverChoiceVisible = (ctx: ServerContext = currentContext()): boolean => ctx.native || ctx.servedOrigin !== null;

/** Adresse du serveur Laststream dans ce contexte : l'origine de la page servie par lastAddon, sinon le serveur public. */
export const laststreamBase = (ctx: ServerContext = currentContext()): string => ctx.servedOrigin ?? PUBLIC_BASE;

/**
 * Adresse effective : le serveur perso s'il est choisi ; sinon, page servie par lastAddon, son origine ; sinon,
 * Android, le serveur Laststream ; sinon (web hors lastAddon) l'adresse enregistrée, comme avant.
 */
export function effectiveBase(choice: { mode?: ServerMode; custom?: string; base: string }, ctx: ServerContext): string {
  if (choice.mode === 'custom' && choice.custom) return choice.custom;
  if (ctx.servedOrigin) return ctx.servedOrigin;
  if (ctx.native) return PUBLIC_BASE;
  return choice.base;
}

/** Vrai seulement si `{base}/health` répond { ok: true } (lastAddon, sur le PC ou en ligne). */
export async function probeHealth(base: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    // Une page HTML (fallback SPA) n'est pas lastAddon : seul { ok: true } compte.
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Adresse http du réseau local (le PC qui héberge lastAddon). */
export function isLocalHttpBase(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === 'http:' && isLanHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Au démarrage : fixe l'adresse effective. Renvoie false quand l'écran de saisie est nécessaire : Android, premier
 * lancement, et serveur Laststream injoignable.
 */
export async function prepareServer(): Promise<boolean> {
  const ctx = currentContext();
  if (ctx.native && getMode() === undefined) {
    // Ancienne version : adresse saisie à la main. Une adresse locale devient le serveur perso si elle répond,
    // sinon le serveur Laststream (changement de serveur : config et base remises à zéro) ; une adresse https reste perso.
    const legacy = getBase();
    if (!legacy) saveSettings({ mode: 'public' });
    else if (!isLocalHttpBase(legacy)) saveSettings({ mode: 'custom', custom: legacy });
    else if (await probeHealth(legacy, LAN_PROBE_MS)) saveSettings({ mode: 'custom', custom: legacy });
    else saveSettings({ mode: 'public', base: '', config: '' });
  }
  const s = getSettings();
  const next = effectiveBase(s, ctx);
  // Premier lancement sur Android : le serveur Laststream doit répondre, sinon l'écran de saisie s'affiche.
  if (ctx.native && next === PUBLIC_BASE && s.base === '' && !(await probeHealth(PUBLIC_BASE, PUBLIC_PROBE_MS))) return false;
  if (next !== s.base) saveSettings({ base: next });
  return true;
}

/**
 * Change le choix du serveur (`config` : la config chiffrée à enregistrer pour le nouveau serveur, sinon vide).
 * Si l'adresse effective change : déconnexion locale, cache vidé et application relancée, la config chiffrée
 * étant propre à chaque serveur. Renvoie true si le serveur a changé.
 */
export function switchServer(next: { mode: ServerMode; custom?: string }, config?: string): boolean {
  const custom = next.custom !== undefined ? next.custom : getCustom();
  const before = getBase();
  const base = effectiveBase({ mode: next.mode, custom, base: before }, currentContext());
  if (base === before) {
    saveSettings({ mode: next.mode, custom, ...(config !== undefined ? { config } : {}) });
    return false;
  }
  saveSettings({ mode: next.mode, custom, base, config: config ?? '' });
  clearCache();
  signOut(true).catch(() => undefined);
  relaunch();
  return true;
}
