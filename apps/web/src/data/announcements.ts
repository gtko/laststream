import { call } from './userApi';

/* Annonces publiques : {base}/announcements, sans /admin. Aucune authentification : ni jeton de session, ni X-Profile-Id.
 * Le serveur ne renvoie que les annonces actives dont la fenêtre contient l'instant présent (aucune donnée sensible). */

export interface PublicAnnouncement { id: string; title: string; message: string; level: 'info' | 'warning' }

export async function fetchPublicAnnouncements(): Promise<PublicAnnouncement[]> {
  const r = await call<{ announcements?: PublicAnnouncement[] }>('/announcements', { prefix: '', anonymous: true });
  return r.announcements ?? [];
}
