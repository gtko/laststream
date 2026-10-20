import { isAndroidApp, PUBLIC_BASE } from './config';
import { getServedOrigin } from './serverMode';

/**
 * Adresse sur laquelle les liens (invitations, foyer) s'ouvrent : la page servie par lastAddon, sinon l'origine web,
 * sinon le serveur Laststream. Dans la couche données : l'interface de l'invitation au foyer la lit sans charger le DOM.
 */
export function shareBase(): string {
  const served = getServedOrigin();
  if (served) return served;
  if (!isAndroidApp() && /^https?:$/.test(location.protocol)) return location.origin;
  return PUBLIC_BASE;
}
