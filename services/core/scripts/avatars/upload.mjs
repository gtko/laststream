#!/usr/bin/env node
/**
 * Envoie .avatars-build/out (sortie de merge.mjs) vers le bucket R2 lastaddon-avatars. Clé = chemin relatif dans out/,
 * séparateurs « / » : catalog.json, c/<colId>.json, i/<colId>/<charId>.webp.
 *
 * Usage : node scripts/avatars/upload.mjs [--dry-run] [--force]
 * - --dry-run : liste les clés, types et tailles, sans rien envoyer (ni wrangler, ni réseau) ;
 * - --force   : renvoie aussi les fichiers déjà présents dans le journal.
 *
 * Par fichier : npx wrangler r2 object put lastaddon-avatars/<clé> --file <f> --content-type <t> --remote
 * Concurrence 6. Journal .avatars-build/uploaded.json (clé → taille et date de modification) : une reprise saute les
 * fichiers inchangés déjà envoyés. Le journal est écrit par lots et à l'arrêt (Ctrl+C) : au pire, quelques envois refaits.
 * Dépendance : sans lien avec le code de l'application ; wrangler doit être installé (npm ci).
 */
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = join(ROOT, '.avatars-build');
const OUT_DIR = join(BUILD_DIR, 'out');
const JOURNAL = join(BUILD_DIR, 'uploaded.json');
const BUCKET = 'lastaddon-avatars';
const CONCURRENCY = 6;
/** Écriture du journal toutes les N envois réussis (et à l'arrêt). */
const JOURNAL_EVERY = 200;
const PROGRESS_EVERY = 500;
const MAX_FAILURES_SHOWN = 20;
const CONTENT_TYPES = { '.json': 'application/json', '.webp': 'image/webp' };

const KNOWN_ARGS = new Set(['--dry-run', '--force']);
const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => !KNOWN_ARGS.has(arg));
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

/** Chemins relatifs de tous les fichiers sous `dir`, séparateurs « / ». */
function listFiles(dir, prefix = '') {
  const keys = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) keys.push(...listFiles(dir, key));
    else if (entry.isFile()) keys.push(key);
  }
  return keys;
}

/** Fichiers à envoyer : extensions connues seulement, triés par clé. */
function collectEntries() {
  const entries = [];
  for (const key of listFiles(OUT_DIR).sort()) {
    const type = CONTENT_TYPES[extname(key)];
    if (type === undefined) {
      console.warn(`ignoré (type non prévu) : ${key}`);
      continue;
    }
    const file = join(OUT_DIR, ...key.split('/'));
    const info = statSync(file);
    entries.push({ key, file, type, size: info.size, mtimeMs: info.mtimeMs });
  }
  return entries;
}

function readJournal() {
  if (!existsSync(JOURNAL)) return {};
  try {
    return JSON.parse(readFileSync(JOURNAL, 'utf8'));
  } catch {
    console.warn('journal illisible : ignoré (tous les fichiers seront envoyés)');
    return {};
  }
}

/** Écriture atomique : fichier temporaire, puis renommage. */
function writeJournal(journal) {
  mkdirSync(BUILD_DIR, { recursive: true });
  const temporary = `${JOURNAL}.tmp`;
  writeFileSync(temporary, JSON.stringify(journal));
  renameSync(temporary, JOURNAL);
}

const isSent = (entry, journal) => {
  const done = journal[entry.key];
  return done !== undefined && done.size === entry.size && done.mtimeMs === entry.mtimeMs;
};

/** Argument de shell : entre guillemets seulement s'il contient un espace (chemins sans caractères spéciaux). */
const shellArg = (value) => (/\s/.test(value) ? `"${value}"` : value);

function putObject(entry) {
  const command = ['npx', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${entry.key}`, '--file', entry.file, '--content-type', entry.type, '--remote']
    .map(shellArg)
    .join(' ');
  return new Promise((resolvePut) => {
    exec(command, { cwd: ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) resolvePut({ ok: true });
      else resolvePut({ ok: false, reason: (stderr || error.message).trim().split('\n')[0].slice(0, 200) });
    });
  });
}

/** Exécute `task` sur chaque élément, `limit` à la fois. */
async function runPool(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  if (unknownArgs.length > 0) {
    console.error(`option inconnue : ${unknownArgs.join(' ')} (options : --dry-run, --force)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(join(OUT_DIR, 'catalog.json'))) {
    console.error("out/catalog.json introuvable : lancer d'abord node scripts/avatars/merge.mjs");
    process.exitCode = 1;
    return;
  }

  const entries = collectEntries();
  const journal = readJournal();
  const pending = force ? entries : entries.filter((entry) => !isSent(entry, journal));
  const bytes = (list) => list.reduce((sum, entry) => sum + entry.size, 0);

  if (dryRun) {
    for (const entry of entries) console.log(`${entry.key}\t${entry.type}\t${entry.size}`);
    console.log(
      `dry-run : ${entries.length} clé(s), ${bytes(entries)} octets ; à envoyer : ${pending.length} (${bytes(pending)} octets) ; déjà envoyées : ${entries.length - pending.length}. Rien n'a été envoyé.`,
    );
    return;
  }
  if (pending.length === 0) {
    console.log('rien à envoyer : toutes les clés sont au journal (--force pour renvoyer).');
    return;
  }

  let sent = 0;
  let sinceFlush = 0;
  const failures = [];
  const flush = () => {
    if (sinceFlush > 0) writeJournal(journal);
    sinceFlush = 0;
  };
  process.once('SIGINT', () => {
    flush();
    process.exit(130);
  });

  await runPool(pending, CONCURRENCY, async (entry) => {
    const result = await putObject(entry);
    if (!result.ok) {
      failures.push({ key: entry.key, reason: result.reason });
      return;
    }
    journal[entry.key] = { size: entry.size, mtimeMs: entry.mtimeMs };
    sent += 1;
    sinceFlush += 1;
    if (sinceFlush >= JOURNAL_EVERY) flush();
    if (sent % PROGRESS_EVERY === 0) console.log(`${sent}/${pending.length} envoyé(s)`);
  });
  flush();

  console.log(`envoi terminé : ${sent} réussi(s), ${failures.length} échec(s), sur ${pending.length} à envoyer.`);
  for (const failure of failures.slice(0, MAX_FAILURES_SHOWN)) console.error(`  échec ${failure.key} : ${failure.reason}`);
  if (failures.length > MAX_FAILURES_SHOWN) console.error(`  … et ${failures.length - MAX_FAILURES_SHOWN} autre(s)`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
