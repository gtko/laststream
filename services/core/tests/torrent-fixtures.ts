/** Constructeurs bencode pour les tests : torrents construits en code, octets exacts, ordre des clés conservé. */

/** Chaîne d'octets : `<longueur>:<octets>`. */
export function bstr(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`, 'latin1'), bytes]);
}

/** Entier : `i<valeur>e`, valeur brute (permet de tester les formes non canoniques). */
export function bint(value: number | string): Buffer {
  return Buffer.from(`i${value}e`, 'latin1');
}

export function blist(...items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from('l', 'latin1'), ...items, Buffer.from('e', 'latin1')]);
}

/** Dictionnaire dont les clés sont écrites dans l'ordre donné (non trié si besoin). */
export function bdict(...entries: [string, Buffer][]): Buffer {
  return Buffer.concat([
    Buffer.from('d', 'latin1'),
    ...entries.flatMap(([key, value]) => [bstr(key), value]),
    Buffer.from('e', 'latin1'),
  ]);
}

/** Torrent mono-fichier (info : length, name). Le hash est celui de `info` seul. */
export function monoTorrent(
  opts: { name?: string; length?: number; private?: boolean; announce?: string } = {},
): Buffer {
  const infoEntries: [string, Buffer][] = [
    ['length', bint(opts.length ?? 3)],
    ['name', bstr(opts.name ?? 'abc')],
  ];
  if (opts.private !== undefined) infoEntries.push(['private', bint(opts.private ? 1 : 0)]);
  const info = bdict(...infoEntries);
  const root: [string, Buffer][] = [];
  if (opts.announce !== undefined) root.push(['announce', bstr(opts.announce)]);
  root.push(['info', info]);
  return bdict(...root);
}

/** Torrent multi-fichiers : `files` dans l'ordre donné, chemin en segments. */
export function packTorrent(
  files: { path: string[]; length: number; utf8Path?: string[] }[],
  opts: { name?: string; private?: boolean; announce?: string } = {},
): Buffer {
  const fileDicts = files.map((file) => {
    const entries: [string, Buffer][] = [['length', bint(file.length)], ['path', blist(...file.path.map((p) => bstr(p)))]];
    if (file.utf8Path !== undefined) entries.push(['path.utf-8', blist(...file.utf8Path.map((p) => bstr(p)))]);
    return bdict(...entries);
  });
  const infoEntries: [string, Buffer][] = [
    ['files', blist(...fileDicts)],
    ['name', bstr(opts.name ?? 'pack')],
  ];
  if (opts.private !== undefined) infoEntries.push(['private', bint(opts.private ? 1 : 0)]);
  const root: [string, Buffer][] = [];
  if (opts.announce !== undefined) root.push(['announce', bstr(opts.announce)]);
  root.push(['info', bdict(...infoEntries)]);
  return bdict(...root);
}
