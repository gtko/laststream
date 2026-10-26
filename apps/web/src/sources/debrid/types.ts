/* Débrideurs côté appareil : types communs. AllDebrid, TorBox et Real-Debrid sont contactés UNIQUEMENT depuis l'appareil de
 * l'utilisateur (son IP), jamais depuis le serveur lastAddon : les débrideurs sanctionnent les appels venant d'IP de serveurs. */

export type ProviderId = 'alldebrid' | 'torbox' | 'realdebrid';

export const PROVIDER_IDS: readonly ProviderId[] = ['alldebrid', 'torbox', 'realdebrid'];
export const PROVIDER_LABEL: Record<ProviderId, string> = { alldebrid: 'AllDebrid', torbox: 'TorBox', realdebrid: 'Real-Debrid' };

/** Fichier attendu dans un magnet : index Stremio, nom, taille, et épisode visé (pack de série). */
export interface FileHint {
  fileIdx?: number;
  filename?: string;
  size?: number;
  season?: number;
  episode?: number;
}

export interface ResolvedLink {
  url: string;
  filename: string;
  size: number;
}

/** État d'un compte : `ok` ou la raison pour laquelle il est inutilisable. */
export type AccountState = 'ok' | 'suspended' | 'quota' | 'invalid_key' | 'not_premium' | 'unreachable' | 'unsupported';

export interface ProviderStatus {
  state: AccountState;
  /** Compte premium (si connu). */
  premium?: boolean;
  /** Code générique de l'erreur (jamais la clé). */
  detail?: string;
  /** Fin probable de l'indisponibilité (ms epoch). */
  until?: number;
}

/**
 * Nature d'une erreur :
 * - `account` : compte inutilisable (suspendu, quota, clé invalide) : bascule vers le fournisseur suivant ;
 * - `content` : ce magnet ne passe pas (fichier absent, magnet en erreur, pas prêt) : essai d'une autre copie ;
 * - `transient` : réseau, limite de débit, indisponibilité passagère ;
 * - `unsupported` : appel impossible depuis ce support (CORS sans pont natif).
 */
export type ErrorKind = 'account' | 'content' | 'transient' | 'unsupported';

export class DebridError extends Error {
  constructor(
    readonly code: string,
    readonly kind: ErrorKind,
    readonly opts: { state?: AccountState; retryAfterMs?: number; until?: number; status?: number } = {},
  ) {
    super(code);
    this.name = 'DebridError';
  }
  get state(): AccountState | undefined { return this.opts.state; }
  get retryAfterMs(): number | undefined { return this.opts.retryAfterMs; }
  get until(): number | undefined { return this.opts.until; }
  /** Statut HTTP refusé par la coque (`bad_status`) : absent pour les autres erreurs. */
  get status(): number | undefined { return this.opts.status; }
}

export interface DebridProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Statut « en cache » par hash (minuscules). Un hash absent de la Map est inconnu. Ne lève pas pour une erreur de contenu. */
  checkCache(hashes: readonly string[], signal?: AbortSignal): Promise<Map<string, boolean>>;
  /** Lien de lecture HTTPS du fichier voulu du magnet. Lève DebridError. */
  resolve(hash: string, hint: FileHint, signal?: AbortSignal): Promise<ResolvedLink>;
  /** Vérifie la clé et l'état du compte (un appel). Ne lève pas. */
  status(signal?: AbortSignal): Promise<ProviderStatus>;
}

/** Copie d'une source « client » : un hash et le fichier attendu. */
export interface ClientCopy {
  infoHash: string;
  fileIdx?: number;
  filename?: string;
  size?: number;
}

const HASH_RE = /^[0-9a-f]{40}$/;
export const normalizeHash = (value: string): string | null => {
  const h = value.trim().toLowerCase();
  return HASH_RE.test(h) ? h : null;
};
