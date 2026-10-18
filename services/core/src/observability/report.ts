/**
 * Remontée des erreurs non gérées (réponse 500 de l'application) vers un outil d'observabilité. Aucun récepteur par
 * défaut (Node, tests) : rien ne change tant que personne ne l'installe. Le Worker l'installe pour Sentry (src/worker.ts).
 */
export type UnhandledErrorReporter = (error: unknown) => void;

let reporter: UnhandledErrorReporter | undefined;

export function setUnhandledErrorReporter(next: UnhandledErrorReporter | undefined): void {
  reporter = next;
}

/** Ne lève jamais : une remontée en échec ne doit pas modifier la réponse au client. */
export function reportUnhandledError(error: unknown): void {
  if (reporter === undefined) return;
  try {
    reporter(error);
  } catch {
    // Sans effet sur la réponse.
  }
}
