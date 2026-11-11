#!/usr/bin/env python3
"""SHA-256 du certificat du premier signataire d'un APK (bloc de signature v3, sinon v2), en hexadécimal minuscule.

Même empreinte que `keytool -list -v` (SHA256 du certificat DER) : la release compare les deux pour vérifier que l'APK est
signé avec la clé de publication. Sans dépendance (Python standard).
"""
import hashlib
import struct
import sys

V2, V3 = 0x7109871A, 0xF05368C0


def lp(buf, off):
    """Bloc préfixé par sa longueur (uint32 little-endian) : (contenu, position suivante)."""
    n = struct.unpack_from('<I', buf, off)[0]
    return buf[off + 4:off + 4 + n], off + 4 + n


def first_cert_sha256(path):
    data = open(path, 'rb').read()
    eocd = data.rfind(b'PK\x05\x06')
    if eocd < 0:
        raise ValueError('pas une archive zip')
    cd = struct.unpack_from('<I', data, eocd + 16)[0]
    if data[cd - 16:cd] != b'APK Sig Block 42':
        raise ValueError('pas de bloc de signature v2/v3')
    size = struct.unpack_from('<Q', data, cd - 24)[0]
    pos, end, blocks = cd - size - 8 + 8, cd - 24, {}
    while pos < end:
        n, bid = struct.unpack_from('<QI', data, pos)
        blocks[bid] = data[pos + 12:pos + 8 + n]
        pos += 8 + n
    for bid in (V3, V2):
        if bid in blocks:
            signers, _ = lp(blocks[bid], 0)
            signer, _ = lp(signers, 0)
            signed, _ = lp(signer, 0)
            _, off = lp(signed, 0)  # digests
            certs, _ = lp(signed, off)
            cert, _ = lp(certs, 0)
            return hashlib.sha256(cert).hexdigest()
    raise ValueError('aucun signataire v2/v3')


if __name__ == '__main__':
    print(first_cert_sha256(sys.argv[1]))
