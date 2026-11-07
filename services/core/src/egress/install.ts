/**
 * Effet de bord à l'import : pose la garde de sortie sur le fetch global. Importé en tout premier par worker.ts : en ESM
 * les imports s'exécutent dans l'ordre, donc aucun autre module de l'isolat ne peut capturer le fetch d'origine.
 */
import { installEgressGuard } from './debrid-guard.js';

installEgressGuard();
