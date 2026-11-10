/* Compatibilité des anciennes coques Windows (LASTSTREAM-WEB-1). Avant LAST-1623 (v1.0.35), le script injecté par la coque
 * appelait `window.initShellComm()` sans vérifier qu'elle existe, au chargement de chaque page : « ReferenceError:
 * initShellComm is not defined ». L'interface étant servie par le serveur, les coques déjà installées et pas encore à jour
 * recevaient l'erreur à chaque démarrage. La communication avec la coque passe par `window.qt.webChannelTransport` (posé
 * par la coque elle-même) : `initShellComm` n'a rien à faire, une fonction vide suffit. */

type ShellWindow = { initShellComm?: unknown };

/** Pose `initShellComm` (fonction vide) si personne ne l'a définie. Ne remplace jamais une fonction existante. */
export function installShellCompat(win: ShellWindow): void {
  if (typeof win.initShellComm !== 'function') win.initShellComm = () => undefined;
}

installShellCompat(globalThis as unknown as ShellWindow);
