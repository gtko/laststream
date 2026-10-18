/* Chaînes de codec WebCodecs dérivées de l'extradata du conteneur (avcC, hvcC, av1C), sans rien décoder. */

export type VideoCodec = 'h264' | 'hevc' | 'av1';

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

/** AVCDecoderConfigurationRecord : octets 1 à 3 = profil, compatibilité, niveau → « avc1.PPCCLL ». */
export function avcCodecString(avcC: Uint8Array): string | null {
  if (avcC.length < 4 || avcC[0] !== 1) return null;
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

/**
 * HEVCDecoderConfigurationRecord → « hvc1.<espace><profil>.<compat inversé>.<L|H><niveau>.<contraintes> » (ISO 14496-15 annexe E).
 * L'espace de profil est A/B/C pour 1 à 3, rien pour 0 ; les octets de contrainte nuls de queue sont omis.
 */
export function hevcCodecString(hvcC: Uint8Array, sampleEntry: 'hvc1' | 'hev1' = 'hvc1'): string | null {
  if (hvcC.length < 13 || hvcC[0] !== 1) return null;
  const space = (hvcC[1] >> 6) & 3;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 31;
  let compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i += 1) { reversed = ((reversed << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const parts = [`${sampleEntry}.${['', 'A', 'B', 'C'][space]}${profile}`, reversed.toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${hvcC[12]}`];
  for (const c of constraints) parts.push(c.toString(16).toUpperCase());
  return parts.join('.');
}

/** AV1CodecConfigurationRecord → « av01.<profil>.<niveau><M|H>.<profondeur> » (AV1-ISOBMFF §5). */
export function av1CodecString(av1C: Uint8Array): string | null {
  if (av1C.length < 4 || (av1C[0] & 0x80) === 0) return null;
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 31;
  const tier = (av1C[2] >> 7) & 1;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = twelve ? 12 : high ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

export function codecStringFor(codec: VideoCodec, record: Uint8Array, sampleEntry?: string): string | null {
  if (codec === 'h264') return avcCodecString(record);
  if (codec === 'hevc') return hevcCodecString(record, sampleEntry === 'hev1' ? 'hev1' : 'hvc1');
  return av1CodecString(record);
}
