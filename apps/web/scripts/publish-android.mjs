#!/usr/bin/env node
/* Prépare la mise à jour en un tap de l'application Android.
 *
 *   node scripts/publish-android.mjs [--apk <fichier.apk>] [--meta <output-metadata.json>] [--notes "texte"]
 *                                    [--base-url <https://…/app/android>] [--out <dossier>] [--stage <dossier>]
 *
 * - lit versionCode / versionName dans output-metadata.json (écrit par Gradle à côté de l'APK) ;
 * - calcule le SHA-256 et la taille de l'APK ;
 * - écrit <out>/latest.json  (par défaut public/app/android/ : servi par le Worker au prochain déploiement) ;
 * - copie l'APK sous <stage>/laststream-<versionCode>.apk (par défaut ../dist/laststream-android/publish/).
 *
 * L'APK (≈ 50 Mo) dépasse la limite de 25 Mo par fichier des Workers Assets : elle ne va PAS dans public/.
 * Elle doit être servie à l'adresse `url` du manifeste (par défaut <base-url>/laststream-<versionCode>.apk), par exemple depuis
 * un bucket R2 public derrière le Worker. Ne déploie rien lui-même. */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://laststream.gtux-prog.workers.dev/app/android';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { out[key] = true; continue; }
    out[key] = val;
    i += 1;
  }
  return out;
}

/** Hexadécimal minuscule du SHA-256 d'un fichier (lecture en flux : l'APK fait plusieurs dizaines de Mo). */
export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

/** versionCode et versionName du premier élément de output-metadata.json. */
export function readMeta(json) {
  const el = json && Array.isArray(json.elements) ? json.elements[0] : null;
  const versionCode = Number(el && el.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('versionCode introuvable dans output-metadata.json');
  return { versionCode, versionName: String((el && el.versionName) || versionCode) };
}

/** Contenu de latest.json. */
export function buildManifest({ versionCode, versionName, sha256, size, baseUrl = DEFAULT_BASE_URL, notes = '' }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 invalide');
  const base = baseUrl.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('--base-url doit être en https');
  return {
    versionCode,
    versionName,
    url: `${base}/laststream-${versionCode}.apk`,
    sha256,
    size,
    notes: String(notes || '').trim(),
  };
}

export async function publish(opts = {}) {
  const apk = resolve(opts.apk || join(root, '..', 'dist', 'laststream-android', 'laststream-release.apk'));
  const meta = resolve(opts.meta || join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'output-metadata.json'));
  const out = resolve(opts.out || join(root, 'public', 'app', 'android'));
  const stage = resolve(opts.stage || join(root, '..', 'dist', 'laststream-android', 'publish'));
  if (!existsSync(apk)) throw new Error(`APK introuvable : ${apk}`);
  if (!existsSync(meta)) throw new Error(`output-metadata.json introuvable : ${meta}`);
  const { versionCode, versionName } = readMeta(JSON.parse(readFileSync(meta, 'utf8')));
  const sha256 = await sha256File(apk);
  const manifest = buildManifest({ versionCode, versionName, sha256, size: statSync(apk).size, baseUrl: opts['base-url'] || opts.baseUrl, notes: opts.notes });
  mkdirSync(out, { recursive: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const staged = join(stage, `laststream-${versionCode}.apk`);
  copyFileSync(apk, staged);
  return { manifest, latest: join(out, 'latest.json'), staged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publish(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`latest.json  : ${r.latest}`);
    console.log(`APK à servir : ${r.staged}`);
    console.log(`  → ${r.manifest.url}`);
    console.log(`versionCode ${r.manifest.versionCode} (${r.manifest.versionName}), ${r.manifest.size} octets, sha256 ${r.manifest.sha256}`);
    console.log('À faire : servir l’APK à cette adresse (R2 public derrière le Worker), puis déployer public/app/android/latest.json avec l’application.');
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
