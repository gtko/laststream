/* Bouton « Amis » de la barre du haut, sur toutes les vues (accueil, recherche, pages de détail) : icône et pastille
 * (demandes reçues + messages non lus, socialStore.badge). Présent seulement sur un compte connecté, jamais sur un profil
 * enfant. La pastille est tenue à jour par la barre latérale (paintSocialBadges) à chaque changement du store. */
import { isKidProfile, isServerMode } from '../data/auth';
import { getState } from '../data/socialStore';
import { ICON } from './icons.js';

/** Social disponible : compte connecté (mode serveur) et profil non enfant. */
export const socialAvailable = () => isServerMode() && !isKidProfile();

const countText = (n) => (n > 99 ? '99+' : String(n));
const labelOf = (n) => 'Amis' + (n > 0 ? ', ' + n + ' notification' + (n > 1 ? 's' : '') : '');

function badgeHTML(n) {
  return '<span class="soc-badge" data-soc-badge' + (n > 0 ? '' : ' hidden') + '>' + countText(n) + '</span>';
}

/**
 * Bouton « Amis » ; `cls` : `icon-btn` dans la barre d’accueil, `f-round` sur les pages de détail. Chaîne vide si le social
 * n’est pas disponible (profil enfant, mode local).
 */
export function friendsButtonHTML(cls = 'icon-btn') {
  if (!socialAvailable()) return '';
  const n = getState().badge;
  // Sur les pages de détail (f-round), l’infobulle est celle du thème (data-tip) ; ailleurs, l’infobulle native.
  const tip = cls.includes('f-round') ? ' data-tip="Amis"' : ' title="Amis"';
  return '<button type="button" class="' + cls + ' soc-open" data-soc-open aria-controls="social-sidebar" aria-expanded="false"' +
    ' aria-label="' + labelOf(n) + '"' + tip + '>' + ICON.users + badgeHTML(n) + '</button>';
}

/** Met la pastille et le libellé de tous les boutons « Amis » affichés à jour. */
export function paintSocialBadges(s = getState()) {
  document.querySelectorAll('[data-soc-open]').forEach((b) => {
    const n = s.badge;
    const pastille = b.querySelector('[data-soc-badge]');
    if (pastille) {
      pastille.textContent = countText(n);
      pastille.hidden = n <= 0;
    }
    b.setAttribute('aria-label', labelOf(n));
  });
  // Pastille de l'onglet « Ensemble » de la barre du bas : même compte que le bouton Amis.
  document.querySelectorAll('[data-ens-badge]').forEach((p) => {
    p.textContent = countText(s.badge);
    p.hidden = s.badge <= 0;
  });
}
