// Migration des données utilisateur d'une base SQLite locale vers le Durable Object du Worker lastaddon-core.
// Usage : npx tsx scripts/export-cloud.ts [--db <fichier>] [--url <https://…>] [--force] [--dry-run] [--verify-only]
//   --dry-run     lit la base locale et affiche les empreintes, sans rien envoyer
//   --verify-only compare seulement les empreintes locales et distantes
//   --force       vide d'abord les tables distantes si elles ne sont pas vides (refus sinon)
// Secret : variable ADMIN_SECRET, sinon %APPDATA%\Laststream\admin.secret (jamais affiché). La base locale est ouverte en
// lecture seule : arrêter le service local avant l'export final pour qu'aucune écriture ne se perde.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATED_TABLES,
  type MigratedTable,
  type TableDigest,
  columnsOf,
  digestAll,
  toWire,
} from '../src/admin/data-migration.js';
import { wrapSqlite } from '../src/platform/node/user-db.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const appData = process.env.APPDATA ?? '';
const dbPath = option('--db') ?? join(appData, 'Laststream', 'lastaddon', 'laststream.db');
const baseUrl = (option('--url') ?? 'https://lastaddon-core.gtux-prog.workers.dev').replace(/\/$/, '');
const BATCH = 400;

function adminSecret(): string {
  const fromEnv = process.env.ADMIN_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const secret = readFileSync(join(appData, 'Laststream', 'admin.secret'), 'utf8').trim();
  if (secret.length < 32) throw new Error('admin.secret trop court');
  return secret;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- script ad hoc, réponses JSON non typées
async function call(secret: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${baseUrl}/__admin/${path}`, {
    method,
    headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function compare(local: Record<MigratedTable, TableDigest>, remote: Record<string, TableDigest>): boolean {
  let same = true;
  for (const table of MIGRATED_TABLES) {
    const a = local[table];
    const b = remote[table];
    const ok = b !== undefined && a.count === b.count && a.sha256 === b.sha256;
    if (!ok) same = false;
    console.log(`${ok ? 'OK ' : 'ECART'} ${table.padEnd(18)} local=${a.count} cloud=${b?.count ?? '?'} sha=${a.sha256.slice(0, 12)}${ok ? '' : ` / ${b?.sha256.slice(0, 12) ?? '?'}`}`);
  }
  return same;
}

const sqlite = new DatabaseSync(dbPath, { readOnly: true });
const db = wrapSqlite(sqlite);
const local = await digestAll(db);

if (flag('--dry-run')) {
  for (const table of MIGRATED_TABLES) console.log(`${table.padEnd(18)} ${local[table].count} lignes  sha=${local[table].sha256.slice(0, 12)}`);
  process.exit(0);
}

const secret = adminSecret();

if (!flag('--verify-only')) {
  const begin = await call(secret, 'POST', 'import', { action: 'begin', force: flag('--force') });
  if (begin.status === 409) {
    console.error('Base distante non vide : import refusé (relancer avec --force pour la vider d\'abord).');
    process.exit(2);
  }
  if (begin.status !== 200) {
    console.error(`Début d'import refusé (HTTP ${begin.status}).`);
    process.exit(1);
  }
  for (const table of MIGRATED_TABLES) {
    const columns = columnsOf(db, table);
    const select = columns.map((name) => `"${name}"`).join(', ');
    const order = columns.map((_, index) => index + 1).join(', ');
    const rows = db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${order}`).all().map((row) => toWire(row, columns));
    for (let at = 0; at < rows.length; at += BATCH) {
      const result = await call(secret, 'POST', 'import', { action: 'insert', table, columns, rows: rows.slice(at, at + BATCH) });
      if (result.status !== 200) {
        console.error(`Échec de l'import de ${table} (HTTP ${result.status}) : relancer avec --force pour repartir d'une base vide.`);
        process.exit(1);
      }
    }
    console.log(`importé ${table}: ${rows.length}`);
  }
}

const remote = await call(secret, 'GET', 'counts');
if (remote.status !== 200) {
  console.error(`Lecture des compteurs refusée (HTTP ${remote.status}).`);
  process.exit(1);
}
const identical = compare(local, remote.data.tables as Record<string, TableDigest>);
console.log(identical ? 'Vérification : compteurs et sommes de contrôle identiques.' : 'Vérification : ÉCARTS détectés.');
process.exit(identical ? 0 : 1);
