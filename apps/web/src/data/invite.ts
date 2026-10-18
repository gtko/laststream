/* Liens de parrainage : lecture du code depuis l'adresse de la page (`?invite=<code>` ou `#/join/<code>`), saisie
 * manuelle (lien entier ou code seul) et fabrication du lien à partager. */

const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Code d'un lien collé ou saisi : un code seul, ou une adresse portant `?invite=` / `#/join/`. Vide si illisible. */
export function normalizeInviteCode(raw: string): string {
  const text = raw.trim();
  if (CODE_RE.test(text)) return text;
  const m = /[?&]invite=([A-Za-z0-9_-]{4,64})/.exec(text) ?? /#\/join\/([A-Za-z0-9_-]{4,64})/.exec(text);
  return m ? m[1] : '';
}

/** Code d'invitation de l'adresse courante (`search` et `hash` de la page), ou une chaîne vide. */
export function parseInviteCode(search: string, hash: string): string {
  const m = /^#\/join\/([A-Za-z0-9_-]{4,64})\/?$/.exec(hash);
  if (m) return m[1];
  const q = new URLSearchParams(search).get('invite');
  return q && CODE_RE.test(q) ? q : '';
}

/** Lien à partager : l'adresse publique de l'application suivie de `/?invite=<code>`. */
export function inviteLink(base: string, code: string): string {
  return base.replace(/\/+$/, '') + '/?invite=' + encodeURIComponent(code);
}

/** Adresse sans le code d'invitation (après l'inscription ou l'abandon), pour ne pas le garder dans la barre d'adresse. */
export function withoutInvite(search: string, hash: string): { search: string; hash: string } {
  const q = new URLSearchParams(search);
  q.delete('invite');
  const qs = q.toString();
  return { search: qs ? '?' + qs : '', hash: /^#\/join\//.test(hash) ? '' : hash };
}
