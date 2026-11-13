// Flux de mise à jour de la coque Tauri pour une plateforme (même format que le flux Windows, lu par updater.rs) :
//   node scripts/tauri-feed.mjs --platform macos-aarch64 --version 1.2.3 --file Laststream-1.2.3-macos-aarch64.app.tar.gz --out tauri-macos-aarch64-latest.json
// `versionDesc` est l'adresse du flux lui-même (pas de descripteur séparé à télécharger). Le Worker laststream-edge sert le
// flux et le fichier sous https://app.laststream.app/app/tauri/<plateforme>/ depuis la release GitHub ; le flux est ensuite
// signé par apps/desktop/scripts/sign-update.mjs (même clé ed25519 que la coque Windows).
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const PLATFORMS = { 'macos-aarch64': 'app.tar.gz', 'macos-x86_64': 'app.tar.gz', 'windows-x86_64': 'setup.exe' };

export function buildFeed({ platform, version, file, bytes, size, publishedAt }) {
  const ext = PLATFORMS[platform];
  if (!ext) throw new Error(`Plateforme inconnue : ${platform}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version invalide : ${version}`);
  const name = basename(file);
  if (name !== `Laststream-${version}-${platform}.${ext}`) throw new Error(`Nom de fichier inattendu : ${name}`);
  const base = `https://app.laststream.app/app/tauri/${platform}/`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const os = platform.split('-')[0];
  return {
    version,
    versionName: version,
    versionDesc: `${base}latest.json`,
    publishedAt,
    url: `${base}${name}`,
    sha256,
    size,
    files: [{ name, url: `${base}${name}`, checksum: sha256, os }],
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`--${name} manquant`);
  return process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = arg('file');
  const feed = buildFeed({
    platform: arg('platform'),
    version: arg('version'),
    file,
    bytes: readFileSync(file),
    size: statSync(file).size,
    publishedAt: new Date().toISOString(),
  });
  writeFileSync(arg('out'), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`${arg('out')} : ${feed.version} ${feed.url}`);
}
