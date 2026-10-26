import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigDecodeError, decodeConfig, decryptJson, encryptJson } from '../src/config/codec.js';
import {
  getServerServices,
  type ServerServiceField,
  type ServerServicesEnv,
  type ServerServicesPatch,
  serverServicesState,
  setServerServices,
  withServerServices,
} from '../src/config/server-services.js';
import { type Config, parseConfig } from '../src/config/schema.js';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import type { RuntimeEnv } from '../src/platform/types.js';
import { migrate } from '../src/user/migrations.js';
import { asyncRepo } from '../src/user/repo.js';
import { UserStore } from '../src/user/store.js';

/** Secret de test. Celui de FIXTURE_ACCOUNT_CONFIG : ne pas le changer sans regénérer la fixture. */
const SECRET = 'secret-de-test-cles-serveur-0123456789abcdef';

/**
 * Configuration de compte chiffrée avec l'ancien code (encodeConfig, avant les clés serveur). Elle doit toujours se
 * déchiffrer à l'identique : c'est le test de non-régression du format des configurations existantes.
 */
const FIXTURE_ACCOUNT_CONFIG =
  '52Nw5iRXEcpjhNXTegqBI7ZzEwfNT1jDrfj74uQ1Q1p57Vc0RSaCLcci4IncCkFQK9PslGOsn0mLPqGOuVpmfyzfBaHdZW4K2GauptOUHmQziwYAWQyDCPj30_BBBSMs1na1M0Wxsx4BdYz-L-4xUWvJJuk0LAdp7Eqm1vPJlezomxFKaw74Dbs-R43zIM3_2TTbb9jfIrkuwQNn2FSxAE6b7WDPzxfhtLJyp-2WLcnp8VldKD699jFimks2C-XyiFg73hansZHCqA3O58g0foX1WfA-qHblTX_OmEeAQUOxOcSDVffkLjkrZvXwwo1n7FSADagi6I0DdzaxrMm8MZ-6L7cp7oLRzO7UdLJP5zZhEx9FlvjO1uPOLRv_Ll1fDH1dMlXMhYBH4RTODP9-QLPvrnZOlxYHQWlIGvZ_19ebud660jgYlDWsgdcW0tBZClm4nfSwmA45RaAbu6fZPUDRhcDVsIjBpqDdMOuwe60EhJREar2PT7trAVgZSUjJXWPDfgOty0bIiR8v54Gnyhge4BziPGLNgFmhiOQEw7axcRRzbxTz-v5c57rnEeFBDK_SEiLcWP8VsaXz3KUiKUgtUfkFCQc4VQ582iNZ77jDQnEjqH5TThe2tpUEmj45_09q00ddkqpb6vtILKzadpJL8dWSts87FbpVj8wU2pRBXsHKNCVHiGciNtqZoH-sQyM75WUWVq-2K6Hd7PBOkBLJuDqQ_1_2hxVHVnJ3vVI6FKbFlAcMgjUOvdy6A-K2F98v0WOz0PHDUH03q5xZ1L8D5SfUKKkcpFoYklPBYYVTBfjIyG14X8BXve_jxp4vH0EibR2CC7Oof4Aj1pFivf_-kZsuuWdKsMhDtLM4DGiamt7J2Tb53sZz-d5eoors2-dpv74b_9tsf6VA0fTo7xe4t8Lvjc2MvrPCglQGQu3ccDYnpDsvuZIpzTt0hFGSBybLM871LZYfeebmAOWrL2CSj5gtR2OPLktLem7fxjkm7ll5yPTi7H0fGRtnRyT5DugGREiBfyxDkwYmyzgz_FEpoCXBhlELSaORAwlS9mvigv5GnNIVDAFCTQ9zZCM-7nwrUvuPE4m46itJi34CA1r_7Wm5EtgcK4yfiaa624cH7hbXgnTQDNYruHjuqcNE41dTHf97Ios-pD-PG-nZsaBC-rF8LL42QmqNA134Tn9b7GX9XD0vyFWmkDXpw4fi90VSR2bN6fPLP2IbfVslNV29v4P4jDL2dpsIOgMZmB-A';

/** Champs gérés par le propriétaire et variable d'exécution de chacun. */
const OWNER_FIELDS = [
  ['tmdbToken', 'TMDB_TOKEN'],
  ['tmdbApiKey', 'TMDB_API_KEY'],
  ['mdblistApiKey', 'MDBLIST_API_KEY'],
  ['tvdbApiKey', 'TVDB_API_KEY'],
  ['tvdbPin', 'TVDB_PIN'],
  ['fanartApiKey', 'FANART_API_KEY'],
  ['introdbApiKey', 'INTRODB_API_KEY'],
  ['skipdbApiKey', 'SKIPDB_API_KEY'],
  ['animeskipClientId', 'ANIMESKIP_CLIENT_ID'],
] as const satisfies readonly (readonly [ServerServiceField, string])[];

interface Harness {
  env: ServerServicesEnv;
  store: UserStore;
  vars: Record<string, string | undefined>;
  reads: { count: number; fail: boolean };
}

/** Environnement de test : base SQLite en mémoire migrée, variables d'exécution réglables, compteur de lectures. */
function harness(vars: Record<string, string | undefined> = {}): Harness {
  const db = wrapSqlite(new DatabaseSync(':memory:'));
  migrate(db);
  const store = new UserStore(db);
  const repo = asyncRepo(store);
  const reads = { count: 0, fail: false };
  const users = {
    listServerServiceRows: () => {
      reads.count += 1;
      if (reads.fail) return Promise.reject(new Error('base indisponible'));
      return repo.listServerServiceRows();
    },
    writeServerServices: (writes: Parameters<typeof repo.writeServerServices>[0]) => repo.writeServerServices(writes),
  };
  const runtime: RuntimeEnv = { get: (name) => vars[name], all: () => ({ ...vars }) };
  return { env: { users, secret: SECRET, runtime }, store, vars, reads };
}

/** Configuration de compte minimale portant les clés données. */
const account = (services: Record<string, string>): Config => parseConfig({ services, sources: [] });

/** Patch d'écriture pour un seul champ (les champs sont passés dynamiquement dans les tests paramétrés). */
const patchOf = (field: string, value: string | null): ServerServicesPatch => ({ [field]: value }) as ServerServicesPatch;

/** Clé TheTVDB serveur de test. Le PIN serveur ne s'applique qu'avec une clé serveur (la paire vient d'une seule source). */
const CLE_TVDB_SERVEUR = 'tvdb-cle-serveur-0123456789';
const cleTvdbSiPin = (field: string): ServerServicesPatch => (field === 'tvdbPin' ? { tvdbApiKey: CLE_TVDB_SERVEUR } : {});

describe('priorité : base serveur, puis variable d\'environnement, puis clé du compte', () => {
  it.each(OWNER_FIELDS)('%s : la base prime sur la variable d\'environnement et sur le compte', async (field, name) => {
    const h = harness({ [name]: 'env-valeur-0123456789' });
    await setServerServices(h.env, { ...cleTvdbSiPin(field), ...patchOf(field, 'base-valeur-0123456789') });
    const config = await withServerServices(account({ [field]: 'compte-valeur-01234' }), h.env);
    expect(config.services[field]).toBe('base-valeur-0123456789');
  });

  it.each(OWNER_FIELDS)('%s : la variable d\'environnement prime sur le compte quand la base est vide', async (field, name) => {
    const h = harness({ [name]: 'env-valeur-0123456789', ...(field === 'tvdbPin' ? { TVDB_API_KEY: CLE_TVDB_SERVEUR } : {}) });
    const config = await withServerServices(account({ [field]: 'compte-valeur-01234' }), h.env);
    expect(config.services[field]).toBe('env-valeur-0123456789');
  });

  it.each(OWNER_FIELDS)('%s : sans base ni variable, la clé du compte est gardée', async (field) => {
    const h = harness();
    const config = await withServerServices(account({ [field]: 'compte-valeur-01234' }), h.env);
    expect(config.services[field]).toBe('compte-valeur-01234');
  });

  it('une variable vide ou blanche est ignorée', async () => {
    const h = harness({ TMDB_TOKEN: '   ' });
    const config = await withServerServices(account({ tmdbToken: 'compte-valeur-01234' }), h.env);
    expect(config.services.tmdbToken).toBe('compte-valeur-01234');
  });

  it('les valeurs de la base sont enregistrées sans espaces autour', async () => {
    const h = harness();
    await setServerServices(h.env, { tmdbToken: '  base-valeur-0123456789  ' });
    expect((await getServerServices(h.env)).tmdbToken).toBe('base-valeur-0123456789');
  });
});

describe('TVDB : clé et PIN forment une paire, résolue d\'une seule source', () => {
  const COMPTE_CLE = 'tvdb-cle-compte-0123456789';
  const COMPTE_PIN = 'pin-compte-0123';
  const compte = () => account({ tvdbApiKey: COMPTE_CLE, tvdbPin: COMPTE_PIN });

  it('(a) clé serveur sans PIN : la clé serveur prime et le PIN du compte n\'est pas repris', async () => {
    const h = harness();
    await setServerServices(h.env, { tvdbApiKey: 'tvdb-cle-serveur-0123456789' });
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe('tvdb-cle-serveur-0123456789');
    expect(config.services.tvdbPin).toBeUndefined();
  });

  it('(a bis) clé de variable d\'environnement sans PIN : même règle', async () => {
    const h = harness({ TVDB_API_KEY: 'tvdb-cle-env-0123456789' });
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe('tvdb-cle-env-0123456789');
    expect(config.services.tvdbPin).toBeUndefined();
  });

  it('(b) PIN serveur seul : la paire du compte est gardée', async () => {
    const h = harness();
    await setServerServices(h.env, { tvdbPin: 'pin-serveur-0123' });
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe(COMPTE_CLE);
    expect(config.services.tvdbPin).toBe(COMPTE_PIN);
  });

  it('(b bis) PIN de variable d\'environnement seul : la paire du compte est gardée', async () => {
    const h = harness({ TVDB_PIN: 'pin-env-0123' });
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe(COMPTE_CLE);
    expect(config.services.tvdbPin).toBe(COMPTE_PIN);
  });

  it('(c) clé et PIN serveur : la paire serveur remplace celle du compte', async () => {
    const h = harness();
    await setServerServices(h.env, { tvdbApiKey: 'tvdb-cle-serveur-0123456789', tvdbPin: 'pin-serveur-0123' });
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe('tvdb-cle-serveur-0123456789');
    expect(config.services.tvdbPin).toBe('pin-serveur-0123');
  });

  it('(d) rien côté serveur : la paire du compte est gardée telle quelle', async () => {
    const h = harness();
    const config = await withServerServices(compte(), h.env);
    expect(config.services.tvdbApiKey).toBe(COMPTE_CLE);
    expect(config.services.tvdbPin).toBe(COMPTE_PIN);
  });
});

describe('OpenRouter : compte, puis OPENROUTER_API_KEY, jamais la base', () => {
  it('la clé du compte prime sur OPENROUTER_API_KEY', async () => {
    const h = harness({ OPENROUTER_API_KEY: 'or-env-0123456789ab' });
    const config = await withServerServices(account({ openrouterApiKey: 'or-compte-01234567' }), h.env);
    expect(config.services.openrouterApiKey).toBe('or-compte-01234567');
  });

  it('OPENROUTER_API_KEY complète un compte sans clé', async () => {
    const h = harness({ OPENROUTER_API_KEY: 'or-env-0123456789ab' });
    const config = await withServerServices(account({ openrouterModel: 'test/model' }), h.env);
    expect(config.services.openrouterApiKey).toBe('or-env-0123456789ab');
    expect(config.services.openrouterModel).toBe('test/model');
  });

  it('sans compte ni variable, aucune clé OpenRouter', async () => {
    const h = harness();
    const config = await withServerServices(account({}), h.env);
    expect(config.services.openrouterApiKey).toBeUndefined();
  });

  it('une clé OpenRouter écrite en base est refusée : ni stockée, ni lue', async () => {
    const h = harness();
    const state = await setServerServices(h.env, { openrouterApiKey: 'or-base-0123456789' } as unknown as ServerServicesPatch);
    expect(h.store.listServerServiceRows()).toEqual([]);
    expect(Object.keys(state)).not.toContain('openrouterApiKey');
    const config = await withServerServices(account({}), h.env);
    expect(config.services.openrouterApiKey).toBeUndefined();
  });
});

describe('base vide : comportement actuel', () => {
  it('sans base ni variable, la configuration est renvoyée telle quelle', async () => {
    const h = harness();
    const config = account({ tmdbToken: 'compte-valeur-0123456789' });
    expect(await withServerServices(config, h.env)).toBe(config);
  });

  it('avec une variable seulement, elle complète les clés absentes du compte', async () => {
    const h = harness({ TMDB_TOKEN: 'env-valeur-0123456789', MDBLIST_API_KEY: 'mdb-env-0123456789ab' });
    const config = await withServerServices(account({ mdblistApiKey: 'mdb-compte-0123456789' }), h.env);
    expect(config.services.tmdbToken).toBe('env-valeur-0123456789');
    expect(config.services.mdblistApiKey).toBe('mdb-env-0123456789ab');
  });

  it('une configuration de compte chiffrée avec l\'ancien code se déchiffre toujours, clés incluses', () => {
    const config = decodeConfig(FIXTURE_ACCOUNT_CONFIG, SECRET, { allowPlain: false });
    expect(config.services.tmdbToken).toBe('jeton-compte-fixture-0123456789');
    expect(config.services.openrouterApiKey).toBe('or-compte-fixture-0123');
  });

  it('cette configuration de compte est résolue à l\'identique avec une base vide', async () => {
    const h = harness();
    const config = decodeConfig(FIXTURE_ACCOUNT_CONFIG, SECRET, { allowPlain: false });
    expect(await withServerServices(config, h.env)).toBe(config);
  });
});

describe('cache de 60 s par isolat et invalidation à l\'écriture', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ne relit la base qu\'une fois par minute', async () => {
    const h = harness();
    await getServerServices(h.env);
    await getServerServices(h.env);
    await getServerServices(h.env);
    expect(h.reads.count).toBe(1);
    vi.advanceTimersByTime(59_000);
    await getServerServices(h.env);
    expect(h.reads.count).toBe(1);
    vi.advanceTimersByTime(1_000);
    await getServerServices(h.env);
    expect(h.reads.count).toBe(2);
  });

  it('une écriture par setServerServices est visible aussitôt', async () => {
    const h = harness();
    expect((await getServerServices(h.env)).tmdbToken).toBeUndefined();
    await setServerServices(h.env, { tmdbToken: 'base-jeton-0123456789' });
    expect((await getServerServices(h.env)).tmdbToken).toBe('base-jeton-0123456789');
  });

  it('une écriture faite sans invalidation locale (autre isolat) n\'est vue qu\'après 60 s', async () => {
    const h = harness();
    await getServerServices(h.env);
    h.store.writeServerServices([{ field: 'tmdbToken', sealed: encryptJson('jeton-autre-isolat-0123', SECRET, 'server-services') }]);
    expect((await getServerServices(h.env)).tmdbToken).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect((await getServerServices(h.env)).tmdbToken).toBe('jeton-autre-isolat-0123');
  });

  it('une panne de lecture repli sur les variables, et le repli n\'est gardé que 5 s', async () => {
    const h = harness({ TMDB_TOKEN: 'env-jeton-0123456789' });
    h.reads.fail = true;
    expect((await getServerServices(h.env)).tmdbToken).toBe('env-jeton-0123456789');
    expect((await getServerServices(h.env)).tmdbToken).toBe('env-jeton-0123456789');
    expect(h.reads.count).toBe(1);
    h.reads.fail = false;
    await setServerServices(h.env, { tmdbToken: 'base-jeton-0123456789' });
    expect((await getServerServices(h.env)).tmdbToken).toBe('base-jeton-0123456789');
  });

  it('après une panne, aucune relecture pendant 5 s, puis réessai', async () => {
    const h = harness();
    h.reads.fail = true;
    await getServerServices(h.env);
    h.store.writeServerServices([{ field: 'tmdbToken', sealed: encryptJson('jeton-apres-panne-0123', SECRET, 'server-services') }]);
    h.reads.fail = false;
    vi.advanceTimersByTime(4_999);
    expect((await getServerServices(h.env)).tmdbToken).toBeUndefined();
    expect(h.reads.count).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await getServerServices(h.env)).tmdbToken).toBe('jeton-apres-panne-0123');
    expect(h.reads.count).toBe(2);
  });

  it('des lectures simultanées sur cache vide ne lancent qu\'un seul appel au dépôt', async () => {
    const h = harness();
    await Promise.all([getServerServices(h.env), getServerServices(h.env), serverServicesState(h.env)]);
    expect(h.reads.count).toBe(1);
  });

  it('une écriture pendant une lecture en cours abandonne sa promesse', async () => {
    const h = harness();
    const pending = getServerServices(h.env);
    await setServerServices(h.env, { tmdbToken: 'base-jeton-0123456789' });
    await pending;
    expect((await getServerServices(h.env)).tmdbToken).toBe('base-jeton-0123456789');
  });
});

describe('journalisation des pannes : ligne générique, jamais de valeur', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('une panne de lecture journalise la ligne générique', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness();
    h.reads.fail = true;
    await getServerServices(h.env);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('server_services indisponible'));
  });

  it('une ligne illisible journalise le nom du champ, jamais sa valeur', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness();
    h.store.writeServerServices([
      { field: 'tmdbToken', sealed: encryptJson('valeur-secrete-illisible-0123', 'autre-secret-de-test-0123456789', 'server-services') },
    ]);
    expect(await getServerServices(h.env)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tmdbToken'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('valeur-secrete-illisible');
  });
});

describe('état masqué', () => {
  it('ne renvoie jamais la valeur complète, seulement la présence et les quatre derniers caractères', async () => {
    const h = harness();
    const state = await setServerServices(h.env, { tmdbToken: 'tmdb-token-LONGSECRET-abcd1234' });
    expect(state.tmdbToken).toEqual({ set: true, last4: '…1234', source: 'db' });
    expect(JSON.stringify(state)).not.toContain('LONGSECRET');
  });

  it('pas de quatre derniers caractères sous 12 caractères', async () => {
    const h = harness();
    const state = await setServerServices(h.env, { tvdbPin: 'pin-9876' });
    expect(state.tvdbPin).toEqual({ set: true, source: 'db' });
    expect(state.tvdbPin).not.toHaveProperty('last4');
  });

  it('une variable d\'environnement est signalée source env, avec son masque', async () => {
    const h = harness({ FANART_API_KEY: 'fanart-cle-environnement-9999' });
    const state = await serverServicesState(h.env);
    expect(state.fanartApiKey).toEqual({ set: true, last4: '…9999', source: 'env' });
  });

  it('une clé absente : set false et source none', async () => {
    const h = harness();
    const state = await serverServicesState(h.env);
    expect(state.skipdbApiKey).toEqual({ set: false, source: 'none' });
  });

  it('la base prime sur la variable dans l\'état', async () => {
    const h = harness({ TMDB_TOKEN: 'env-jeton-0123456789' });
    await setServerServices(h.env, { tmdbToken: 'base-jeton-abcdef0123' });
    const state = await serverServicesState(h.env);
    expect(state.tmdbToken).toEqual({ set: true, last4: '…0123', source: 'db' });
  });

  it('la valeur est chiffrée en base : le texte clair n\'y figure pas', async () => {
    const h = harness();
    await setServerServices(h.env, { introdbApiKey: 'introdb-secret-clair-0001' });
    const [row] = h.store.listServerServiceRows();
    expect(row?.sealed).toBeDefined();
    expect(row?.sealed).not.toContain('introdb-secret-clair');
    expect(decryptJson(row?.sealed ?? '', SECRET, 'server-services')).toBe('introdb-secret-clair-0001');
  });
});

describe('écriture : null efface, valeur vide ou absente garde', () => {
  it('null efface la clé de la base ; la variable d\'environnement reprend le relais', async () => {
    const h = harness({ TMDB_TOKEN: 'env-jeton-0123456789' });
    await setServerServices(h.env, { tmdbToken: 'base-jeton-0123456789' });
    const state = await setServerServices(h.env, { tmdbToken: null });
    expect(state.tmdbToken).toEqual({ set: true, last4: '…6789', source: 'env' });
    expect(h.store.listServerServiceRows()).toEqual([]);
  });

  it('valeur vide, blanche ou absente : la valeur précédente est gardée', async () => {
    const h = harness();
    await setServerServices(h.env, { tmdbToken: 'base-jeton-0123456789' });
    await setServerServices(h.env, { tmdbToken: '   ' });
    expect((await serverServicesState(h.env)).tmdbToken).toMatchObject({ set: true, source: 'db' });
    const state = await setServerServices(h.env, {});
    expect(state.tmdbToken).toMatchObject({ set: true, source: 'db' });
  });

  it('une valeur de plus de 500 caractères est refusée sans l\'afficher', async () => {
    const h = harness();
    const long = `x${'y'.repeat(500)}`;
    await expect(setServerServices(h.env, { tmdbToken: long })).rejects.toThrow(RangeError);
    await expect(setServerServices(h.env, { tmdbToken: long })).rejects.not.toThrow(long);
    expect(h.store.listServerServiceRows()).toEqual([]);
  });
});

describe('chiffrement distinct de celui des configurations de compte', () => {
  it('une clé serveur n\'est pas lisible comme configuration de compte', async () => {
    const h = harness();
    await setServerServices(h.env, { tmdbToken: 'tmdb-token-LONGSECRET-abcd1234' });
    const [row] = h.store.listServerServiceRows();
    expect(() => decodeConfig(row?.sealed ?? '', SECRET, { allowPlain: false })).toThrow(ConfigDecodeError);
  });

  it('une clé serveur ne se déchiffre pas avec un autre libellé', async () => {
    const h = harness();
    await setServerServices(h.env, { tmdbToken: 'tmdb-token-LONGSECRET-abcd1234' });
    const [row] = h.store.listServerServiceRows();
    expect(() => decryptJson(row?.sealed ?? '', SECRET, 'molotov')).toThrow(ConfigDecodeError);
  });
});
