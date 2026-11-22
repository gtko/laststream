#!/usr/bin/env node
// Construit l'app LG webOS : dist/Laststream-<version>-webos.ipk (LAST-1643).
//   node scripts/build-ipk.mjs [--version X.Y.Z] [--out dist]
// Sans --version : variable VERSION, sinon version de l'app Tauri (apps/tauri/src-tauri/Cargo.toml, montée à chaque release).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIpk } from './ipk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function tauriVersion() {
  const cargo = readFileSync(join(root, '..', 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
  const m = /^\s*\[package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/m.exec(cargo);
  if (!m) throw new Error('Version introuvable dans apps/tauri/src-tauri/Cargo.toml');
  return m[1];
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const version = arg('version') || process.env.VERSION || tauriVersion();
const outDir = resolve(arg('out') || join(root, 'dist'));
const appinfo = { ...JSON.parse(readFileSync(join(appDir, 'appinfo.json'), 'utf8')), version };
const files = walk(appDir).map((p) => {
  const path = relative(appDir, p).split('\\').join('/');
  return { path, data: path === 'appinfo.json' ? Buffer.from(JSON.stringify(appinfo, null, 2) + '\n') : readFileSync(p) };
});
// Date fixe (celle du commit en CI, sinon maintenant) : deux builds du même commit donnent le même fichier.
const mtime = Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.now() / 1000);
const ipk = buildIpk({ appinfo, files, mtime });
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `Laststream-${version}-webos.ipk`);
writeFileSync(out, ipk);
console.log(`${out} (${ipk.length} octets, ${appinfo.id} ${version})`);
