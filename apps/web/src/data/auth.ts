import { getBase, getConfig, PUBLIC_BASE, saveSettings } from './config';
import { clearElevation } from './adminApi';
import { emitDataEvent } from './events';
import { applyAccountFilters, loadServerHidden, setFiltersPusher, setHiddenBackend } from './homeFilters';
import { apiHiddenBackend } from './hiddenApi';
import { startPresenceV2, stopPresenceV2 } from '../player/presenceV2';
import { claimLocalConfig, clearLocalAccountData, CONFIG_SETTING_KEY, configForAccount, reconcileConfig } from './configSync';
import { sectionAllowed } from './kid';
import { applyPrefs, snapshotPrefs } from './prefsSync';
import { ServerUserStore, profileFromDto } from './serverUserStore';
import {
  clearLegacyLocalMode, clearSession, dropProfileToken, getSession, saveProfileToken, setActiveProfile,
  setSession, validProfileToken,
} from './session';
import { dropSyncedLists, pushTvSources, reconcileTvSources, refreshAll, setTvSourcesPusher } from './tvSources';
import * as api from './userApi';
import { authEvents, UserApiError, type ProfileDto, type ProfileInput } from './userApi';
import { LocalUserStore, setUserStore, type Profile } from './userStore';

/*
 * Orchestration des comptes : détection de l'API /user, connexion, choix du profil, bascule du `userStore`
 * (local ↔ serveur). Sans compte, l'app ne s'ouvre pas : la connexion est obligatoire. Le stockage local reste le repli
 * d'un serveur sans API /user, de la page d'invitation anonyme et d'un serveur injoignable pendant une session existante.
 */

export type AuthStatus = 'local' | 'offline' | 'needs-login' | 'needs-profile' | 'ready';

export const auth = {
  status: 'local' as AuthStatus,
  username: '',
  /** Identifiant opaque du compte, pour la supervision seulement (Sentry) : jamais le pseudo. */
  accountId: '',
  /** Propriétaire du serveur (peut régler les quotas d'invitation). */
  isOwner: false,
  /** Session verrouillée sur un profil invité au foyer (`lockedProfileId` de /user/me) : pas de sélecteur de profils. */
  locked: false,
  profiles: [] as Profile[],
  profile: null as Profile | null,
};

/** La session est verrouillée sur un profil (invitation au foyer) : l'interface masque la gestion des profils et du compte. */
export const isProfileLocked = (): boolean => auth.locked;

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
/** Le compte connecté est le propriétaire du serveur (role === 'owner'). */
export const isOwner = (): boolean => auth.isOwner;
/**
 * Profil principal du compte : seul à voir Sources, Serveur lastAddon et les clés. Hors mode serveur (repli local) : toujours ;
 * serveur ancien qui n'annonce rien : traité comme principal. Les profils secondaires et enfants n'ont que leurs préférences.
 */
export const isMainProfile = (): boolean => !isServerMode() || auth.profile?.isMainProfile !== false;
/** Profil administrateur du serveur : le seul à voir et ouvrir l'administration (pas le conjoint, pas les enfants). */
export const isAdminProfile = (): boolean => auth.profile?.isAdminProfile === true;
/**
 * Profil principal adulte du compte : son PIN sert de code parental (quitter un profil enfant, gérer les profils).
 * Null hors mode serveur ou si le serveur n'annonce rien.
 */
export const parentalProfile = (): Profile | null => auth.profiles.find((p) => p.isMainProfile === true && !p.isKid) ?? null;
/** Profil enfant actif ET code parental défini : en sortir exige ce code. */
export const parentalLockActive = (): boolean => isKidProfile() && parentalProfile()?.hasPin === true;
/** Il existe un profil enfant mais le principal n'a pas de code parental (à définir). */
export const parentalCodeMissing = (): boolean => !!parentalProfile() && parentalProfile()?.hasPin !== true && auth.profiles.some((p) => p.isKid);

/** Profil principal reconnu par son code dans l'écran « Qui regarde ? » (aucun profil actif, ou sortie d'un profil enfant). */
let managerId: string | null = null;
export const grantManager = (id: string | null): void => { managerId = id; };
/** Gérer les profils (créer, modifier, supprimer) : profil principal adulte actif, ou principal reconnu par son code. */
export const canManageProfiles = (): boolean =>
  !auth.locked && (auth.profiles.length === 0 || managerId !== null || (isServerMode() && !isKidProfile() && isMainProfile()));
/** Profil qui agit pour la gestion (en-tête X-Profile-Id), ou undefined pour le tout premier profil. */
const managerActor = (): string | undefined => {
  if (managerId) return managerId;
  if (isServerMode() && !isKidProfile() && auth.profile) return auth.profile.id;
  return undefined;
};
/** Profil adulte qui gère les profils (en-tête X-Profile-Id), ou null. Peut différer du profil actif après une sortie de profil enfant. */
export const managingProfileId = (): string | null => managerActor() ?? null;

/** Accès à la console #/admin : propriétaire, session serveur active, profil adulte désigné administrateur. */
export const canAdmin = (): boolean => isServerMode() && auth.isOwner && !isKidProfile() && isAdminProfile();

function useLocal(status: AuthStatus): AuthStatus {
  setUserStore(new LocalUserStore());
  store = null;
  setHiddenBackend(null);
  stopPresenceV2();
  auth.profile = null;
  auth.profiles = [];
  auth.status = status;
  emit();
  return status;
}

/**
 * Serveur injoignable sans session : l'app ne s'ouvre pas en local, l'écran de connexion demande de réessayer.
 * Avec une session, le repli local reste utilisé (statut 'offline').
 */
export const offlineWithoutSession = (): boolean => auth.status === 'offline' && getSession() === null;

/**
 * Détecte l'API utilisateur et restaure la session. À appeler une fois au démarrage, avant le premier rendu.
 * `anonymous` : page d'invitation sans compte, qui n'appelle pas `/user/me` (l'invité n'a pas de compte : réponse 401).
 */
export async function initAuth(opts: { anonymous?: boolean } = {}): Promise<AuthStatus> {
  authEvents.onUnauthorized = () => { void signOut(true); };
  clearLegacyLocalMode(); // installations qui avaient choisi « continuer sans compte » : connexion obligatoire
  if (opts.anonymous) return useLocal('local');
  // Aucune adresse enregistrée (premier lancement hors lastAddon) : le serveur Laststream par défaut, pour afficher l'écran
  // de connexion au lieu du mode local. Seule l'adresse est nécessaire (la config est générée ensuite pour un compte neuf).
  // Serveur injoignable : /user/me échoue et le statut reste 'offline'.
  if (!getBase()) saveSettings({ base: PUBLIC_BASE, mode: 'public' });
  let lockedId: string | null;
  try {
    const me = await api.me(4000);
    const account = me.account;
    lockedId = me.lockedProfileId ?? null;
    auth.username = account.username;
    auth.accountId = account.id;
    // Session verrouillée : jamais les droits de propriétaire du compte.
    auth.isOwner = !lockedId && (account.role ? account.role === 'owner' : !!(account.isAdmin || account.isOwner));
    // Session restaurée : la config locale n'est gardée que si elle appartient à ce compte.
    claimLocalConfig(account.username, true);
  } catch (err) {
    if (err instanceof UserApiError && err.status === 401) {
      if (getSession()) clearSession();
      return useLocal('needs-login');
    }
    if (err instanceof UserApiError && err.status === 404) return useLocal('local'); // serveur sans API /user
    return useLocal('offline');
  }
  return loadProfiles(lockedId);
}

/** Profil verrouillé de la session courante (`lockedProfileId` de /user/me), ou null. Une erreur réseau compte comme non verrouillée. */
async function readLockedProfile(): Promise<string | null> {
  try {
    return (await api.me(4000)).lockedProfileId ?? null;
  } catch {
    return null;
  }
}

/**
 * Charge les profils puis choisit le profil actif. `known` : profil verrouillé déjà lu (`undefined` : lu ici via /user/me).
 * Session verrouillée : ce profil est activé directement, jamais le sélecteur « Qui regarde ? ».
 */
export async function loadProfiles(known?: string | null): Promise<AuthStatus> {
  try {
    const { profiles } = await api.listProfiles();
    auth.profiles = profiles.map(profileFromDto);
  } catch {
    return useLocal('offline');
  }
  const lockedId = known !== undefined ? known : await readLockedProfile();
  auth.locked = lockedId !== null;
  if (lockedId !== null) {
    const locked = auth.profiles.find((p) => p.id === lockedId);
    if (!locked) {
      // Profil verrouillé supprimé entre-temps : la session n'a plus de profil à ouvrir.
      clearSession();
      auth.locked = false;
      return useLocal('needs-login');
    }
    await activate(locked);
    return auth.status;
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
  setHiddenBackend(apiHiddenBackend);
  await syncPrefsIn(profile.id);
  startPresenceV2(!!profile.isKid);
  managerId = null;
  // Profil enfant : les jetons des profils adultes sont retirés, sortir de ce profil redemande le code parental.
  if (profile.isKid) auth.profiles.forEach((p) => { if (p.id !== profile.id) dropProfileToken(p.id); });
  emit();
  emitDataEvent({ kind: 'profile' });
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
  // Titres masqués d'abord : le premier accès fait importer les anciens morceaux `homeHidden*` par le serveur, qui les
  // retire des réglages lus juste après.
  await loadServerHidden(profileId);
  try {
    const { settings } = await api.getSettings(profileId);
    if (Object.keys(settings).length) applyPrefs(settings);
    else await api.putSettings(profileId, snapshotPrefs());
    applyAccountFilters(profileId, settings); // titres masqués, genres bannis, séries vues en entier (par profil)
  } catch { /* Réglages locaux conservés. */ }
  try {
    // La config (sources, extensions, clés) est celle du compte : tout profil la lit, même enfant, sans PIN du principal.
    // Seul le principal la modifie. Réseau coupé : config locale conservée.
    const { config } = await api.getAccountConfig(profileId);
    const verdict = await reconcileConfig(config ? { [CONFIG_SETTING_KEY]: config } : {});
    if (verdict === 'push' && isMainProfile()) pushConfig(getConfig());
  } catch { /* Config locale conservée. */ }
  try {
    // Playlists TV du compte (chiffrées côté serveur, rendues en clair à ce compte seulement) : tout profil les lit, le principal les écrit.
    // L'appareil télécharge lui-même playlists et guides ; le serveur ne les lit jamais.
    const { lists } = await api.getTvSources(profileId);
    const verdict = reconcileTvSources(lists);
    if (verdict === 'push' && isMainProfile()) pushTvSources();
    void refreshAll();
  } catch { /* Playlists locales conservées. */ }
}

// Playlists TV synchronisées : le profil principal les envoie au compte à chaque modification (hors mode serveur, rien).
setTvSourcesPusher((wire) => {
  if (!isServerMode() || !auth.profile || !isMainProfile()) return;
  api.putTvSources(auth.profile.id, wire).catch(() => undefined);
});

/** Envoie la config lastAddon chiffrée au compte, depuis le profil principal actif (sans effet hors mode serveur ; erreurs ignorées). */
export function pushConfig(config: string): void {
  if (!isServerMode() || !auth.profile || !isMainProfile()) return;
  const value = configForAccount(config);
  if (!value) return;
  api.putAccountConfig(auth.profile.id, value).catch(() => undefined);
}

// Filtres d'accueil par profil : chaque changement part vers les réglages du profil (hors mode serveur, rien).
setFiltersPusher((profileId, settings) => {
  if (!isServerMode()) return false;
  return api.putSettings(profileId, settings).then(() => true, () => false);
});

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
  const name = username.trim().toLowerCase();
  setSession(res.token, res.expiresAt, name);
  auth.username = name;
  // /login ne renvoie pas l'identifiant de compte : on le lit comme au démarrage (supervision seulement, sans attendre).
  // Ignorée si la session a changé entre-temps (déconnexion ou autre compte) : jamais le compte d'un autre.
  api.me(4000).then(({ account }) => { if (auth.username === name) auth.accountId = account.id; }).catch(() => undefined);
  // Un autre compte ne réutilise jamais la config locale (URL d'addons, clés) d'un compte précédent.
  claimLocalConfig(name);
  return loadProfiles();
}

export async function signUp(username: string, password: string, bootstrapToken?: string, invite?: string, autoFriend?: boolean): Promise<AuthStatus> {
  await api.register(username, password, bootstrapToken || undefined, invite || undefined, autoFriend);
  return signIn(username, password);
}

/**
 * Session renvoyée par la validation d'une invitation au foyer (`redeemHouseholdInvite`) : enregistrée comme après `signIn`,
 * puis l'app démarre sur le profil invité (session verrouillée). Le pseudo est celui du compte (lu via /user/me) : la réponse
 * de redeem ne le donne pas, et l'identifiant saisi par l'invité est celui du profil.
 */
export async function adoptSession(s: { token: string; expiresAt: string; profileId: string }): Promise<AuthStatus> {
  // Le jeton doit être en place avant /user/me (lecture du compte) ; le pseudo n'est connu qu'après cette lecture.
  setSession(s.token, s.expiresAt, '');
  let username = '';
  let accountId = '';
  let lockedId = s.profileId;
  try {
    const me = await api.me(4000);
    username = me.account.username;
    accountId = me.account.id;
    lockedId = me.lockedProfileId ?? s.profileId;
  } catch {
    // Compte illisible : pseudo vide, et la config locale n'est pas reprise (claimLocalConfig ci-dessous).
  }
  try {
    setSession(s.token, s.expiresAt, username);
    auth.username = username;
    auth.accountId = accountId;
    auth.isOwner = false; // session verrouillée : jamais les droits de propriétaire
    claimLocalConfig(username);
    const status = await loadProfiles(lockedId);
    if (status !== 'ready') throw new Error('adoptSession : session non ouverte (' + status + ')');
    return status;
  } catch (err) {
    // Le lien est déjà consommé : une session à moitié ouverte ne reste pas en place.
    clearSession();
    throw err;
  }
}

export async function signOut(silent = false): Promise<void> {
  if (!silent) await api.logout().catch(() => undefined);
  clearSession();
  clearElevation();
  clearLocalAccountData();
  dropSyncedLists();
  managerId = null;
  auth.isOwner = false;
  auth.locked = false;
  auth.username = '';
  auth.accountId = '';
  useLocal('needs-login');
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
  const actor = managerActor();
  const dto = id
    ? await api.updateProfile(id, input, actor)
    : await api.createProfile(input as ProfileInput, actor);
  const { profiles } = await api.listProfiles();
  auth.profiles = profiles.map(profileFromDto);
  if (auth.profile) auth.profile = auth.profiles.find((p) => p.id === auth.profile!.id) ?? auth.profile;
  emit();
  return dto;
}

export async function removeProfile(id: string): Promise<void> {
  await api.deleteProfile(id, managerActor());
  dropProfileToken(id);
  const { profiles } = await api.listProfiles();
  auth.profiles = profiles.map(profileFromDto);
  emit();
}

/** Code parental : le PIN du profil principal (vérifié par le serveur, 5 essais puis blocage de 5 minutes). */
export const adultsWithPin = (): Profile[] => { const m = parentalProfile(); return m && m.hasPin ? [m] : []; };

export async function importFromStremio(email: string, password: string, config: string): Promise<Record<string, unknown>> {
  if (!auth.profile) throw new UserApiError(0, 'no_profile');
  const res = await api.importStremio(auth.profile.id, email, password, config || undefined);
  await store?.hydrate();
  return res;
}

/**
 * Relit le compte (bibliothèque et « Reprendre la lecture » du profil actif) : changements faits sur un autre appareil ou
 * profil. Sans effet hors mode serveur. Les erreurs réseau remontent à l'appelant.
 */
export async function refreshRemote(): Promise<void> {
  if (!store || !isServerMode()) return;
  await store.refresh();
}
