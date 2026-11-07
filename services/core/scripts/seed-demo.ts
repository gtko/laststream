// Compte de démonstration LOCAL « demo » / « demo » : créé ou remis à zéro dans la base de développement de cette machine.
// À ne JAMAIS exécuter contre la production : le mot de passe est public et le script écrit directement dans la base SQLite.
// Idempotent (npm run seed:demo) : remet le mot de passe à « demo », règle le quota d'invitations, crée seulement les profils manquants.
// Option --with-keys (npm run seed:demo -- --with-keys) : applique aussi au compte les clés de services lues dans 1Password (seed-demo-keys.ts).
import { randomUUID } from 'node:crypto';
import { secretFromEnv } from '../src/config/secret.js';
import { runtimeEnv, setPlatform } from '../src/platform/index.js';
import { createNodePlatform } from '../src/platform/node/index.js';
import { projectRoot } from '../src/platform/node/paths.js';
import { loadEnvFile } from '../src/platform/node/secret-file.js';
import { openUserDb, userDbPath } from '../src/platform/node/user-db.js';
import { AdminStore } from '../src/user/admin-store.js';
import { hashSecret } from '../src/user/crypto.js';
import { type KidMaxAge, type ProfileFields, UserStore } from '../src/user/store.js';
import {
  applyDemoKeys,
  assertLocalDbTarget,
  DEMO_KEYS_MAP_PATH,
  type DemoKeysPlan,
  defaultOpRunner,
  describeDemoKeys,
  findOpBinary,
  prepareDemoKeys,
  runDemoServiceTest,
} from './seed-demo-keys.js';

const WITH_KEYS_FLAG = '--with-keys';
const DEFAULT_PORT = '7000';
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo';
const DEMO_INVITE_QUOTA = 4;
/** Âge maximal d'un profil enfant : même valeur par défaut que la création normale de profil (routes.ts). */
const KID_MAX_AGE: KidMaxAge = 12;

interface DemoProfile {
  name: string;
  avatarColor: string;
  isKid: boolean;
}

/** Ordre de création : le premier profil adulte (« Démo ») est le profil principal du compte (le plus ancien). */
const DEMO_PROFILES: readonly DemoProfile[] = [
  { name: 'Démo', avatarColor: '#3b82f6', isKid: false },
  { name: 'Sam', avatarColor: '#10b981', isKid: false },
  { name: 'Petits', avatarColor: '#f59e0b', isKid: true },
];

interface SeedOptions {
  readonly withKeys: boolean;
}

function parseOptions(args: readonly string[]): SeedOptions {
  // Le nom d'une option inconnue n'est pas repris : un secret saisi par erreur sur la ligne de commande ne doit pas s'afficher.
  if (args.some((arg) => arg !== WITH_KEYS_FLAG)) throw new Error(`option inconnue : seule ${WITH_KEYS_FLAG} est acceptée`);
  return { withKeys: args.includes(WITH_KEYS_FLAG) };
}

/**
 * Vérifications et lecture des clés (--with-keys) : tout passe avant la première écriture. Serveur local, base locale,
 * secret présent et clés lues via op. Un refus ne modifie ni la base ni le compte.
 */
async function prepareKeys(dbPath: string): Promise<DemoKeysPlan> {
  const env = runtimeEnv();
  assertLocalDbTarget(dbPath, env.get('LASTADDON_DATA_DIR'), projectRoot());
  const port = env.get('PORT')?.trim() || DEFAULT_PORT;
  return prepareDemoKeys({
    mapPath: DEMO_KEYS_MAP_PATH,
    vault: env.get('LASTADDON_OP_VAULT')?.trim() || undefined,
    serverUrl: env.get('LASTADDON_SEED_URL')?.trim() || `http://127.0.0.1:${port}`,
    secret: secretFromEnv(),
    runOp: defaultOpRunner(findOpBinary()),
  });
}

async function seedDemo(options: SeedOptions): Promise<void> {
  // Même plateforme et même .env que le serveur : la base visée est celle qu'il ouvre (LASTADDON_DATA_DIR, sinon data/).
  setPlatform(createNodePlatform());
  loadEnvFile();
  const dbPath = userDbPath();
  const keys = options.withKeys ? await prepareKeys(dbPath) : undefined;
  const db = openUserDb(dbPath);
  try {
    const users = new UserStore(db);
    const admin = new AdminStore(db);
    // Sur une base vide, la création du premier compte en ferait le propriétaire : « demo » ne doit jamais l'être.
    if (users.countAccounts() === 0) {
      throw new Error('base vide : créez d\'abord le compte propriétaire dans l\'application, puis relancez le script');
    }

    const existing = users.findAccountRecord(DEMO_USERNAME);
    let accountId: string;
    let action: string;
    if (existing === undefined) {
      const created = users.createAccount({
        username: DEMO_USERNAME,
        passwordHash: await hashSecret(DEMO_PASSWORD),
        // Création hors parcours d'inscription : la règle de /user/register (8 caractères minimum) n'est pas modifiée.
        allowSignup: true,
        now: new Date().toISOString(),
      });
      if (!created.ok) throw new Error(`création du compte « ${DEMO_USERNAME} » refusée : ${created.reason}`);
      accountId = created.account.id;
      action = 'créé';
    } else {
      if (existing.isOwner) throw new Error(`le compte « ${DEMO_USERNAME} » existant est propriétaire : refus de le modifier`);
      // Nouveau mot de passe : toutes les sessions du compte sont révoquées (keepHash vide ne correspond à aucune).
      users.changePassword(existing.id, await hashSecret(DEMO_PASSWORD), '');
      accountId = existing.id;
      action = 'mis à jour';
    }

    if (!admin.setInviteQuota(accountId, DEMO_INVITE_QUOTA)) throw new Error('quota d\'invitations non appliqué');

    const existingNames = new Set(users.listProfiles(accountId).map((profile) => profile.name));
    const base = Date.now();
    const createdNames: string[] = [];
    for (const [index, profile] of DEMO_PROFILES.entries()) {
      if (existingNames.has(profile.name)) continue;
      const fields: ProfileFields = {
        name: profile.name,
        avatarColor: profile.avatarColor,
        avatar: null,
        isKid: profile.isKid,
        kidMaxAge: profile.isKid ? KID_MAX_AGE : null,
        pinHash: null,
        allowedCatalogs: [],
      };
      // Horodatages croissants : l'ordre de création désigne le profil principal, même dans la même milliseconde.
      // insertProfile reproduit la création normale (pid et handle social pour les profils adultes).
      users.insertProfile(accountId, randomUUID(), fields, new Date(base + index).toISOString());
      createdNames.push(profile.name);
    }

    console.log(`Compte « ${DEMO_USERNAME} » ${action} : mot de passe de démonstration défini, quota d'invitations ${DEMO_INVITE_QUOTA}.`);
    console.log(createdNames.length === 0 ? 'Profils : tous déjà présents.' : `Profils créés : ${createdNames.join(', ')}.`);

    if (keys !== undefined) {
      const applied = applyDemoKeys(users, accountId, keys);
      for (const warning of applied.warnings) console.log(`Avertissement : ${warning}.`);
      const test = await runDemoServiceTest(keys.serverOrigin, applied.encoded);
      for (const line of describeDemoKeys(keys, test)) console.log(line);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  await seedDemo(parseOptions(process.argv.slice(2)));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'échec du script de démonstration');
  process.exitCode = 1;
});
