import { getConfig, isConfigured } from './config';
import { CONFIG_SETTING_KEY, configForAccount, reconcileConfig } from './configSync';
import { sectionAllowed } from './kid';
import { applyPrefs, snapshotPrefs } from './prefsSync';
import { ServerUserStore, profileFromDto } from './serverUserStore';
import {
  clearSession, dropProfileToken, getSession, isLocalMode, saveProfileToken, setActiveProfile, setLocalMode,
  setSession, validProfileToken,
} from './session';
import * as api from './userApi';
import { authEvents, UserApiError, type ProfileDto, type ProfileInput } from './userApi';
import { LocalUserStore, setUserStore, type Profile } from './userStore';

/*
 * Orchestration des comptes : détection de l'API /user, connexion, choix du profil, bascule du `userStore`
 * (local ↔ serveur). Le stockage local reste le repli : serveur absent, injoignable, ou « continuer sans compte ».
 */

export type AuthStatus = 'local' | 'offline' | 'needs-login' | 'needs-profile' | 'ready';

export const auth = {
  status: 'local' as AuthStatus,
  username: '',
  profiles: [] as Profile[],
  profile: null as Profile | null,
};

let store: ServerUserStore | null = null;
const listeners = new Set<() => void>();
export const onAuthChange = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (): void => listeners.forEach((f) => f());

export const isServerMode = (): boolean => auth.status === 'ready' && auth.profile !== null;
/** Âge maximal du profil enfant actif, ou null pour un profil adulte / le mode local. */
export const kidMaxAge = (): number | null => (auth.profile && auth.profile.isKid ? auth.profile.kidMaxAge ?? 12 : null);
/** La section du catalogue enfant est-elle autorisée pour le profil actif ? (toujours vrai hors profil enfant) */
export const kidSection = (id: string): boolean => !isKidProfile() || sectionAllowed(auth.profile?.allowedCatalogs, id);
export const isKidProfile = (): boolean => kidMaxAge() !== null;

function useLocal(status: AuthStatus): AuthStatus {
  setUserStore(new LocalUserStore());
  store = null;
  auth.profile = null;
  auth.profiles = [];
  auth.status = status;
  emit();
  return status;
}

/** Détecte l'API utilisateur et restaure la session. À appeler une fois au démarrage, avant le premier rendu. */
export async function initAuth(): Promise<AuthStatus> {
  authEvents.onUnauthorized = () => { void signOut(true); };
  if (!isConfigured()) return useLocal('local');
  if (isLocalMode() && !getSession()) return useLocal('local');
  try {
    const { account } = await api.me(4000);
    auth.username = account.username;
  } catch (err) {
    if (err instanceof UserApiError && err.status === 401) {
      if (getSession()) clearSession();
      return isLocalMode() ? useLocal('local') : useLocal('needs-login');
    }
    if (err instanceof UserApiError && err.status === 404) return useLocal('local'); // serveur sans API /user
    return useLocal('offline');
  }
  return loadProfiles();
}

export async function loadProfiles(): Promise<AuthStatus> {
  try {
    const { profiles } = await api.listProfiles();
    auth.profiles = profiles.map(profileFromDto);
  } catch {
    return useLocal('offline');
  }
  const s = getSession();
  const saved = s?.profileId ? auth.profiles.find((p) => p.id === s.profileId) : undefined;
  if (saved && (!saved.hasPin || validProfileToken(saved.id))) {
    await activate(saved);
    return auth.status;
  }
  auth.status = 'needs-profile';
  emit();
  return auth.status;
}

async function activate(profile: Profile): Promise<void> {
  const next = new ServerUserStore(auth.profiles, profile);
  try {
    await next.hydrate();
    await migrateLocalLibrary(next, profile.id);
  } catch (err) {
    if (err instanceof UserApiError && err.status === 403) {
      // Jeton de profil expiré ou refusé : retour au choix du profil.
      dropProfileToken(profile.id);
      auth.status = 'needs-profile';
      emit();
      return;
    }
    // Serveur injoignable : cache vide, les écritures partiront quand il répondra.
  }
  store = next;
  setUserStore(next);
  auth.profile = profile;
  auth.status = 'ready';
  setActiveProfile(profile.id);
  await syncPrefsIn(profile.id);
  emit();
}

const MIGRATED_PREFIX = 'laststream.migrated.';

/** Première connexion : la bibliothèque locale rejoint le profil serveur (une seule fois par compte). */
async function migrateLocalLibrary(target: ServerUserStore, profileId: string): Promise<void> {
  const flag = MIGRATED_PREFIX + auth.username;
  try {
    if (globalThis.localStorage?.getItem(flag)) return;
  } catch {
    return;
  }
  const local = new LocalUserStore().getLibrary();
  for (const e of local) {
    if (!target.inLibrary(`${e.type}:${e.id}`)) await target.addToLibraryNow(e, profileId);
  }
  try {
    globalThis.localStorage?.setItem(flag, '1');
  } catch {
    // Stockage indisponible : la migration sera retentée (sans doublon).
  }
}

async function syncPrefsIn(profileId: string): Promise<void> {
  try {
    const { settings } = await api.getSettings(profileId);
    if (Object.keys(settings).length) applyPrefs(settings);
    else await api.putSettings(profileId, snapshotPrefs());
    const verdict = await reconcileConfig(settings);
    if (verdict === 'push') pushConfig(getConfig());
  } catch { /* Réglages locaux conservés. */ }
}

/** Envoie la config lastAddon chiffrée au profil actif (sans effet hors mode serveur ; erreurs ignorées). */
export function pushConfig(config: string): void {
  if (!isServerMode() || !auth.profile) return;
  const value = configForAccount(config);
  if (!value) return;
  api.putSettings(auth.profile.id, { [CONFIG_SETTING_KEY]: value }).catch(() => undefined);
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
/** Envoie les préférences locales au profil actif (anti-rebond). Sans effet hors mode serveur. */
export function pushPrefs(): void {
  if (!isServerMode() || !auth.profile) return;
  const id = auth.profile.id;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { api.putSettings(id, snapshotPrefs()).catch(() => undefined); }, 800);
}

// ---- Actions de l'interface ----
export async function signIn(username: string, password: string): Promise<AuthStatus> {
  const res = await api.login(username, password);
  setSession(res.token, res.expiresAt, username.trim().toLowerCase());
  auth.username = username.trim().toLowerCase();
  setLocalMode(false);
  return loadProfiles();
}

export async function signUp(username: string, password: string, bootstrapToken?: string): Promise<AuthStatus> {
  await api.register(username, password, bootstrapToken || undefined);
  return signIn(username, password);
}

export async function signOut(silent = false): Promise<void> {
  if (!silent) await api.logout().catch(() => undefined);
  clearSession();
  auth.username = '';
  useLocal('needs-login');
}

export function continueWithoutAccount(): void {
  setLocalMode(true);
  useLocal('local');
}

/** Ouvre un profil. Lève UserApiError('pin_required') s'il est verrouillé et qu'aucun jeton ne le déverrouille. */
export async function chooseProfile(id: string): Promise<void> {
  const p = auth.profiles.find((x) => x.id === id);
  if (!p) throw new UserApiError(404, 'profile_not_found');
  if (p.hasPin && !validProfileToken(id)) throw new UserApiError(403, 'pin_required');
  await activate(p);
}

export async function unlock(id: string, pin: string): Promise<void> {
  const t = await api.unlockProfile(id, pin);
  saveProfileToken(id, t);
}

export const hasValidToken = (id: string): boolean => validProfileToken(id) !== undefined;

export async function saveProfile(id: string | null, input: Partial<ProfileInput>): Promise<ProfileDto> {
  const dto = id
    ? await api.updateProfile(id, input)
    : await api.createProfile(input as ProfileInput);
  const { profiles } = await api.listProfiles();
  auth.profiles = profiles.map(profileFromDto);
  if (auth.profile) auth.profile = auth.profiles.find((p) => p.id === auth.profile!.id) ?? auth.profile;
  emit();
  return dto;
}

export async function removeProfile(id: string): Promise<void> {
  await api.deleteProfile(id);
  dropProfileToken(id);
  const { profiles } = await api.listProfiles();
  auth.profiles = profiles.map(profileFromDto);
  emit();
}

/** Quitter un profil enfant exige le PIN d'un profil adulte (s'il en existe un). */
export const adultsWithPin = (): Profile[] => auth.profiles.filter((p) => !p.isKid && p.hasPin);

export async function importFromStremio(email: string, password: string, config: string): Promise<Record<string, unknown>> {
  if (!auth.profile) throw new UserApiError(0, 'no_profile');
  const res = await api.importStremio(auth.profile.id, email, password, config || undefined);
  await store?.hydrate();
  return res;
}
