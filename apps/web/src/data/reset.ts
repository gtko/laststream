/* Réinitialisation du mot de passe par lien (généré par le propriétaire) : `#/reset/<jeton>` ou `/reset-password?token=<jeton>`. */

import { t as tr } from '../i18n';
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export function resetTokenFromLocation(search: string, hash: string, pathname = ''): string {
  const h = /^#\/reset\/([^/?#]+)/.exec(hash || '');
  if (h) {
    let raw = h[1];
    try { raw = decodeURIComponent(raw); } catch { return ''; }
    return TOKEN.test(raw) ? raw : '';
  }
  if (/\/reset-password\/?$/.test(pathname)) {
    const t = new URLSearchParams(search || '').get('token') || '';
    return TOKEN.test(t) ? t : '';
  }
  return '';
}

const MIN_PASSWORD = 8;

/** Message de validation du nouveau mot de passe, ou '' s'il convient. */
export function passwordIssue(password: string, confirm: string): string {
  if (password.length < MIN_PASSWORD) return tr('Le mot de passe doit faire au moins {MIN_PASSWORD} caractères.', { MIN_PASSWORD });
  if (password !== confirm) return tr('Les deux mots de passe ne sont pas identiques.');
  return '';
}
