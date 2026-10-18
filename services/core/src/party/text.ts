/** Contrôles C0/C1 (hors tabulation et retour ligne), séparateurs Unicode, zéro-largeur et contrôles bidirectionnels. */
function isInvisible(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

/** Texte sans caractères invisibles ni de contrôle (les espaces sont conservés). */
export function stripInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!isInvisible(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}
