/** Champs TMDB lus pour reconnaître un anime : identifiants de genre, langue et pays d'origine. */
export interface AnimeFacts {
  genreIds?: readonly number[];
  /** `original_language` TMDB (ISO 639-1, ex. `ja`). */
  originalLanguage?: string;
  /** `origin_country` TMDB (ISO 3166-1, ex. `JP`). */
  originCountry?: readonly string[];
}

/** TMDB n'a pas de genre « anime » : un anime est un titre classé Animation (16) d'origine japonaise (langue `ja` ou pays `JP`). */
export const isAnime = (it: AnimeFacts | null | undefined): boolean =>
  !!it && (it.genreIds ?? []).includes(16) && (it.originalLanguage === 'ja' || (it.originCountry ?? []).includes('JP'));
