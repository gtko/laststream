// Protocole binaire des plages : aller-retour, découpage en morceaux, erreurs, trames malformées.
import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES, FLAG_FIN, RelayError, decodeFrame, encodeCancel, encodeData, encodeErr, encodeInfo, encodeInfoReq, encodeReq,
  isValidRange, toBytes, RANGE_ERROR_CODES, SubsAssembler, encodeSubs,
} from './protocol';

describe('trames invité -> hôte', () => {
  it('REQ : aller-retour, y compris des positions au-delà de 32 bits', () => {
    const start = 2 ** 40;
    const frame = decodeFrame(encodeReq(7, start, start + 5));
    expect(frame).toEqual({ t: 'req', reqId: 7, start, end: start + 5 });
    expect(encodeReq(7, 0, 1).byteLength).toBe(21);
  });

  it('INFO? et CANCEL : aller-retour', () => {
    expect(decodeFrame(encodeInfoReq(3))).toEqual({ t: 'info_req', reqId: 3 });
    expect(decodeFrame(encodeCancel(0xffffffff))).toEqual({ t: 'cancel', reqId: 0xffffffff });
  });

  it('rejette les positions hors bornes à l’encodage', () => {
    expect(() => encodeReq(1, -1, 5)).toThrow();
    expect(() => encodeReq(1, 0, Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(() => encodeReq(-1, 0, 5)).toThrow();
  });
});

describe('trames hôte -> invité', () => {
  it('INFO : taille et type, type absent ou trop long omis', () => {
    expect(decodeFrame(encodeInfo(2, 3_000_000, 'video/mp4'))).toEqual({ t: 'info', reqId: 2, size: 3_000_000, mime: 'video/mp4' });
    expect(decodeFrame(encodeInfo(2, 42))).toEqual({ t: 'info', reqId: 2, size: 42 });
    const long = 'x/'.repeat(200);
    expect(decodeFrame(encodeInfo(2, 42, long))).toEqual({ t: 'info', reqId: 2, size: 42 });
  });

  it('DATA : octets exacts, offset et drapeau de fin', () => {
    const payload = Uint8Array.from([1, 2, 3, 250]);
    const mid = decodeFrame(encodeData(9, 1234, payload, false));
    const last = decodeFrame(encodeData(9, 1238, payload, true));
    expect(mid).toMatchObject({ t: 'data', reqId: 9, offset: 1234, fin: false });
    expect(last).toMatchObject({ t: 'data', reqId: 9, offset: 1238, fin: true });
    expect(Array.from((last as { payload: Uint8Array }).payload)).toEqual([1, 2, 3, 250]);
  });

  it('DATA : un morceau de 64 Ko passe, au-delà l’encodage refuse', () => {
    const full = new Uint8Array(CHUNK_BYTES).fill(7);
    const frame = decodeFrame(encodeData(1, 0, full, false));
    expect(frame?.t === 'data' && frame.payload.byteLength).toBe(CHUNK_BYTES);
    expect(() => encodeData(1, 0, new Uint8Array(CHUNK_BYTES + 1), false)).toThrow();
  });

  it('ERR : chaque code fait l’aller-retour, un code inconnu est refusé', () => {
    for (const code of RANGE_ERROR_CODES) {
      expect(decodeFrame(encodeErr(4, code))).toEqual({ t: 'err', reqId: 4, code });
    }
    expect(() => encodeErr(4, 'nope' as never)).toThrow();
    // Index sur le fil : les codes existants ne bougent pas, « unshareable » arrive en fin de liste.
    expect(RANGE_ERROR_CODES.slice(0, 5)).toEqual(['bad_request', 'too_large', 'out_of_range', 'busy', 'source']);
    expect(new Uint8Array(encodeErr(4, 'unshareable'))[5]).toBe(5);
  });
});

describe('décodage défensif', () => {
  it('rejette les trames vides, courtes, de type inconnu ou de mauvaise longueur', () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(Uint8Array.from([1, 0, 0, 0]))).toBeNull();
    expect(decodeFrame(Uint8Array.from([99, 0, 0, 0, 1]))).toBeNull();
    expect(decodeFrame(encodeReq(1, 0, 5).subarray(0, 20))).toBeNull();
    expect(decodeFrame(encodeErr(1, 'busy').subarray(0, 5))).toBeNull();
  });

  it('rejette un code d’erreur inconnu et un type INFO tronqué', () => {
    const err = encodeErr(1, 'busy');
    err[5] = 200;
    expect(decodeFrame(err)).toBeNull();
    const info = encodeInfo(1, 10, 'a/b');
    expect(decodeFrame(info.subarray(0, info.byteLength - 1))).toBeNull();
  });

  it('rejette un DATA trop gros et une valeur u64 supérieure à 2^53', () => {
    const big = new Uint8Array(14 + CHUNK_BYTES + 1);
    big[0] = 4;
    expect(decodeFrame(big)).toBeNull();
    const req = encodeReq(1, 0, 5);
    new DataView(req.buffer).setBigUint64(13, 2n ** 60n);
    expect(decodeFrame(req)).toBeNull();
  });

  it('drapeau de fin : bit 0 seulement', () => {
    const frame = encodeData(1, 0, Uint8Array.from([9]), true);
    expect(frame[13] & FLAG_FIN).toBe(FLAG_FIN);
  });
});

describe('utilitaires', () => {
  it('toBytes accepte ArrayBuffer et vues, refuse le texte', () => {
    const buf = Uint8Array.from([5, 6, 7]);
    expect(Array.from(toBytes(buf.buffer) ?? [])).toEqual([5, 6, 7]);
    expect(Array.from(toBytes(buf.subarray(1)) ?? [])).toEqual([6, 7]);
    expect(toBytes('texte')).toBeNull();
  });

  it('isValidRange : bornes entières, end > start', () => {
    expect(isValidRange(0, 1)).toBe(true);
    expect(isValidRange(5, 5)).toBe(false);
    expect(isValidRange(-1, 5)).toBe(false);
    expect(isValidRange(0.5, 5)).toBe(false);
  });

  it('RelayError : message fixe sans contenu libre, reprise seulement pour les erreurs transitoires', () => {
    const busy = new RelayError('busy');
    expect(busy.message).toBe('Trop de requêtes en cours côté hôte.');
    expect(busy.retryable).toBe(true);
    expect(new RelayError('timeout').retryable).toBe(true);
    expect(new RelayError('out_of_range').retryable).toBe(false);
    expect(new RelayError('cancelled').retryable).toBe(false);
    expect(new RelayError('closed').message).not.toMatch(/https?:|example/);
  });
});

describe('trames SUBS (sous-titres, hôte -> invité)', () => {
  it('un message court tient dans une trame de fin, octets exacts', () => {
    const msg = Uint8Array.from([91, 93, 0, 255]);
    const frames = encodeSubs(msg).map((f) => decodeFrame(f));
    expect(frames).toEqual([{ t: 'subs', fin: true, payload: msg }]);
  });

  it('un message long est découpé en morceaux de 64 Ko au plus, seul le dernier porte la fin', () => {
    const msg = new Uint8Array(CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const frames = encodeSubs(msg).map((f) => decodeFrame(f));
    expect(frames.map((f) => (f as { fin: boolean }).fin)).toEqual([false, false, true]);
    const sizes = frames.map((f) => (f as { payload: Uint8Array }).payload.byteLength);
    expect(sizes).toEqual([CHUNK_BYTES, CHUNK_BYTES, 10]);
  });

  it('l\'assembleur rend le message complet au dernier morceau', () => {
    const msg = new Uint8Array(CHUNK_BYTES + 7).map((_, i) => (i * 7) % 256);
    const asm = new SubsAssembler();
    let done: Uint8Array | null = null;
    for (const f of encodeSubs(msg)) {
      const frame = decodeFrame(f);
      if (frame?.t === 'subs') done = asm.push(frame) ?? done;
    }
    expect(done).toEqual(msg);
  });

  it('rejette les trames malformées : trop courte, drapeau inconnu, charge trop grande', () => {
    const ok = encodeSubs(Uint8Array.from([1, 2, 3]))[0];
    const withFlags = (flags: number) => {
      const copy = ok.slice();
      copy[5] = flags;
      return copy;
    };
    expect(decodeFrame(withFlags(0x01))).toMatchObject({ t: 'subs', fin: true });
    expect(decodeFrame(withFlags(0x02))).toBeNull();
    expect(decodeFrame(withFlags(0x80))).toBeNull();
    expect(decodeFrame(Uint8Array.from([37, 0, 0, 0, 0]))).toBeNull();
    expect(decodeFrame(Uint8Array.from([37, 0, 0, 0, 0, 0]))).toEqual({ t: 'subs', fin: false, payload: new Uint8Array(0) });
    const tooBig = new Uint8Array(6 + CHUNK_BYTES + 1);
    tooBig[0] = 37;
    expect(decodeFrame(tooBig)).toBeNull();
  });
});
