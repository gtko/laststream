/** Deux chiffres avec zéro initial : 7 → « 07 ». Pour les dates et timecodes locaux. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');
