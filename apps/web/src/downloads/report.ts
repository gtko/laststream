/* Journal des échecs de téléchargement vers Sentry (ODY-240). Seuls la plateforme, le code d'erreur, la cause brute du magasin
 * (un mot : `io`, `store_full`, `timeout`…) et les tailles partent : jamais de lien, de chemin ni de titre. Sans DSN au build,
 * Sentry n'a pas de client et l'appel ne fait rien. */
import { captureMessage } from '@sentry/browser';

type LogData = Record<string, string | number> | undefined;

/** Branche sur `DownloadManager.onLog` : ne retient que l'événement `failed`, sans jamais lever. */
export function reportDownloadEvent(platform: string, event: string, data: LogData): void {
  // `quota_exceeded` est une limite choisie par l'utilisateur, pas une panne.
  if (event !== 'failed' || !data || data.code === 'quota_exceeded') return;
  try {
    const code = String(data.code ?? 'unknown');
    const detail = typeof data.detail === 'string' ? data.detail : 'none';
    captureMessage('download_failed', {
      level: 'warning',
      tags: { appPlatform: platform, code, detail },
      extra: { bytesDone: data.bytes, bytesTotal: data.total },
      fingerprint: ['download_failed', platform, code, detail],
    });
  } catch {
    /* le journal ne doit jamais casser un téléchargement */
  }
}
