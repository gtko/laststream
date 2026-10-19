/**
 * Forme canonique d'un pseudo, pour comparer sans se laisser tromper : deux pseudos qui se ressemblent à l'écran ont la même
 * forme canonique. Sert à l'unicité des pseudos du salon, au refus de se faire passer pour l'hôte ou un membre, et au bannissement
 * d'un pseudo. Le pseudo affiché reste celui enregistré (NFC) ; seule la comparaison passe par la forme canonique.
 *
 * Étapes : NFKD (compatibilité : pleine chasse, ligatures, exposants), retrait des diacritiques, minuscules (casefold), repli
 * des lettres confondables grec/cyrillique vers le latin, espaces réduits. Module portable, sans dépendance.
 */

/** Lettres grecques et cyrilliques minuscules courantes qui ressemblent à une lettre latine. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // cyrillique
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  ь: 'b', ѵ: 'v',
  // grec
  α: 'a', β: 'b', γ: 'y', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ς: 's', η: 'n', μ: 'u',
  // latin
  ı: 'i', ß: 'ss', ø: 'o', đ: 'd', ł: 'l', æ: 'ae', œ: 'oe',
};

/** Forme canonique d'un pseudo (voir l'en-tête du module). */
export function canonicalName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  for (const ch of base) out += CONFUSABLES[ch] ?? ch;
  return out;
}
