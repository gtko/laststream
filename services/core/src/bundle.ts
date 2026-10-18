/**
 * Point d'entrée du bundle mono-fichier (npm run bundle → dist-bundle/lastaddon.cjs). Démarre le serveur à l'import :
 * le bundle n'a pas de module « principal » distinct de server.ts, dont le test isDirectRun ne peut pas servir ici.
 */
import { start } from './server.js';

start();
