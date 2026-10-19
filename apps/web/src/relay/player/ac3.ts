import type { AudioSample } from 'mediabunny';

/**
 * Chargeur du décodeur AC-3 / E-AC-3 (@mediabunny/ac3, wasm embarqué). Import dynamique : le code ne
 * sort du bundle principal que si un fichier en a besoin. Aucun COOP/COEP requis (pas de SharedArrayBuffer).
 * Lève si le chargement échoue ; l'appelant se replie alors sur la vidéo seule.
 */
export type Ac3Loader = () => Promise<void>;

export const loadAc3Decoder: Ac3Loader = async () => {
  const { registerAc3Decoder } = await import('@mediabunny/ac3');
  registerAc3Decoder();
};

export function isAc3Codec(codec: string | undefined | null): boolean {
  return codec === 'ac3' || codec === 'eac3';
}

/**
 * Adaptateur AudioSample (mediabunny, timestamps en secondes) -> AudioData (WebCodecs, timestamps en µs),
 * ce que `onAudioData` du lecteur attend. L'échantillon est fermé : l'AudioData en possède une copie.
 */
export function sampleToAudioData(sample: Pick<AudioSample, 'toAudioData' | 'close'>): AudioData {
  try {
    return sample.toAudioData();
  } finally {
    sample.close();
  }
}
