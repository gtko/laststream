import { describe, expect, it } from 'vitest';
import { AllDebridClient } from '../src/sources/alldebrid.js';
import { testTorznab } from '../src/sources/torznab.js';

/*
 * Smoke test OPTIONNEL contre les services réels. Ignoré sans variables d'environnement.
 *   ALLDEBRID_API_KEY : clé AllDebrid (lance les tests AllDebrid)
 *   TORZNAB_URL et TORZNAB_KEY : indexeur Torznab (lance le test indexeur)
 * Ne journalise jamais la clé ni la réponse brute. Ne tourne pas dans un CI sans secrets.
 */

/** Big Buck Bunny (domaine public) : hash public, utilisé uniquement pour le cache-check. */
const BIG_BUCK_BUNNY_HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const ALLDEBRID_KEY = process.env.ALLDEBRID_API_KEY ?? '';
const TORZNAB_URL = process.env.TORZNAB_URL ?? '';
const TORZNAB_KEY = process.env.TORZNAB_KEY ?? '';

describe.skipIf(ALLDEBRID_KEY === '')('live : AllDebrid', () => {
  // Le client est créé dans chaque test : le constructeur refuse une clé vide, et ce bloc est collecté même ignoré.
  it('la clé API est acceptée', async () => {
    const result = await new AllDebridClient(ALLDEBRID_KEY).checkApiKey();
    expect(result.ok).toBe(true);
  });

  it('checkCached ne lève pas et renvoie une entrée pour le hash demandé', async () => {
    const cached = await new AllDebridClient(ALLDEBRID_KEY).checkCached([BIG_BUCK_BUNNY_HASH]);
    expect(cached.has(BIG_BUCK_BUNNY_HASH)).toBe(true);
  });
});

describe.skipIf(TORZNAB_URL === '' || TORZNAB_KEY === '')('live : indexeur Torznab', () => {
  it('l’indexeur répond à t=caps avec un document valide', async () => {
    const result = await testTorznab({ name: 'Live', baseUrl: TORZNAB_URL, apiKey: TORZNAB_KEY });
    expect(result.ok).toBe(true);
  });
});
