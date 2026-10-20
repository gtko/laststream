/** Langues d'audio d'une release. */
export type Lang = 'fr' | 'en' | 'es' | 'de' | 'it' | 'multi' | 'original';
export type FrVariant = 'VFF' | 'VFQ' | 'VF2' | 'TRUEFRENCH' | 'FRENCH' | 'VOSTFR' | 'SUBFRENCH';
export interface LanguageInfo {
    languages: Lang[];
    frVariant?: FrVariant;
    multi: boolean;
    subsFr: boolean;
}
/**
 * Détecte les langues, la variante française et les mentions MULTI/DUAL/sous-titres FR
 * dans un nom de release, un nom de fichier ou une description.
 *
 * Règles principales :
 * - MULTI : multi, fr et original (frVariant seulement si une variante est présente) ;
 * - DUAL : multi sans fr ;
 * - VOSTFR / SUBFRENCH : subsFr, sans fr (original ajouté si pas d'audio FR) ;
 * - aucune langue détectée : ['original'] (hypothèse VO).
 */
export declare function parseLanguages(text: string): LanguageInfo;
