import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  MAX_TORRENT_BYTES,
  TorrentFormatError,
  parseTorrent,
} from '../src/torrent/bencode.js';
import { bdict, bint, blist, bstr, monoTorrent, packTorrent } from './torrent-fixtures.js';

// Vecteurs calculés hors du code testé (sha1sum) :
//   sha1("abc") : FIPS 180-1 ; info « d6:lengthi3e4:name3:abce » ; info non trié « d4:name3:abc6:lengthi3ee ».
const SHA1_ABC = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const INFO_MONO_HASH = '9657bd8853fb7dbe97ee66bd828aa7ec85f26231';
const INFO_UNSORTED_HASH = 'e84fd22dac533d23bebf912d51c21c2291798312';
const SECRET = 'PASSKEY-SECRET-7731';

/** Texte latin1 vers octets : pour les entrées malformées écrites à la main. */
function raw(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

function expectMalformed(input: Uint8Array): void {
  let caught: unknown;
  try {
    parseTorrent(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TorrentFormatError);
  expect((caught as TorrentFormatError).code).toBe('malformed');
}

describe('SHA-1 de référence', () => {
  it('le vecteur FIPS 180-1 de « abc » donne a9993e36…', () => {
    expect(createHash('sha1').update('abc').digest('hex')).toBe(SHA1_ABC);
  });
});

describe('parseTorrent : infoHash et extraction', () => {
  it('infoHash = SHA-1 des octets bruts du dictionnaire info (vecteur de référence), mono-fichier', () => {
    const info = parseTorrent(monoTorrent({ name: 'abc', length: 3 }));

    expect(info.infoHash).toBe(INFO_MONO_HASH);
    expect(info.name).toBe('abc');
    expect(info.private).toBe(false);
    expect(info.files).toEqual([{ idx: 0, path: 'abc', size: 3 }]);
    expect(info.totalSize).toBe(3);
  });

  it('info non canonique (clés non triées) : hash sur les octets reçus, pas sur une réécriture triée', () => {
    const unsorted = bdict(['name', bstr('abc')], ['length', bint(3)]);
    const torrent = bdict(['info', unsorted]);

    const info = parseTorrent(torrent);

    expect(info.infoHash).toBe(INFO_UNSORTED_HASH);
    expect(info.infoHash).not.toBe(INFO_MONO_HASH);
    expect(info.files).toEqual([{ idx: 0, path: 'abc', size: 3 }]);
  });

  it('le hash ne dépend que du dictionnaire info : announce et autres clés racine sont sans effet', () => {
    const plain = parseTorrent(monoTorrent());
    const withAnnounce = parseTorrent(monoTorrent({ announce: 'https://tracker.example/announce' }));

    expect(withAnnounce.infoHash).toBe(plain.infoHash);
  });

  it('accepte une entrée Uint8Array (non Buffer) avec le même résultat', () => {
    const buf = monoTorrent();
    const view = new Uint8Array(buf);

    expect(parseTorrent(view).infoHash).toBe(INFO_MONO_HASH);
  });

  it('drapeau privé : info.private = 1 ; toute autre valeur donne false ; le hash inclut la clé private', () => {
    const priv = parseTorrent(monoTorrent({ private: true }));
    const notPriv = parseTorrent(monoTorrent({ private: false }));

    expect(priv.private).toBe(true);
    expect(notPriv.private).toBe(false);
    const infoWithPrivate = bdict(['length', bint(3)], ['name', bstr('abc')], ['private', bint(1)]);
    expect(priv.infoHash).toBe(createHash('sha1').update(infoWithPrivate).digest('hex'));
    expect(priv.infoHash).not.toBe(INFO_MONO_HASH);
  });

  it('private = 2 (ou chaîne) n’est pas un torrent privé', () => {
    const torrent = bdict(['info', bdict(['length', bint(3)], ['name', bstr('abc')], ['private', bint(2)])]);

    expect(parseTorrent(torrent).private).toBe(false);
  });

  it('multi-fichiers : ordre d’apparition, idx, tailles et total', () => {
    const torrent = packTorrent(
      [
        { path: ['S01E01.mkv'], length: 100 },
        { path: ['Extras', 'bonus.mp4'], length: 50 },
        { path: ['S01E02.mkv'], length: 200 },
      ],
      { name: 'Serie' },
    );

    const info = parseTorrent(torrent);

    expect(info.name).toBe('Serie');
    expect(info.files).toEqual([
      { idx: 0, path: 'S01E01.mkv', size: 100 },
      { idx: 1, path: 'Extras/bonus.mp4', size: 50 },
      { idx: 2, path: 'S01E02.mkv', size: 200 },
    ]);
    expect(info.totalSize).toBe(350);
  });

  it('chemins UTF-8 : path.utf-8 prime sur path ; nom name.utf-8 prime sur name', () => {
    const torrent = bdict([
      'info',
      bdict(
        ['files', blist(bdict(['length', bint(7)], ['path', blist(bstr('x'))], ['path.utf-8', blist(bstr('dossier'), bstr('fichier é.mp4'))]))],
        ['name', bstr('nom-ascii')],
        ['name.utf-8', bstr('Séries été')],
      ),
    ]);

    const info = parseTorrent(torrent);

    expect(info.name).toBe('Séries été');
    expect(info.files).toEqual([{ idx: 0, path: 'dossier/fichier é.mp4', size: 7 }]);
  });

  it('chemins : segments . et .. ignorés (pas de remontée), caractères de contrôle retirés', () => {
    const torrent = packTorrent([{ path: ['..', '..', 'etc', 'a\u0001b.mkv', '.'], length: 1 }]);

    expect(parseTorrent(torrent).files[0]?.path).toBe('etc/ab.mkv');
  });

  it('chemin vide après nettoyage : nom de repli fichier-N', () => {
    const torrent = packTorrent([{ path: ['..'], length: 1 }]);

    expect(parseTorrent(torrent).files[0]?.path).toBe('fichier-1');
  });

  it('announce et announce-list ne sont jamais retournés (elles portent la passkey)', () => {
    const torrent = monoTorrent({ announce: `https://tracker.example/announce?passkey=${SECRET}` });
    const info = parseTorrent(torrent);

    expect(Object.keys(info).sort()).toEqual(['files', 'infoHash', 'name', 'private', 'totalSize']);
    expect(JSON.stringify(info)).not.toContain(SECRET);
  });
});

describe('parseTorrent : entrées malformées (erreur typée, message sans contenu)', () => {
  const info = 'd6:lengthi3e4:name3:abce';
  const malformedCases: [string, string][] = [
    ['entier négatif zéro', 'd4:infod6:lengthi-0e4:name3:abcee'],
    ['entier à zéro de tête', 'd4:infod6:lengthi03e4:name3:abcee'],
    ['entier vide', 'd4:infod6:lengthie4:name3:abcee'],
    ['entier hors limites sûres', 'd4:infod6:lengthi9007199254740993e4:name3:abcee'],
    ['chaîne tronquée', 'd4:infod6:lengthi3e4:name10:abcee'],
    ['clé dupliquée (info deux fois)', `d4:info${info}4:info${info}e`],
    ['données en trop après le torrent', `d4:info${info}ex`],
    ['dictionnaire info absent', 'd3:fooi1ee'],
    ['info non dictionnaire', 'd4:infoi1ee'],
    ['clé de dictionnaire non chaîne', `di1ei2ed4:info${info}e`],
    ['nom absent', 'd4:infod6:lengthi3eee'],
    ['taille absente (ni length ni files)', 'd4:infod4:name3:abcee'],
    ['taille de fichier négative', 'd4:infod5:filesld6:lengthi-1e4:pathl1:aeee4:name3:abcee'],
    ['segment de chemin non chaîne', 'd4:infod5:filesld6:lengthi1e4:pathli1eeee4:name3:abcee'],
    ['racine non dictionnaire', 'li1ee'],
    ['type inconnu', 'd4:infox'],
    ['entrée vide', ''],
  ];

  it.each(malformedCases)('%s', (_label, text) => {
    expectMalformed(raw(text));
  });

  it('trop de fichiers : too_many_files', () => {
    const entry = bdict(['length', bint(0)], ['path', blist(bstr('a'))]);
    const files = Array.from({ length: MAX_FILES + 1 }, () => entry);
    const torrent = bdict(['info', bdict(['files', blist(...files)], ['name', bstr('pack')])]);

    let caught: unknown;
    try {
      parseTorrent(torrent);
    } catch (err) {
      caught = err;
    }
    expect((caught as TorrentFormatError).code).toBe('too_many_files');
  });

  it('plus de 5 Mo : too_large, sans lecture', () => {
    const big = Buffer.alloc(MAX_TORRENT_BYTES + 1, 0x30);

    let caught: unknown;
    try {
      parseTorrent(big);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TorrentFormatError);
    expect((caught as TorrentFormatError).code).toBe('too_large');
  });

  it('profondeur : 32 niveaux acceptés (la racine est une liste, donc malformée), 33 refusés en too_deep', () => {
    const nested = (depth: number): Buffer => raw('l'.repeat(depth) + 'e'.repeat(depth));

    expectMalformed(nested(32));
    let caught: unknown;
    try {
      parseTorrent(nested(33));
    } catch (err) {
      caught = err;
    }
    expect((caught as TorrentFormatError).code).toBe('too_deep');
  });

  it('le message d’erreur ne reprend jamais le contenu du fichier', () => {
    const text = `d4:infod6:lengthi-0e4:name3:abce8:passkey${SECRET}e`;
    let message = '';
    try {
      parseTorrent(raw(text));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(SECRET);
  });
});

describe('bencode : valeurs acceptées', () => {
  it('taille 0 est valide', () => {
    const torrent = bdict(['info', bdict(['length', bint(0)], ['name', bstr('z')])]);

    expect(parseTorrent(torrent).totalSize).toBe(0);
  });

  it('listes de fichiers imbriquées dans un dictionnaire inconnu sont ignorées sans erreur', () => {
    const torrent = bdict(
      ['info', bdict(['length', bint(2)], ['name', bstr('n')], ['pieces', bstr(Buffer.alloc(40))], ['x', blist(bint(1))])],
    );

    expect(parseTorrent(torrent).files).toEqual([{ idx: 0, path: 'n', size: 2 }]);
  });
});
