import type { OfflineSource } from '../downloads/offline';
import { formatSize } from '../data/sources';
import type { SourceView } from '../sources/info';
import { appOffer, type Os } from './appDownload';

/* Lecture d'un titre téléchargé (ODY-203) : « source » synthétique pour la session du lecteur et messages d'échec. Fonctions pures, testées. */

/** Source du lecteur pour un fichier local : même forme qu'une source du sélecteur, sans lien ni réseau. */
export type OfflineView = SourceView & { local: true; container: string };

export const isOfflineView = (v: { local?: unknown } | null | undefined): v is OfflineView => v?.local === true;

export function offlineView(src: OfflineSource): OfflineView {
  const sizeBytes = src.size;
  return {
    local: true,
    container: src.container,
    index: -1,
    stream: { behaviorHints: { filename: src.filename } },
    info: null,
    group: 'other',
    resolution: 'unknown',
    quality: src.quality,
    sourceType: '',
    codec: '',
    hdr: [],
    audio: '',
    langs: [],
    hasFrench: false,
    sizeBytes,
    sizeLabel: formatSize(sizeBytes),
    bitrateKbps: null,
    bitrateLabel: '',
    durationSec: null,
    durationLabel: '',
    seeders: null,
    peers: null,
    copies: 1,
    origins: [],
    trackers: [],
    filename: src.filename,
    releaseGroup: '',
    status: 'direct',
    statusLabel: 'Téléchargé · hors ligne',
    provider: 'Téléchargement',
    playable: true,
    client: false,
    viaDevice: false,
    debridBy: [],
    notWebReady: false,
    score: 0,
    web: 'direct',
    convert: null,
    appAudio: null,
    badContainer: '',
  };
}

export type OfflineFailure = 'container' | 'video' | 'audio' | 'stalled' | 'error';

export interface OfflineFailureView {
  title: string;
  text: string;
  actions: Array<{ act: string; label: string }>;
}

/**
 * Message affiché quand un fichier téléchargé ne se lit pas. Sur le web, les formats que le navigateur ne lit pas (MKV, HEVC…)
 * renvoient vers l'app (Windows, Android) ; le streaming n'est proposé que s'il y a du réseau.
 */
export function offlineFailureView(i: { kind: OfflineFailure; reason?: string; platform: 'web' | 'android' | 'shell'; os: Os; online: boolean }): OfflineFailureView {
  const actions: OfflineFailureView['actions'] = [];
  let text: string;
  if (i.kind === 'stalled') {
    actions.push({ act: 'retry', label: 'Réessayer' });
    text = 'La lecture du fichier téléchargé est bloquée. Réessaie ; si cela se répète, supprime-le puis retélécharge-le depuis Téléchargements.';
  } else if (i.kind === 'error') {
    text = 'Le fichier téléchargé ne se lit pas' + (i.reason ? ' (' + i.reason + ')' : '') + '. Supprime-le puis retélécharge-le depuis Téléchargements.';
  } else if (i.platform === 'web') {
    const what = i.kind === 'container' ? (i.reason ?? 'Ce format n’est pas lu par le navigateur.') : i.kind === 'video' ? 'La vidéo de ce fichier (HEVC, AV1…) n’est pas lue par ce navigateur.' : 'Le son de ce fichier n’est pas lu par ce navigateur.';
    const offer = appOffer(i.os);
    text = what + ' ' + offer.text;
    if (offer.link) actions.push({ act: 'app-download', label: offer.link.label });
  } else {
    text = 'Le lecteur n’a pas pu ouvrir le fichier téléchargé' + (i.reason ? ' (' + i.reason + ')' : '') + '.';
  }
  if (i.online) actions.push({ act: 'stream', label: 'Lire en streaming' });
  else text += ' Aucune connexion : le streaming n’est pas disponible.';
  actions.push({ act: 'close', label: 'Fermer' });
  return { title: 'Lecture hors ligne impossible', text, actions };
}
