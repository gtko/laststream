// Paquet .ipk webOS, sans dépendance (LAST-1643) : le format que produit `ares-package` du SDK LG, que la TV installe.
// Archive ar contenant, dans cet ordre : debian-binary ("2.0\n"), control.tar.gz (fichier control) et data.tar.gz (l'app sous
// usr/palm/applications/<id>/ et sa fiche usr/palm/packages/<id>/packageinfo.json). Tar au format ustar, propriétaire root, chemins
// sans "./" comme ceux d'ares-package (node-tar).
import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

/** En-tête ustar d'une entrée (fichier ou dossier). Les chemins de plus de 100 octets passent par le champ prefix. */
function tarHeader(path, { size, mode, type, mtime }) {
  const h = Buffer.alloc(BLOCK, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`Chemin trop long pour l'archive : ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.fill(' ', 148, 156); // somme de contrôle : espaces pendant le calcul
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 'ascii');
  h.write('root', 297, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/**
 * Archive tar.gz. Les dossiers parents sont ajoutés d'eux-mêmes.
 * @param {{ path: string, data: Buffer, mode?: number }[]} files
 * @param {number} mtime  secondes depuis l'époque Unix
 */
export function tarGz(files, mtime) {
  const parts = [];
  const dirs = new Set();
  const addDir = (dir) => {
    if (!dir || dirs.has(dir)) return;
    addDir(dir.split('/').slice(0, -1).join('/'));
    dirs.add(dir);
    parts.push(tarHeader(`${dir}/`, { size: 0, mode: 0o755, type: '5', mtime }));
  };
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    addDir(f.path.split('/').slice(0, -1).join('/'));
    parts.push(tarHeader(f.path, { size: f.data.length, mode: f.mode ?? 0o644, type: '0', mtime }));
    parts.push(f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Archive ar (format commun de dpkg/opkg) : en-têtes de 60 octets, contenus alignés sur 2 octets. */
export function ar(members, mtime) {
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  for (const m of members) {
    if (m.name.length > 16) throw new Error(`Nom trop long pour ar : ${m.name}`);
    const h = m.name.padEnd(16) + String(mtime).padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(m.data.length).padEnd(10) + '`\n';
    parts.push(Buffer.from(h, 'ascii'), m.data);
    if (m.data.length % 2) parts.push(Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(parts);
}

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Construit le .ipk d'une app web webOS.
 * @param {{ appinfo: Record<string, unknown>, files: { path: string, data: Buffer }[], mtime?: number }} opts  `files` : contenu
 *   du dossier de l'app (appinfo.json compris), chemins relatifs à ce dossier
 */
export function buildIpk({ appinfo, files, mtime = 0 }) {
  const id = String(appinfo.id || '');
  const version = String(appinfo.version || '');
  if (!ID_RE.test(id)) throw new Error(`Identifiant d'app invalide : "${id}" (minuscules, chiffres, points)`);
  if (!VERSION_RE.test(version)) throw new Error(`Version invalide : "${version}" (format X.Y.Z attendu)`);
  if (!files.some((f) => f.path === 'appinfo.json')) throw new Error('appinfo.json manquant');
  // Même fiche qu'ares-package : identifiant du paquet, version, app qu'il contient.
  const packageinfo = { id, version, app: id };
  const vendor = String(appinfo.vendor || 'N/A');
  const title = String(appinfo.title || id);
  const data = [
    ...files.map((f) => ({ path: `usr/palm/applications/${id}/${f.path}`, data: f.data })),
    { path: `usr/palm/packages/${id}/packageinfo.json`, data: Buffer.from(JSON.stringify(packageinfo, null, 2) + '\n') },
  ];
  const installedSize = data.reduce((n, f) => n + f.data.length, 0);
  const control = [
    `Package: ${id}`,
    `Version: ${version}`,
    'Section: misc',
    'Priority: optional',
    'Architecture: all',
    `Installed-Size: ${installedSize}`,
    `Maintainer: ${vendor} <nobody@laststream.app>`,
    `Description: ${title}`,
    'webOS-Package-Format-Version: 2',
    'webOS-Packager-Version: 1.0.0',
    '',
  ].join('\n');
  return ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') },
    { name: 'control.tar.gz', data: tarGz([{ path: 'control', data: Buffer.from(control) }], mtime) },
    { name: 'data.tar.gz', data: tarGz(data, mtime) },
  ], mtime);
}
