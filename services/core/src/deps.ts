/** Dépendances injectées dans l'application. Ne jamais logger ces valeurs. */
export interface AppDeps {
  /** Clé de chiffrement des configurations. */
  secret: string;
  /** Accepter les configurations en JSON brut (non chiffré). */
  allowPlain: boolean;
}
