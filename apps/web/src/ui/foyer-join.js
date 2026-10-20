/* Invitation au foyer (#/foyer/<jeton>), page sans compte. STUB minimal : l'écran complet (arrivée, formulaire, bienvenue,
 * états expiré / utilisé / révoqué / inconnu) le remplace. `root` : conteneur de la vue détail. */

/** Affiche la page d'invitation dans `root` (remplace son contenu). */
export function mountFoyerJoin(root, token) {
  root.replaceChildren();
  const section = document.createElement('section');
  section.className = 'auth-card';
  section.setAttribute('role', 'main');
  const title = document.createElement('h1');
  title.className = 'auth-title';
  title.tabIndex = -1;
  title.textContent = 'Invitation au foyer';
  section.append(title);
  root.append(section);
  title.focus({ preventScroll: true });
}
