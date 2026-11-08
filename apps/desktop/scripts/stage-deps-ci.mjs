// Staging des dependances de release Windows dans la CI : contrepartie de stage-release-deps.ps1, sans poste local.
// Produit dans --out exactement les trois fichiers que le job fetch-deps de desktop-release.yml telecharge depuis la release :
//   ui.zip        : contenu du build web (apps/web/dist) sous ui/              -> ui/index.html, ui/assets/...
//   lastaddon.zip : lastaddon.cjs (services/core, npm run bundle) et node.exe sous lastaddon/
//   deps.json     : meme schema que stage-release-deps.ps1 (version, tag, builtAt, repos, files, nodeExe)
//
// Usage, depuis la racine du depot, apres les deux builds :
//   node apps/desktop/scripts/stage-deps-ci.mjs --version 1.0.33 --web-dist apps/web/dist \
//     --core-bundle services/core/dist-bundle --node-version v22.23.4 --node-sha256 <sha256> --out <dossier>
// Facultatifs : --commit <sha> (defaut : git rev-parse HEAD ; GITHUB_SHA n'est pas utilise, sur workflow_dispatch il designe
// le commit du workflow et non celui du tag publie), --branch <nom> (defaut : main, informatif).
//
// node.exe : telecharge https://nodejs.org/dist/<version>/win-x64/node.exe et refuse l'archive si son SHA-256 ne correspond pas
// a --node-sha256, puis si le fichier ne commence pas par la signature MZ. Origine enregistree dans deps.json = cette URL.
//
// Archives : bsdtar (libarchive) avec `tar -a -c -f <zip>`, qui ecrit un zip deflate aux entrees ui/... et lastaddon/...
// Choix : Windows livre aussi le tar GNU de Git Bash (/usr/bin/tar, devant System32 dans le PATH de Git Bash), qui n'ecrit
// pas de zip. On vise donc %SystemRoot%\System32\tar.exe et on refuse tout tar qui ne se presente pas comme bsdtar.
// Zip ecrit en JavaScript ecarte : il faudrait un CRC-32 et un writer maison, non eprouves par la CI.
//
// Versions recommandees (verifiees le 2026-11-07) : Node v22.23.4, derniere v22 LTS (https://nodejs.org/dist/index.json, publiee
// le 2026-10-20). SHA-256 de win-x64/node.exe : dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f
// (ligne de https://nodejs.org/dist/v22.23.4/SHASUMS256.txt, lue en HTTPS ; la signature GPG de ce fichier n'a pas ete verifiee).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Le bundle lastaddon est compile pour node22 (services/core/scripts/bundle.mjs) : le node.exe livre doit etre une v22.
const NODE_VERSION_RE = /^v22\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DEPS_FILES = ['ui.zip', 'lastaddon.zip', 'deps.json'];
const FLAGS = {
  version: '--version',
  webDist: '--web-dist',
  coreBundle: '--core-bundle',
  nodeVersion: '--node-version',
  nodeSha256: '--node-sha256',
  out: '--out',
  commit: '--commit',
  branch: '--branch',
};

/** URL officielle de node.exe (win-x64) pour une version v22.x.y. */
export function nodeExeUrl(nodeVersion) {
  if (!NODE_VERSION_RE.test(nodeVersion)) throw new Error(`Version Node invalide : ${nodeVersion} (attendu v22.x.y)`);
  return `https://nodejs.org/dist/${nodeVersion}/win-x64/node.exe`;
}

/** SHA-256 hexadecimal, minuscules, d'un tampon. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Compare le SHA-256 obtenu a la valeur attendue (casse indifferente). Leve une erreur explicite en cas d'ecart. */
export function checkSha256(actualHex, expectedHex, label) {
  const expected = String(expectedHex ?? '').trim().toLowerCase();
  if (!SHA256_RE.test(expected)) {
    throw new Error(`SHA-256 attendu de ${label} invalide : "${expectedHex}" (64 caracteres hexadecimaux attendus)`);
  }
  const actual = String(actualHex).toLowerCase();
  if (actual !== expected) {
    throw new Error(`SHA-256 de ${label} different du SHA-256 attendu : attendu ${expected}, obtenu ${actual}. Archive refusee.`);
  }
  return expected;
}

/** Un executable Windows commence par la signature MZ. */
export function checkPeExecutable(bytes, label) {
  if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`${label} n'est pas un executable Windows (en-tete MZ absent)`);
  }
}

/** Construit deps.json avec les memes cles, dans le meme ordre, que stage-release-deps.ps1. */
export function buildDeps({ version, builtAt, commit, branch = 'main', nodeVersion, nodeSha256, uiZip, addonZip }) {
  if (!VERSION_RE.test(version)) throw new Error(`Version invalide : ${version} (attendu X.Y.Z)`);
  if (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt))) throw new Error(`builtAt invalide : ${builtAt}`);
  if (!COMMIT_RE.test(commit)) throw new Error(`Commit invalide : ${commit} (40 caracteres hexadecimaux attendus)`);
  if (!SHA256_RE.test(nodeSha256)) throw new Error(`SHA-256 de node.exe invalide : ${nodeSha256}`);
  const nodeOrigin = nodeExeUrl(nodeVersion);
  for (const [name, z] of [['ui.zip', uiZip], ['lastaddon.zip', addonZip]]) {
    if (!SHA256_RE.test(z?.sha256 ?? '') || !Number.isSafeInteger(z?.size) || z.size < 0) {
      throw new Error(`Entree ${name} invalide : sha256 et size requis`);
    }
  }
  return {
    version,
    tag: `desktop-v${version}`,
    builtAt,
    repos: {
      'laststream-app': { branch, commit },
      lastaddon: { branch, commit },
    },
    files: {
      'ui.zip': { sha256: uiZip.sha256, size: uiZip.size },
      'lastaddon.zip': { sha256: addonZip.sha256, size: addonZip.size },
    },
    nodeExe: { version: nodeVersion, sha256: nodeSha256, origin: nodeOrigin },
  };
}

/** Candidats pour bsdtar. Sous Windows : tar.exe de System32, jamais le tar GNU qui precede parfois dans le PATH. */
export function bsdTarCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return ['tar'];
  return [win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')];
}

/** Premier candidat qui se presente comme bsdtar (libarchive), ou null. */
export function findBsdTar(options) {
  for (const bin of bsdTarCandidates(options)) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /bsdtar/i.test(r.stdout ?? '')) return bin;
  }
  return null;
}

/** Arguments de tar pour ecrire un zip : -a choisit le format d'apres l'extension .zip. Entrees relatives a stageDir. */
export function zipArgs(zipPath, stageDir, dirs) {
  return ['-a', '-c', '-f', zipPath, '-C', stageDir, ...dirs];
}

/** Ecrit un zip depuis les dossiers `dirs` de stageDir ; leve une erreur si tar echoue. */
export function createZip(tarBin, stageDir, zipPath, dirs) {
  rmSync(zipPath, { force: true });
  const r = spawnSync(tarBin, zipArgs(zipPath, stageDir, dirs), { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const cause = r.error?.message ?? `code ${r.status}`;
    throw new Error(`Creation de ${basename(zipPath)} echouee (${cause}) : ${(r.stderr ?? '').trim()}`);
  }
  return zipPath;
}

/** Liste les entrees d'un zip (tar -t). */
export function listZipEntries(tarBin, zipPath) {
  const r = spawnSync(tarBin, ['-t', '-f', zipPath], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`Lecture de ${basename(zipPath)} echouee : ${(r.stderr ?? r.error?.message ?? '').trim()}`);
  }
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Verifie qu'un zip ne contient que des entrees sous `prefix/` et contient toutes les entrees `required`. */
export function checkZipEntries(entries, { zipName, prefix, required }) {
  const stray = entries.filter((e) => !e.startsWith(`${prefix}/`));
  if (stray.length > 0) throw new Error(`${zipName} : entrees hors de ${prefix}/ : ${stray.slice(0, 3).join(', ')}`);
  const missing = required.filter((e) => !entries.includes(e));
  if (missing.length > 0) throw new Error(`${zipName} incomplet : absent ${missing.join(', ')}`);
}

/** --core-bundle : le dossier dist-bundle/ ou le fichier lastaddon.cjs directement. */
export function resolveCoreBundle(p) {
  if (!existsSync(p)) throw new Error(`--core-bundle introuvable : ${p} (sortie de "npm run bundle" dans services/core)`);
  if (statSync(p).isFile()) {
    if (basename(p) !== 'lastaddon.cjs') throw new Error(`--core-bundle : fichier lastaddon.cjs attendu, pas ${basename(p)}`);
    return p;
  }
  const file = join(p, 'lastaddon.cjs');
  if (!existsSync(file)) {
    throw new Error(`lastaddon.cjs absent de ${p} ("npm run bundle" dans services/core produit dist-bundle/lastaddon.cjs)`);
  }
  return file;
}

/** --web-dist doit contenir index.html (sortie de "npm run build" dans apps/web). */
export function checkWebDist(dir) {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`--web-dist sans index.html : ${dir} (lancer "npm run build" dans apps/web)`);
  }
}

/** Valide les options (CLI ou appel direct) et rend les chemins absolus. Leve une erreur explicite sinon. */
export function normalizeOptions(o) {
  for (const key of ['version', 'webDist', 'coreBundle', 'nodeVersion', 'nodeSha256', 'out']) {
    if (!o[key]) throw new Error(`Option ${FLAGS[key]} manquante`);
  }
  if (!VERSION_RE.test(o.version)) throw new Error(`${FLAGS.version} invalide : ${o.version} (attendu X.Y.Z)`);
  if (!NODE_VERSION_RE.test(o.nodeVersion)) {
    throw new Error(`${FLAGS.nodeVersion} invalide : ${o.nodeVersion} (attendu v22.x.y)`);
  }
  const nodeSha256 = String(o.nodeSha256).trim().toLowerCase();
  if (!SHA256_RE.test(nodeSha256)) throw new Error(`${FLAGS.nodeSha256} invalide : 64 caracteres hexadecimaux attendus`);
  if (o.commit !== undefined && !COMMIT_RE.test(o.commit)) throw new Error(`${FLAGS.commit} invalide : ${o.commit}`);
  return {
    version: o.version,
    webDist: resolve(o.webDist),
    coreBundle: resolve(o.coreBundle),
    nodeVersion: o.nodeVersion,
    nodeSha256,
    out: resolve(o.out),
    commit: o.commit,
    branch: o.branch ?? 'main',
    fetchNode: o.fetchNode,
    tarBin: o.tarBin,
    builtAt: o.builtAt,
  };
}

/** Lit les options de la ligne de commande (voir l'en-tete du fichier). */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      version: { type: 'string' },
      'web-dist': { type: 'string' },
      'core-bundle': { type: 'string' },
      'node-version': { type: 'string' },
      'node-sha256': { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'string' },
      branch: { type: 'string' },
    },
  });
  return normalizeOptions({
    version: values.version,
    webDist: values['web-dist'],
    coreBundle: values['core-bundle'],
    nodeVersion: values['node-version'],
    nodeSha256: values['node-sha256'],
    out: values.out,
    commit: values.commit,
    branch: values.branch,
  });
}

/** Commit courant (git rev-parse HEAD), utilise quand --commit est absent. */
export function gitHead(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('Commit introuvable (git rev-parse HEAD a echoue) : passer --commit <sha>');
  }
}

/** Telecharge node.exe (un appel, delai maximal de 5 minutes). Renvoie les octets. */
export async function downloadNodeExe(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Telechargement de ${url} echoue : HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function zipInfo(path) {
  return { sha256: sha256Hex(readFileSync(path)), size: statSync(path).size };
}

/**
 * Produit ui.zip, lastaddon.zip et deps.json dans opts.out. Ordre : verifications locales, node.exe (SHA-256 et signature MZ),
 * puis les zip et deps.json. En cas d'erreur, les trois fichiers de sortie sont retires : jamais de sortie partielle.
 */
export async function stageDeps(rawOptions) {
  const o = normalizeOptions(rawOptions);
  const bundleFile = resolveCoreBundle(o.coreBundle);
  checkWebDist(o.webDist);

  const nodeBytes = await (o.fetchNode ?? downloadNodeExe)(nodeExeUrl(o.nodeVersion));
  checkSha256(sha256Hex(nodeBytes), o.nodeSha256, `node.exe (${o.nodeVersion})`);
  checkPeExecutable(nodeBytes, 'node.exe');

  const tarBin = o.tarBin ?? findBsdTar();
  if (!tarBin) throw new Error('bsdtar introuvable : tar.exe de System32 (ou un bsdtar du PATH) requis pour ecrire les zip');
  const commit = o.commit ?? gitHead();
  const builtAt = o.builtAt ?? new Date().toISOString();

  mkdirSync(o.out, { recursive: true });
  const outputs = DEPS_FILES.map((f) => join(o.out, f));
  for (const f of outputs) rmSync(f, { force: true });

  const stage = mkdtempSync(join(tmpdir(), 'stage-deps-'));
  try {
    cpSync(o.webDist, join(stage, 'ui'), { recursive: true });
    mkdirSync(join(stage, 'lastaddon'));
    copyFileSync(bundleFile, join(stage, 'lastaddon', 'lastaddon.cjs'));
    writeFileSync(join(stage, 'lastaddon', 'node.exe'), nodeBytes);

    const uiZip = createZip(tarBin, stage, join(o.out, 'ui.zip'), ['ui']);
    const addonZip = createZip(tarBin, stage, join(o.out, 'lastaddon.zip'), ['lastaddon']);
    checkZipEntries(listZipEntries(tarBin, uiZip), {
      zipName: 'ui.zip', prefix: 'ui', required: ['ui/index.html'],
    });
    checkZipEntries(listZipEntries(tarBin, addonZip), {
      zipName: 'lastaddon.zip', prefix: 'lastaddon', required: ['lastaddon/lastaddon.cjs', 'lastaddon/node.exe'],
    });

    const deps = buildDeps({
      version: o.version,
      builtAt,
      commit,
      branch: o.branch,
      nodeVersion: o.nodeVersion,
      nodeSha256: o.nodeSha256,
      uiZip: zipInfo(uiZip),
      addonZip: zipInfo(addonZip),
    });
    writeFileSync(join(o.out, 'deps.json'), `${JSON.stringify(deps, null, 2)}\n`, 'utf8');
    return deps;
  } catch (err) {
    for (const f of outputs) rmSync(f, { force: true });
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const deps = await stageDeps(opts);
    console.log(
      `Archives pretes dans ${opts.out} : ui.zip (${deps.files['ui.zip'].size} o), `
      + `lastaddon.zip (${deps.files['lastaddon.zip'].size} o), deps.json (tag ${deps.tag}).`,
    );
  } catch (err) {
    console.error(`stage-deps-ci : ${err.message}`);
    process.exitCode = 1;
  }
}
