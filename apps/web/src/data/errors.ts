export type LastAddonErrorKind = 'not_configured' | 'invalid_base' | 'network' | 'http' | 'invalid_response';

/** Erreur du transport lastAddon. Ne contient jamais d'URL ni de clé. */
export class LastAddonError extends Error {
  readonly kind: LastAddonErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** Problèmes de validation renvoyés par /config/* (chemins et messages, jamais de valeur). */
  readonly issues?: string[];

  constructor(kind: LastAddonErrorKind, message: string, extra: { status?: number; code?: string; issues?: string[] } = {}) {
    super(message);
    this.name = 'LastAddonError';
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.issues = extra.issues;
  }
}
