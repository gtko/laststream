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

/**
 * Alerte d'exploitation sans erreur (ex. une source TV en échec depuis deux passages) : message court et contexte sans
 * donnée personnelle ni URL. Même principe que ci-dessus : aucun récepteur par défaut, le Worker installe Sentry.
 */
export type WarningReporter = (message: string, context: Record<string, unknown>) => void;

let warningReporter: WarningReporter | undefined;

export function setWarningReporter(next: WarningReporter | undefined): void {
  warningReporter = next;
}

/** Ne lève jamais. */
export function reportWarning(message: string, context: Record<string, unknown>): void {
  if (warningReporter === undefined) return;
  try {
    warningReporter(message, context);
  } catch {
    // Sans effet sur le passage qui l'a émise.
  }
}
