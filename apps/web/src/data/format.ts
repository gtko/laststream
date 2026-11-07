/** Deux chiffres avec zéro initial : 7 → « 07 ». Pour les dates et timecodes locaux. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Échappement HTML pour le texte et les attributs (guillemets compris) ; null et undefined donnent ''. Module pur, sans dépendance. */
export const escapeHtml = (v: unknown): string => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ENTITIES[c]);
