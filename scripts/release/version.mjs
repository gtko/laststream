// Version de release Laststream : calcul du prochain X.Y.Z selon les labels de PR, et réécriture synchronisée de
// apps/desktop/Cargo.toml, Cargo.lock et setup/Laststream.iss (contrôlée par apps/desktop/scripts/windows-manifest.mjs),
// ainsi que apps/tauri/src-tauri/Cargo.toml et Cargo.lock (coque Tauri : son updater compare cette version).
//   node scripts/release/version.mjs --labels "release:minor,Feature" [--last-tag v1.0.32] [--write]
// Affiche la nouvelle version sur stdout ; --write réécrit les trois fichiers. Aucune dépendance npm.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'laststream-shell-ng';
const CARGO_TOML = join('apps', 'desktop', 'Cargo.toml');
const CARGO_LOCK = join('apps', 'desktop', 'Cargo.lock');
const ISS = join('apps', 'desktop', 'setup', 'Laststream.iss');
const TAURI_PACKAGE = 'laststream-tauri';
const TAURI_TOML = join('apps', 'tauri', 'src-tauri', 'Cargo.toml');
const TAURI_LOCK = join('apps', 'tauri', 'src-tauri', 'Cargo.lock');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lit en latin1 : octet pour octet, donc les fins de ligne CRLF et tout autre contenu sont conservés. */
const readText = (file) => readFileSync(file, 'latin1');

/** Décompose X.Y.Z strict (pas de zéro en tête) ; lève une erreur sinon. */
function parseSemver(version, what) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!m) throw new Error(`${what} invalide : ${version} (attendu X.Y.Z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Prochaine version : release:major > release:minor > patch. */
export function nextVersion(current, labels = []) {
  const [major, minor, patch] = parseSemver(current, 'Version courante');
  const set = new Set(labels);
  if (set.has('release:major')) return `${major + 1}.0.0`;
  if (set.has('release:minor')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Section [package] de Cargo.toml : bornes (début après l'en-tête, fin avant la section suivante). */
function packageSection(toml) {
  const header = /^\[package\][ \t]*\r?$/m.exec(toml);
  if (!header) throw new Error('Section [package] introuvable dans Cargo.toml');
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(toml.slice(start));
  return { start, end: next ? start + next.index : toml.length };
}

const PACKAGE_VERSION_RE = /^(version[ \t]*=[ \t]*")([^"\r\n]*)(")/m;

/** Version de la section [package] de Cargo.toml (texte fourni). */
export function readCargoVersion(toml) {
  const { start, end } = packageSection(toml);
  const m = PACKAGE_VERSION_RE.exec(toml.slice(start, end));
  if (!m) throw new Error('Version introuvable dans la section [package] de Cargo.toml');
  parseSemver(m[2], 'Version de Cargo.toml');
  return m[2];
}

/** Version courante : celle du tag `vX.Y.Z` si fourni, sinon celle de apps/desktop/Cargo.toml. */
export function readCurrentVersion(repoRoot, lastTag) {
  if (lastTag) {
    const m = /^v(.+)$/.exec(lastTag);
    if (!m) throw new Error(`Tag invalide : ${lastTag} (attendu vX.Y.Z)`);
    parseSemver(m[1], 'Tag');
    return m[1];
  }
  return readCargoVersion(readText(join(repoRoot, CARGO_TOML)));
}

function setCargoVersion(toml, version) {
  const { start, end } = packageSection(toml);
  const section = toml.slice(start, end);
  if (!PACKAGE_VERSION_RE.test(section)) throw new Error('Version introuvable dans la section [package] de Cargo.toml');
  return toml.slice(0, start) + section.replace(PACKAGE_VERSION_RE, `$1${version}$3`) + toml.slice(end);
}

const lockEntryRe = (name) => new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")[^"\\r\\n]*(")`, 'g');

function setLockVersion(lock, version, name = PACKAGE) {
  const re = lockEntryRe(name);
  if ([...lock.matchAll(re)].length !== 1) {
    throw new Error(`Entrée ${name} introuvable (ou en double) dans Cargo.lock`);
  }
  return lock.replace(re, `$1${version}$2`);
}

const ISS_VERSION_RE = /^(#define[ \t]+MyAppVersion[ \t]+")[^"\r\n]*(")/gm;

function setIssVersion(iss, version) {
  if ([...iss.matchAll(ISS_VERSION_RE)].length !== 1) {
    throw new Error('#define MyAppVersion introuvable (ou en double) dans setup/Laststream.iss');
  }
  return iss.replace(ISS_VERSION_RE, `$1${version}$2`);
}

/**
 * Réécrit la version dans Cargo.toml ([package] seulement), Cargo.lock (ligne version du paquet seulement) et
 * setup/Laststream.iss (#define MyAppVersion), puis dans le Cargo.toml / Cargo.lock de la coque Tauri s'ils existent. Tout est calculé avant la première écriture : en cas d'erreur, rien n'est modifié.
 */
export function writeVersion(repoRoot, version) {
  const [, minor, patch] = parseSemver(version, 'Nouvelle version');
  if (minor > 999 || patch > 999) {
    throw new Error(`Version hors plage : ${version} (minor et patch <= 999, voir windows-manifest.mjs)`);
  }
  const files = { toml: join(repoRoot, CARGO_TOML), lock: join(repoRoot, CARGO_LOCK), iss: join(repoRoot, ISS) };
  const before = { toml: readText(files.toml), lock: readText(files.lock), iss: readText(files.iss) };
  const after = {
    toml: setCargoVersion(before.toml, version),
    lock: setLockVersion(before.lock, version),
    iss: setIssVersion(before.iss, version),
  };
  // Coque Tauri, si présente : même version.
  if (existsSync(join(repoRoot, TAURI_TOML))) {
    files.tauriToml = join(repoRoot, TAURI_TOML);
    files.tauriLock = join(repoRoot, TAURI_LOCK);
    before.tauriToml = readText(files.tauriToml);
    before.tauriLock = readText(files.tauriLock);
    after.tauriToml = setCargoVersion(before.tauriToml, version);
    after.tauriLock = setLockVersion(before.tauriLock, version, TAURI_PACKAGE);
  }
  for (const key of Object.keys(files)) {
    if (after[key] !== before[key]) writeFileSync(files[key], after[key], 'latin1');
  }
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  // Windows PowerShell 5.1 supprime un argument vide : `--labels --write` ne doit pas lire `--write` comme valeur.
  return value?.startsWith('--') ? undefined : value;
}

function main(args) {
  const labels = (argValue(args, '--labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const current = readCurrentVersion(ROOT, argValue(args, '--last-tag'));
  const next = nextVersion(current, labels);
  if (args.includes('--write')) writeVersion(ROOT, next);
  return next;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
