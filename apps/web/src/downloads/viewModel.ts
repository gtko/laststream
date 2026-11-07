/* Présentation des téléchargements (ODY-204) : fonctions pures, sans I/O ni DOM. Les textes sont en français et ne contiennent
 * jamais d'URL : seul le code d'erreur est traduit. */
import type { Availability } from './service';
import type { DownloadErrorCode, DownloadItem, SpaceInfo } from './types';

export type ButtonState = 'available' | 'pending' | 'running' | 'paused' | 'done' | 'error' | 'unavailable';

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Taille lisible en français, base 1024 : « 1,4 Go », « 820 Mo ». */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 o';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} o`;
  // Arrondi qui atteindrait 1024 : on passe à l'unité suivante (« 1 Go », pas « 1024 Mo »).
  if (value >= 1023.5 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100
    ? String(Math.round(value))
    : (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${text} ${UNITS[unit]}`;
}

/** Pourcentage d'avancement (0 à 100), null quand la taille totale est inconnue. Un téléchargement terminé vaut 100. */
export function itemPercent(item: DownloadItem): number | null {
  if (item.state === 'done') return 100;
  if (!item.bytesTotal || item.bytesTotal <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((item.bytesDone / item.bytesTotal) * 100)));
}

/** Jauge d'espace : pourcentage, libellé et niveau (`warn` à 90 %, `full` à 100 %). */
export function gauge(s: SpaceInfo): { percent: number; label: string; level: 'ok' | 'warn' | 'full' } {
  const percent = s.ratio === null ? 0 : Math.min(100, Math.max(0, Math.round(s.ratio * 100)));
  const label = s.limit === null ? `${formatBytes(s.used)} utilisés` : `${formatBytes(s.used)} sur ${formatBytes(s.limit)}`;
  const level = s.full ? 'full' : s.warn ? 'warn' : 'ok';
  return { percent, label, level };
}

const ERRORS: Record<DownloadErrorCode, string> = {
  link_expired: 'Le lien a expiré. Le téléchargement reprendra avec un lien neuf.',
  resolve_failed: 'Impossible d’obtenir le fichier pour le moment.',
  account: 'Ton compte débrideur est indisponible. Vérifie-le dans les réglages.',
  content: 'Ce flux ne peut pas être téléchargé.',
  network: 'Connexion interrompue. Le téléchargement reprendra quand le réseau reviendra.',
  range_mismatch: 'Le fichier a changé pendant le téléchargement. Relance-le.',
  quota_exceeded: 'Limite d’espace atteinte. Augmente la limite ou supprime des téléchargements.',
  store_full: 'Le stockage de l’appareil est plein.',
  store_failed: 'Impossible d’écrire le fichier sur l’appareil.',
  store_denied: 'Windows refuse l’écriture du fichier (antivirus, droits ou fichier ouvert ailleurs). Autorise le dossier de téléchargement dans ton antivirus, puis réessaie.',
  store_folder: 'Le dossier de téléchargement est introuvable ou protégé en écriture. Vérifie qu’il existe et qu’il est accessible, puis réessaie.',
  store_timeout: 'Le disque n’a pas répondu à temps (disque lent ou antivirus). Réessaie : le téléchargement reprend là où il s’est arrêté.',
  cancelled: 'Téléchargement annulé.',
};

/** Message français pour un code d'erreur. Jamais d'URL. */
export function errorMessage(code: DownloadErrorCode): string {
  return ERRORS[code] ?? 'Le téléchargement a échoué.';
}

/** Ce qu'affiche le bouton de la fiche : état, libellé, avancement et raison éventuelle. */
export function buttonState(item: DownloadItem | undefined, avail: Availability): { state: ButtonState; label: string; percent: number | null; reason?: string } {
  if (!avail.ok) return { state: 'unavailable', label: 'Indisponible', percent: null, reason: avail.reason };
  if (!item) return { state: 'available', label: 'Télécharger', percent: null };
  const percent = itemPercent(item);
  const reason = item.error ? errorMessage(item.error.code) : undefined;
  switch (item.state) {
    case 'pending':
      return { state: 'pending', label: 'En attente', percent };
    case 'running':
      return { state: 'running', label: percent === null ? 'Téléchargement…' : `Téléchargement ${percent} %`, percent };
    case 'paused':
      return { state: 'paused', label: 'En pause', percent, ...(reason ? { reason } : {}) };
    case 'done':
      return { state: 'done', label: 'Téléchargé', percent: 100 };
    case 'error':
      return { state: 'error', label: 'Échec', percent, reason: reason ?? errorMessage('resolve_failed') };
  }
}

/** Sous-titre d'un téléchargement : « S1 É3 · 1,2 Go sur 2,4 Go », « 820 Mo », ou « environ 2 Go » avant le premier octet. */
export function itemSubtitle(item: DownloadItem): string {
  const episode = item.season !== undefined && item.episode !== undefined ? `S${item.season} É${item.episode}` : '';
  let size = '';
  if (item.bytesTotal) size = `${formatBytes(item.bytesDone)} sur ${formatBytes(item.bytesTotal)}`;
  else if (item.bytesDone > 0) size = formatBytes(item.bytesDone);
  else if (item.estimatedSize) size = `environ ${formatBytes(item.estimatedSize)}`;
  return [episode, size].filter((part) => part !== '').join(' · ');
}
