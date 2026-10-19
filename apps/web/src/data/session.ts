/** Session de compte lastAddon (API /user) : jeton de session, profil actif et jetons de profil (PIN). */
export const SESSION_KEY = 'laststream.session';
/** Ancien choix « continuer sans compte » (versions précédentes) : plus utilisé, effacé au démarrage. */
export const LEGACY_LOCAL_MODE_KEY = 'laststream.localmode';

export interface ProfileToken {
  token: string;
  expiresAt: string;
}

export interface StoredSession {
  token: string;
  expiresAt: string;
  username: string;
  profileId: string | null;
  profileTokens: Record<string, ProfileToken>;
}

function read(): StoredSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!s || typeof s.token !== 'string' || !s.token) return null;
    return {
      token: s.token,
      expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : '',
      username: typeof s.username === 'string' ? s.username : '',
      profileId: typeof s.profileId === 'string' ? s.profileId : null,
      profileTokens: s.profileTokens && typeof s.profileTokens === 'object' ? s.profileTokens : {},
    };
  } catch {
    return null;
  }
}

function write(s: StoredSession | null): void {
  try {
    if (s) globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(s));
    else globalThis.localStorage?.removeItem(SESSION_KEY);
  } catch {
    // Stockage indisponible : la session ne survit pas au rechargement.
  }
}

let memory: StoredSession | null = read();

export const getSession = (): StoredSession | null => memory;
export const hasSession = (): boolean => memory !== null;

export function setSession(token: string, expiresAt: string, username: string): void {
  memory = { token, expiresAt, username, profileId: null, profileTokens: {} };
  write(memory);
}

export function updateToken(token: string, expiresAt: string): void {
  if (!memory) return;
  memory = { ...memory, token, expiresAt };
  write(memory);
}

export function clearSession(): void {
  memory = null;
  write(null);
}

export function setActiveProfile(profileId: string | null): void {
  if (!memory) return;
  memory = { ...memory, profileId };
  write(memory);
}

export function saveProfileToken(profileId: string, token: ProfileToken): void {
  if (!memory) return;
  memory = { ...memory, profileTokens: { ...memory.profileTokens, [profileId]: token } };
  write(memory);
}

export function dropProfileToken(profileId: string): void {
  if (!memory) return;
  const { [profileId]: _gone, ...rest } = memory.profileTokens;
  memory = { ...memory, profileTokens: rest };
  write(memory);
}

/** Jeton de profil encore valable (avec une marge d'une minute), sinon undefined. */
export function validProfileToken(profileId: string, now = Date.now()): string | undefined {
  const t = memory?.profileTokens[profileId];
  if (!t) return undefined;
  return Date.parse(t.expiresAt) - 60_000 > now ? t.token : undefined;
}

/** Efface l'ancien choix « continuer sans compte » : les installations existantes tombent sur l'écran de connexion. */
export function clearLegacyLocalMode(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_LOCAL_MODE_KEY);
  } catch {
    // Stockage indisponible.
  }
}

/** Relit le stockage (tests). */
export function reloadSession(): StoredSession | null {
  memory = read();
  return memory;
}
