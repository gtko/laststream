/* Registre des sections de la console d'administration : groupes, puis entrées (id, groupe, libellé, icône, rendu, liaison,
 * chargement). Chaque espace a son fichier ; une section se rajoute dans la liste de son espace, sans toucher au shell. */
import { communitySections } from './community.js';
import { pilotageSections } from './pilotage.js';
import { platformSections } from './platform.js';
import { servicesSections } from './services.js';
import { systemSections } from './system.js';
import { usersSections } from './users.js';

export const GROUPS = [
  { id: 'pilotage', label: 'Pilotage' },
  { id: 'users', label: 'Utilisateurs' },
  { id: 'platform', label: 'Plateforme' },
  { id: 'community', label: 'Communauté' },
  { id: 'system', label: 'Système' },
];

/** Toutes les sections, dans l'ordre de la navigation. */
export const SECTIONS = [...pilotageSections, ...usersSections, ...platformSections, ...servicesSections, ...communitySections, ...systemSections];

export const findSection = (id) => SECTIONS.find((s) => s.id === id) || null;
export const sectionsOf = (groupId) => SECTIONS.filter((s) => s.group === groupId);
