import { setPlatform } from '../src/platform/index.js';
import { createNodePlatform } from '../src/platform/node/index.js';

setPlatform(createNodePlatform());

// Clés de services du serveur : jamais héritées de l'environnement de la machine (les tests les posent eux-mêmes).
for (const name of ['TMDB_TOKEN', 'TMDB_API_KEY', 'MDBLIST_API_KEY', 'TVDB_API_KEY', 'TVDB_PIN', 'OPENROUTER_API_KEY', 'FANART_API_KEY', 'INTRODB_API_KEY', 'SKIPDB_API_KEY', 'ANIMESKIP_CLIENT_ID']) {
  delete process.env[name];
}
