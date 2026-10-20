import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPlatform } from '../src/platform/index.js';
import { createNodePlatform } from '../src/platform/node/index.js';

setPlatform(createNodePlatform());

// Clés de services du serveur : jamais héritées de l'environnement de la machine (les tests les posent eux-mêmes).
for (const name of ['TMDB_TOKEN', 'TMDB_API_KEY', 'MDBLIST_API_KEY', 'TVDB_API_KEY', 'TVDB_PIN', 'OPENROUTER_API_KEY', 'FANART_API_KEY', 'INTRODB_API_KEY', 'SKIPDB_API_KEY', 'ANIMESKIP_CLIENT_ID']) {
  delete process.env[name];
}

// Base utilisateur : jamais le dossier data/ du projet. Chaque fichier de test écrit dans un dossier temporaire à lui
// (supprimé en fin de processus) ; les tests qui visent un chemin précis posent eux-mêmes LASTADDON_DATA_DIR.
const dataDir = mkdtempSync(join(tmpdir(), 'lastaddon-test-data-'));
process.env.LASTADDON_DATA_DIR = dataDir;
process.on('exit', () => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Nettoyage au mieux : un fichier encore ouvert (Windows) ne doit pas faire échouer la suite.
  }
});
